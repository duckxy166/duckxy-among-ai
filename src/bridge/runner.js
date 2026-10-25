// A match in the real Among Us. Every seat plays through its own game copy (AUBridge) and the game
// itself owns roles, movement, kills and votes. Brains, memories, prompts and the event log are the
// simulator's (src/match/runner.js), so the viewer and anything built on events.jsonl work as they are.
//
// Differences from the simulator: time does not stop while a model thinks, so every seat decides on
// its own whenever something wakes it up (arrived, task done, saw a body...). At a meeting the seats
// speak in turns through the game chat, then each one votes once its own copy opens voting.

import fs from 'node:fs';
import path from 'node:path';
import { Agent, FatalSeatError } from '../agents/agent.js';
import { systemPrompt } from '../agents/prompts.js';
import { loadLongTerm, appendLongTerm } from '../agents/memory.js';
import { BOARD, ROOMS, EDGES, VENT_GROUPS, COLORS } from '../engine/map.js';
import { DEFAULT_RULES } from '../engine/game.js';
import { say, clock } from '../i18n.js';
import { BridgeSeat, sleep, until } from './seat.js';

// Lobby options sent with `configure` (AUBridge names). Discussion and voting are long because the
// models speak in turns through the real chat.
export const DEFAULT_LOBBY = {
  killCooldown: 25, discussion: 30, voting: 150, commonTasks: 1, shortTasks: 2, longTasks: 1,
  confirmEjects: true, emergencyMeetings: 1, anonymousVotes: false,
};

const CHAT_MAX = 100;
const quote = (s, n = 160) => (s ? `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"` : '(quiet)');

// The game refuses longer messages; cut at a word boundary when there is one.
export function fitChat(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= CHAT_MAX) return t;
  const cut = t.slice(0, CHAT_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > CHAT_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
}

