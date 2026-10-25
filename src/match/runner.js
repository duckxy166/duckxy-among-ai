// Drives one match: the engine moves bodies, agents decide at decision points, and every event is
// appended to matches/<id>/events.jsonl (and streamed to the viewer). Game time stands still
// while models think, so a slow model is never punished for latency.

import fs from 'node:fs';
import path from 'node:path';
import { Game } from '../engine/game.js';
import { BOARD, ROOMS, EDGES, VENT_GROUPS, COLORS } from '../engine/map.js';
import { Agent } from '../agents/agent.js';
import { systemPrompt } from '../agents/prompts.js';
import { loadLongTerm, appendLongTerm } from '../agents/memory.js';
import { createRng } from '../rng.js';
import { clock } from '../i18n.js';

const quote = (s, n = 160) => (s ? `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"` : '(quiet)');

export async function runMatch({ config, seats, providers, matchId, dir, memoryDir, publish = () => {}, log = () => {} }) {
  const rng = createRng(config.seed);
  const game = new Game({ seats, rng, rules: config.rules, language: config.language });
  fs.mkdirSync(dir, { recursive: true });
  const eventsFd = fs.openSync(path.join(dir, 'events.jsonl'), 'w');
  const promptsFd = config.logPrompts ? fs.openSync(path.join(dir, 'prompts.jsonl'), 'w') : null;
  const events = [];
  const emit = (e) => {
    const ev = { seq: events.length, ...e };
    fs.writeSync(eventsFd, `${JSON.stringify(ev)}\n`);
    events.push(ev);
    publish(ev);
    return ev;
  };
  const record = (rec) => promptsFd !== null && fs.writeSync(promptsFd, `${JSON.stringify(rec)}\n`);

  const roster = seats.map((s) => ({ id: s.id, name: s.name, color: s.color, label: s.label }));
  const impostorCount = game.players.filter((p) => p.role === 'impostor').length;
  const agents = new Map();
  for (const seat of seats) {
    const p = game.byId(seat.id);
    const partners = p.role === 'impostor'
      ? game.players.filter((o) => o.role === 'impostor' && o !== p).map((o) => o.name) : [];
    const system = systemPrompt({
      me: seat, role: p.role, partners, roster, rules: game.rules, impostorCount,
      language: config.language, persona: seat.persona, revealModels: config.revealModels,
      longTerm: config.persistentMemory ? loadLongTerm(memoryDir, seat.id) : '',
    });
    record({ seat: seat.id, kind: 'system', system });
    agents.set(seat.id, new Agent({
      seat, role: p.role, partners, provider: providers.get(seat.id), system,
      onCall: (rec) => record({ t: game.t, ...rec }),
    }));
  }

  emit({
    type: 'match_start', t: 0, matchId, seed: config.seed, language: config.language,
    board: BOARD, rooms: ROOMS, edges: EDGES, vents: VENT_GROUPS, rules: game.rules,
    players: seats.map((s) => ({
      id: s.id, name: s.name, color: s.color, hex: COLORS[s.color], label: s.label,
      provider: s.provider, model: s.model, role: game.byId(s.id).role,
    })),
  });

  // Engine events go to the log; `obs` lines go only to the memory of the player who saw them.
  const flush = () => {
    for (const e of game.drain()) {
      if (e.type !== 'obs') { emit(e); continue; }
      agents.get(e.p).memory.observe(e.t, e.kind, e.text, e.data);
      emit({ type: 'memory', t: e.t, p: e.p, kind: e.kind, text: e.text });
    }
  };

  const runMeeting = async () => {
    flush();
    const m = game.meeting;
    const alive = game.living();
    const info = {
      n: m.n, t: game.t, reason: m.reason, room: m.room,
      callerName: game.byId(m.caller).name,
      bodyName: m.body ? game.byId(m.body).name : null,
      alive: alive.map((p) => p.name),
      dead: [...game.publicDead].map((id) => game.byId(id).name),
    };
    log(`[${clock(game.t)}] meeting #${m.n} called by ${info.callerName}`);
    const first = Math.max(0, alive.findIndex((p) => p.id === m.caller));
    const order = [...alive.slice(first), ...alive.slice(0, first)];
    const transcript = [];
    for (let round = 1; round <= config.discussionRounds; round++) {
      for (const p of order) {
        emit({ type: 'thinking', t: game.t, players: [p.id] });
        const r = await agents.get(p.id).speak(info, transcript, round, config.discussionRounds);
        transcript.push({ name: p.name, text: r.chat });
        emit({ type: 'chat', t: game.t, p: p.id, round, text: r.chat, thought: r.thought, suspect: r.suspect, error: r.error, ms: r.ms, model: r.model });
      }
    }
    const options = alive.map((p) => p.name);
    emit({ type: 'thinking', t: game.t, players: alive.map((p) => p.id), voting: true });
    const votes = await Promise.all(alive.map((p) => agents.get(p.id).vote(info, transcript, options)));
    const ballot = {};
    alive.forEach((p, i) => {
      const v = votes[i];
      ballot[p.id] = v.vote === 'skip' ? 'skip' : game.byName(v.vote).id;
      emit({ type: 'vote', t: game.t, p: p.id, target: ballot[p.id], thought: v.thought, error: v.error, ms: v.ms, model: v.model });
    });
    const result = game.resolveVotes(ballot);
    flush();

    // The public record of the meeting: every player remembers the same text.
    const name = (id) => (id === 'skip' ? 'skip' : game.byId(id).name);
    const why = m.reason === 'body' ? `${info.callerName} reported ${info.bodyName}'s body in ${info.room}` : `${info.callerName} pressed the button`;
    const outcome = result.ejected
      ? `${name(result.ejected)} was ejected${game.rules.confirmEjects ? (result.wasImpostor ? ' (an Impostor)' : ' (NOT an Impostor)') : ''}`
      : `nobody was ejected (${result.why})`;
    const text = [
      `Meeting #${m.n} [${clock(info.t)}]: ${why}. Dead by then: ${info.dead.join(', ') || 'nobody'}.`,
      ...transcript.map((c) => `  ${c.name}: ${quote(c.text)}`),
      `  Votes: ${alive.map((p) => `${p.name}→${name(ballot[p.id])}`).join(', ')}`,
      `  Result: ${outcome}.`,
    ].join('\n');
    for (const a of agents.values()) a.memory.addMeeting(text);
    log(`  ${outcome}`);
    game.endMeeting();
    flush();
  };

  const files = () => {
    fs.closeSync(eventsFd);
    if (promptsFd !== null) fs.closeSync(promptsFd);
  };

  try {
    game.start();
    flush();
    while (game.phase !== 'over') {
      if (game.phase === 'meeting') { await runMeeting(); continue; }
      const pending = game.pendingDecisions();
      if (pending.length) {
        const views = pending.map((p) => game.view(p.id));
        emit({ type: 'thinking', t: game.t, players: pending.map((p) => p.id) });
        const results = await Promise.all(pending.map((p, i) => agents.get(p.id).decideRoam(views[i])));
        pending.forEach((p, i) => {
          const r = results[i];
          emit({ type: 'decision', t: game.t, p: p.id, reason: views[i].reason, thought: r.thought, action: r.action, raw: r.raw, say: r.say, note: r.note, error: r.error, ms: r.ms, model: r.model });
          if (game.phase === 'roam' && p.alive) {
            game.speak(p.id, r.say); // said where they stand, before the order moves them
            game.act(p.id, r.action);
          }
          flush();
        });
        if (game.phase !== 'roam') continue;
      }
      game.step();
      flush();
    }

    log(`[${clock(game.t)}] game over: ${game.winner} (${game.reason})`);
    if (config.persistentMemory) await reflectAll();
  } catch (e) {
    emit({ type: 'match_error', t: game.t, error: String(e?.message ?? e) });
    throw e;
  } finally {
    // Per-seat call counts, errors and tokens, so anything built on the log has the costs too.
    emit({ type: 'stats', t: game.t, seats: Object.fromEntries([...agents].map(([id, a]) => [id, a.stats])) });
    files();
  }

  async function reflectAll() {
    const roles = seats.map((s) => `${s.name}=${game.byId(s.id).role}`).join(', ');
    const headline = game.winner === 'none'
      ? `Nobody won (${game.reason}).`
      : `${game.winner === 'crew' ? 'The crewmates' : 'The impostors'} won (${game.reason}).`;
    const results = await Promise.all(seats.map((s) => {
      const p = game.byId(s.id);
      return agents.get(s.id).reflect({ headline, roles, myRole: p.role, survived: p.alive });
    }));
    const date = new Date().toISOString().slice(0, 10);
    seats.forEach((s, i) => {
      const r = results[i];
      const p = game.byId(s.id);
      emit({ type: 'reflection', t: game.t, p: s.id, lesson: r.lesson, thought: r.thought, error: r.error });
      if (!r.lesson) return;
      const won = game.winner === (p.role === 'impostor' ? 'impostor' : 'crew');
      appendLongTerm(memoryDir, s, { date, matchId, role: p.role, result: won ? 'won' : 'lost', lesson: r.lesson });
    });
  }

  return { winner: game.winner, reason: game.reason, t: game.t, dir, events, agents };
}