// clients: Map seatId -> BridgeClient. The first seat's copy is the lobby host, and every copy must
// already be in that lobby (see launcher.js).
export async function runBridgeMatch({
  config, seats, providers, clients, matchId, dir, memoryDir, publish = () => {}, log = () => {},
}) {
  const bridge = config.bridge ?? {};
  const lobby = { ...DEFAULT_LOBBY, ...(bridge.lobby ?? {}) };
  // The game needs 7 players for 2 impostors and 9 for 3; ask for more and `start` is refused.
  const allowed = seats.length >= 9 ? 3 : seats.length >= 7 ? 2 : 1;
  const impostors = Math.min(config.rules?.impostors ?? (seats.length <= 6 ? 1 : 2), allowed);
  const rules = {
    ...DEFAULT_RULES, ...config.rules, impostors,
    confirmEjects: lobby.confirmEjects, emergenciesPerPlayer: lobby.emergencyMeetings, killCooldown: lobby.killCooldown,
  };
  const maxMs = (bridge.maxMinutes ?? 20) * 60000;

  fs.mkdirSync(dir, { recursive: true });
  const eventsFd = fs.openSync(path.join(dir, 'events.jsonl'), 'w');
  const promptsFd = config.logPrompts ? fs.openSync(path.join(dir, 'prompts.jsonl'), 'w') : null;
  const events = [];
  let t0 = 0;
  const now = () => (t0 ? (Date.now() - t0) / 1000 : 0);
  const emit = (e) => {
    const ev = { seq: events.length, t: Math.round(now() * 10) / 10, ...e };
    fs.writeSync(eventsFd, `${JSON.stringify(ev)}\n`);
    events.push(ev);
    publish(ev);
    return ev;
  };
  const record = (rec) => promptsFd !== null && fs.writeSync(promptsFd, `${JSON.stringify(rec)}\n`);
  const warn = (text) => log(`  ! ${text}`);

  let resolveOver;
  const overP = new Promise((resolve) => { resolveOver = resolve; });
  let fatal = null;
  let winner = null;
  let reason = null;
  let meetingTask = null;
  let meetingCount = 0;
  const bodyRooms = new Map();

  const match = {
    lang: config.language,
    rules: { followSeconds: rules.followSeconds, emergencyMeetings: lobby.emergencyMeetings },
    meeting: null,
    over: false,
    sabotage: null,
    knownDead: new Set(),
    now, emit, warn,
    onBridgeEvent: (s, e) => {
      if (e.type === 'meeting_started' && !match.meeting && !match.over) {
        meetingTask = runMeeting(e).catch((err) => fail(err));
      } else if (e.type === 'meeting_ended') {
        match.meeting?.resolveEnded(e);
      } else if (e.type === 'game_ended') {
        finish(e.winner === 'impostors' ? 'impostor' : e.winner === 'crew' ? 'crew' : 'none', e.reason);
      }
    },
    onKill: (s, victimName, room) => {
      const victim = byName.get(victimName);
      bodyRooms.set(victimName, room);
      if (!victim) return;
      victim.alive = false;
      const witnesses = list.filter((o) => o.alive && o !== s && o.seen.has(s.name)).map((o) => o.id);
      emit({ type: 'kill', killer: s.id, victim: victim.id, room, witnesses });
    },
    onDeath: (s) => {
      // A dead crewmate keeps doing tasks (it still helps the crew win), driven by AUBridge's autopilot.
      if (s.role === 'crew' && bridge.ghostTasks !== false) s.client.request('autopilot', { on: true }).catch(() => {});
    },
    // Only from the impostor's own `sabotage` act, which knows who did it. Every copy then reports the
    // fix; the first one closes it.
    onSabotage: (s, type) => {
      match.sabotage = type;
      emit({ type: 'sabotage', kind: type, by: s.id, deadline: null });
    },
    onSabotageFixed: (type) => {
      if (match.sabotage !== type) return;
      match.sabotage = null;
      emit({ type: 'sabotage_fixed', kind: type, by: [] });
    },
    onTaskDone: (s) => {
      s.refresh().then((st) => {
        if (st?.taskBar !== undefined) emit({ type: 'taskbar', done: Math.round(st.taskBar * 100), total: 100 });
      }).catch(() => {});
    },
  };

  const list = seats.map((seat) => new BridgeSeat({ seat, client: clients.get(seat.id), match }));
  const byName = new Map(list.map((s) => [s.name, s]));
  const agents = new Map();
  const host = list[0];

  // game_over itself is written by the main flow, after a meeting in progress has written its result:
  // the game can end on the vote, and the bridge sends meeting_ended and game_ended together.
  function finish(w, why) {
    if (match.over) return;
    match.over = true;
    winner = w;
    reason = why;
    for (const s of list) s.wake(null);
    resolveOver();
  }

  function fail(err) {
    if (!fatal) fatal = err;
    match.over = true;
    for (const s of list) s.wake(null);
    resolveOver();
  }

  // ---------------------------------------------------------------- one seat's decisions

  async function seatLoop(s) {
    const agent = agents.get(s.id);
    while (!match.over && !s.stopped) {
      await s.nextNeed();
      if (match.over || s.stopped) break;
      const why = s.needs;
      s.needs = null;
      if (!why || match.meeting || !s.acts) continue;
      s.deciding = true;
      if (s.plan) s.plan.stale = true; // the body keeps doing it until the new action is sent
      try {
        const st = await s.refresh();
        if (!st || st.phase !== 'tasks' || !s.acts || match.meeting) continue;
        const view = s.view(why);
        if (!view.legal.length) continue; // a ghost impostor with no sabotage ready
        emit({ type: 'thinking', players: [s.id] });
        const r = await agent.decideRoam(view);
        emit({ type: 'decision', p: s.id, reason: why, thought: r.thought, action: r.action, raw: r.raw, note: r.note, error: r.error, ms: r.ms, model: r.model });
        if (match.meeting || match.over || !s.acts) continue;
        await s.execute(r.action);
      } catch (e) {
        if (e instanceof FatalSeatError) { fail(e); break; }
        warn(`${s.name}: ${e.message}`);
        await sleep(1000);
        s.wake('idle');
      } finally {
        s.deciding = false;
      }
    }
  }

  // ---------------------------------------------------------------- meetings

  async function runMeeting(e) {
    const m = { n: ++meetingCount, t: now(), ended: null };
    const endedP = new Promise((resolve) => {
      m.resolveEnded = (x) => { if (!m.ended) { m.ended = x; resolve(x); } };
    });
    match.meeting = m;
    for (const s of list) s.resetForMeeting();
    await sleep(1500); // the meeting screen opens
    await Promise.all(list.map((s) => s.refresh().catch(() => null)));

    const alive = list.filter((s) => s.alive);
    const caller = byName.get(e.caller) ?? null;
    const body = e.body ? byName.get(e.body) ?? null : null;
    const newlyDead = list.filter((s) => !s.alive && !match.knownDead.has(s.name));
    newlyDead.forEach((s) => match.knownDead.add(s.name));
    const room = body ? bodyRooms.get(body.name) ?? null : 'Cafeteria';
    const info = {
      n: m.n, t: Math.round(m.t), reason: body ? 'body' : 'button', room: room ?? '?',
      callerName: e.caller ?? '?', bodyName: body?.name ?? null,
      alive: alive.map((s) => s.name), dead: [...match.knownDead],
    };
    log(`[${clock(m.t)}] meeting #${m.n} called by ${info.callerName}`);
    emit({
      type: 'meeting_start', n: m.n, caller: caller?.id ?? null, body: body?.id ?? null, room, reason: info.reason,
      newlyDead: newlyDead.map((s) => s.id), dead: [...match.knownDead].map((n) => byName.get(n)?.id).filter(Boolean),
    });
    for (const s of alive) {
      if (body) s.note(m.t, 'meeting', 'meeting_body', { caller: info.callerName, body: body.name, room: info.room });
      else s.note(m.t, 'meeting', 'meeting_button', { caller: info.callerName });
      if (info.dead.length) s.note(m.t, 'meeting', 'dead_now', { list: info.dead.join(', ') });
    }

    // Discussion: in turns, starting with the caller, through the game chat (chat also works while voting).
    const first = Math.max(0, alive.indexOf(caller));
    const order = [...alive.slice(first), ...alive.slice(0, first)];
    const transcript = [];
    for (let round = 1; round <= config.discussionRounds; round++) {
      for (const s of order) {
        if (m.ended || match.over) break;
        emit({ type: 'thinking', players: [s.id] });
        const r = await agents.get(s.id).speak(info, transcript, round, config.discussionRounds);
        const text = fitChat(r.chat);
        let sendError = null;
        if (text && !m.ended) {
          const a = await s.client.act({ do: 'chat', text });
          if (!a.ok) sendError = `chat: ${a.error}`;
        }
        transcript.push({ name: s.name, text });
        emit({ type: 'chat', p: s.id, round, text, thought: r.thought, suspect: r.suspect, error: r.error ?? sendError, ms: r.ms, model: r.model });
      }
    }

    // Votes: every copy runs its own meeting timer, so each seat waits for its own copy to open voting.
    const options = alive.map((s) => s.name);
    const voteBy = Date.now() + (lobby.discussion + lobby.voting + 20) * 1000;
    emit({ type: 'thinking', players: alive.map((s) => s.id), voting: true });
    const ballots = await Promise.all(alive.map(async (s) => {
      const v = await agents.get(s.id).vote(info, transcript, options);
      let res = null;
      while (!m.ended && !match.over && Date.now() < voteBy) {
        const st = await s.refresh().catch(() => null);
        if (st?.phase === 'voting') {
          res = await s.client.act({ do: 'vote', target: v.vote });
          if (res.ok || !/not open/i.test(res.error ?? '')) break;
        } else if (st && st.phase !== 'meeting') {
          break; // the copy already shows the result
        }
        await sleep(500);
      }
      return { s, v, res };
    }));
    const tally = {};
    let skip = 0;
    for (const { s, v, res } of ballots) {
      const target = v.vote === 'skip' ? 'skip' : byName.get(v.vote)?.id ?? 'skip';
      if (target === 'skip') skip++; else tally[target] = (tally[target] || 0) + 1;
      emit({ type: 'vote', p: s.id, target, thought: v.thought, error: v.error ?? (res && !res.ok ? `vote: ${res.error}` : undefined), ms: v.ms, model: v.model });
    }

    const giveUp = new Promise((resolve) => setTimeout(resolve, (lobby.voting + 30) * 1000).unref());
    await Promise.race([endedP, overP, giveUp]);
    const ended = m.ended ?? { ejected: null, tie: false };
    if (!m.ended) warn(`meeting #${m.n}: no meeting_ended from the game`);
    const out = ended.ejected ? byName.get(ended.ejected) ?? null : null;
    if (out) {
      out.alive = false;
      match.knownDead.add(out.name);
    }
    const why = out ? null : ended.tie ? 'tie' : 'skip';
    const wasImpostor = out ? out.role === 'impostor' : null;
    emit({ type: 'vote_result', ejected: out?.id ?? null, tally, skip, why, wasImpostor, reveal: lobby.confirmEjects });
    for (const s of alive) {
      if (!s.alive) continue;
      if (out) {
        const role = lobby.confirmEjects ? say(match.lang, wasImpostor ? 'ejected_imp' : 'ejected_crew') : '';
        s.note(now(), 'meeting_result', 'ejected', { name: out.name, role });
      } else {
        s.note(now(), 'meeting_result', 'no_eject', { why: say(match.lang, why === 'tie' ? 'why_tie' : 'why_skip') });
      }
    }

    // The public record every player remembers, as in the simulator.
    const votedFor = new Map(ballots.map(({ s, v }) => [s.name, v.vote]));
    const outcome = out
      ? `${out.name} was ejected${lobby.confirmEjects ? (wasImpostor ? ' (an Impostor)' : ' (NOT an Impostor)') : ''}`
      : `nobody was ejected (${why})`;
    const whyText = info.reason === 'body' ? `${info.callerName} reported ${info.bodyName}'s body in ${info.room}` : `${info.callerName} pressed the button`;
    const text = [
      `Meeting #${m.n} [${clock(info.t)}]: ${whyText}. Dead by then: ${info.dead.join(', ') || 'nobody'}.`,
      ...transcript.map((c) => `  ${c.name}: ${quote(c.text)}`),
      `  Votes: ${alive.map((s) => `${s.name}→${votedFor.get(s.name)}`).join(', ')}`,
      `  Result: ${outcome}.`,
    ].join('\n');
    for (const a of agents.values()) a.memory.addMeeting(text);
    log(`  ${outcome}`);

    // Back on the ship once every living copy can move again (the ejection screen takes a while).
    await until(async () => {
      if (match.over) return true;
      const sts = await Promise.all(list.filter((s) => s.alive).map((s) => s.refresh()));
      return sts.every((st) => st?.phase === 'tasks' && st.canMove);
    }, 60000, 1000);
    match.meeting = null;
    emit({ type: 'meeting_end' });
    if (match.over) return;
    for (const s of list) {
      if (s.alive) s.wake('meeting_over');
      else if (s.role === 'crew') match.onDeath(s);
    }
  }

  // ---------------------------------------------------------------- the match

  const stopAll = () => { for (const s of list) s.stop(); };

  try {
    const lobbyState = await host.client.state();
    const players = lobbyState.players ?? [];
    if (lobbyState.stage !== 'lobby' || players.length < seats.length) {
      throw new Error(`the host copy must be in a lobby with all ${seats.length} players (stage=${lobbyState.stage}, players=${players.length})`);
    }
    await Promise.all(list.map((s) => s.syncEvents()));
    list.forEach((s) => s.pump());

    const conf = { impostors, ...lobby };
    const configured = await host.client.call('configure', conf);
    // `configure` turns off the special roles it knows; one a newer build adds would still be on.
    if (configured.options?.anyRoles) warn('the lobby still has special roles on, and the brains cannot use their buttons');
    await sleep(1000);
    await host.client.call('start');
    log('Started; waiting for every copy to finish the intro...');
    const moving = await until(async () => {
      const sts = await Promise.all(list.map((s) => s.refresh()));
      return sts.every((st) => st?.phase === 'tasks' && st.canMove);
    }, 120000, 1000);
    if (!moving) throw new Error('the game did not start on every copy within 120s');
    t0 = Date.now();

    for (const s of list) {
      const me = s.state.me;
      if (me.name !== s.name) throw new Error(`copy ${s.client.id} plays as "${me.name}", expected "${s.name}"`);
      s.role = me.role === 'impostor' ? 'impostor' : 'crew';
      s.partners = me.partner ? [me.partner] : [];
    }

    const roster = seats.map((s) => ({ id: s.id, name: s.name, color: s.color, label: s.label }));
    const impostorCount = list.filter((s) => s.role === 'impostor').length;
    for (const s of list) {
      const system = systemPrompt({
        me: s.seat, role: s.role, partners: s.partners, roster, rules, impostorCount,
        language: config.language, persona: s.seat.persona, revealModels: config.revealModels, realGame: true,
        longTerm: config.persistentMemory ? loadLongTerm(memoryDir, s.id) : '',
      });
      record({ seat: s.id, kind: 'system', system });
      const agent = new Agent({
        seat: s.seat, role: s.role, partners: s.partners, provider: providers.get(s.id), system,
        onCall: (rec) => record({ t: now(), ...rec }),
      });
      agents.set(s.id, agent);
    }

    emit({
      type: 'match_start', matchId, seed: config.seed, language: config.language, body: 'among-us',
      board: BOARD, rooms: ROOMS, edges: EDGES, vents: VENT_GROUPS, rules,
      players: seats.map((seat) => ({
        id: seat.id, name: seat.name, color: seat.color, hex: COLORS[seat.color], label: seat.label,
        provider: seat.provider, model: seat.model, role: byName.get(seat.name).role,
      })),
    });
    emit({ type: 'roam_start' });
    emit({ type: 'taskbar', done: 0, total: 100 });
    for (const s of list) s.attach(agents.get(s.id));
    log(`Roles: ${list.map((s) => `${s.name}=${s.role}`).join(', ')}`);

    list.forEach((s) => s.ticker());
    const loops = list.map((s) => seatLoop(s));
    for (const s of list) s.wake('start');

    const timer = setTimeout(() => finish('none', 'timeout'), maxMs);
    await overP;
    clearTimeout(timer);
    if (meetingTask) await meetingTask;
    stopAll();
    await Promise.all(loops);
    if (fatal) throw fatal;
    emit({ type: 'game_over', winner, reason, roles: Object.fromEntries(list.map((s) => [s.id, s.role])) });

    log(`[${clock(now())}] game over: ${winner} (${reason})`);
    if (config.persistentMemory) await reflectAll();
  } catch (e) {
    emit({ type: 'match_error', error: String(e?.message ?? e) });
    throw e;
  } finally {
    stopAll();
    emit({ type: 'stats', seats: Object.fromEntries([...agents].map(([id, a]) => [id, a.stats])) });
    fs.closeSync(eventsFd);
    if (promptsFd !== null) fs.closeSync(promptsFd);
  }

  async function reflectAll() {
    const roles = list.map((s) => `${s.name}=${s.role}`).join(', ');
    const headline = winner === 'none'
      ? `Nobody won (${reason}).`
      : `${winner === 'crew' ? 'The crewmates' : 'The impostors'} won (${reason}).`;
    const results = await Promise.all(list.map((s) => agents.get(s.id).reflect({ headline, roles, myRole: s.role, survived: s.alive })));
    const date = new Date().toISOString().slice(0, 10);
    list.forEach((s, i) => {
      const r = results[i];
      emit({ type: 'reflection', p: s.id, lesson: r.lesson, thought: r.thought, error: r.error });
      if (!r.lesson) return;
      const won = winner === s.role;
      appendLongTerm(memoryDir, s.seat, { date, matchId, role: s.role, result: won ? 'won' : 'lost', lesson: r.lesson });
    });
  }

  return { winner, reason, t: now(), dir, events, agents };
}
