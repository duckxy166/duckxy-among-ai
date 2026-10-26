// A stand-in for N AUBridge copies sharing one tiny ship, so the bridge code can be tested without
// the game. Same protocol (newline JSON over TCP, token, wait_event long poll), event names and
// state fields as the real mod; walking and tasks take a few milliseconds. No tests in this file.

import net from 'node:net';

const ROOMS = ['Cafeteria', 'Admin', 'Electrical', 'MedBay', 'Nav', 'Reactor'];
const TASKS = [
  { name: 'FixWiring', room: 'Electrical' }, { name: 'SwipeCard', room: 'Admin' },
  { name: 'SubmitScan', room: 'MedBay' }, { name: 'StabilizeSteering', room: 'Nav' },
];
const VENTS = [
  { id: 0, room: 'Cafeteria', to: [1] }, { id: 1, room: 'Admin', to: [0] },
  { id: 3, room: 'Electrical', to: [6] }, { id: 6, room: 'MedBay', to: [3] },
];
const ventExits = (v) => v.to.map((id) => ({ id, room: VENTS.find((x) => x.id === id).room }));

// impostor: one name or a list. sabotageCooldown: what `state` reports while no sabotage is on (99
// keeps the mock brains from sabotaging, 0 lets the impostor sabotage at once); a reactor sabotage is
// lost after reactorMs. The copies of the players in `abstain` refuse their votes; those in `busyVote`
// answer their first vote with "game thread busy" and cast it a moment later anyway. With votingMs,
// voting closes after that long and whoever has not voted missed it. The results screen stays up for
// resultsMs. The `stuckFix`-th reactor fix order (1, 2...) gets that player stuck on the way instead.
export async function startFakeShip({
  names, impostor, token, stepMs = 20, tasksPerPlayer = 2, votingDelayMs = 300, sabotageCooldown = 99, reactorMs = 3000,
  abstain = [], busyVote = [], votingMs = 0, resultsMs = stepMs * 3, stuckFix = 0,
}) {
  const ship = { stage: 'lobby', phase: null, over: false, bodies: [], meeting: null, voted: [], sab: null, t0: Date.now(), calls: [], sockets: new Set(), fixes: 0 };
  const now = () => (Date.now() - ship.t0) / 1000;
  const players = names.map((name, i) => ({
    name, i, role: 'crewmate', alive: true, room: 'Cafeteria', vent: null, tasks: [], seenBodies: new Set(), events: [], seq: 0, waiters: [],
  }));
  const byName = (n) => players.find((p) => p.name === n);
  const isImp = (p) => p.role === 'impostor';
  // Like the mod: every other impostor, and `partner` (the first one) for older readers.
  const partners = (p) => (isImp(p) ? players.filter((o) => o !== p && isImp(o)).map((o) => o.name) : []);
  // Like the mod's Events.Add: a field called `type` is renamed `kind`.
  const push = (p, type, { type: kind, ...fields } = {}) => {
    p.seq++;
    p.events.push({ seq: p.seq, t: now(), type, ...fields, ...(kind !== undefined ? { kind } : {}) });
    const w = p.waiters;
    p.waiters = [];
    w.forEach((f) => f());
  };
  const all = (type, fields) => players.forEach((p) => push(p, type, fields));
  const near = (p) => players.filter((o) => o !== p && o.alive && !o.vent && o.room === p.room);
  const later = (fn) => setTimeout(fn, stepMs);

  function moveTo(p, room) {
    if (p.room === room || !p.alive) return;
    for (const o of near(p)) { push(p, 'lost_player', { name: o.name, room: p.room }); push(o, 'lost_player', { name: p.name, room: o.room }); }
    p.room = room;
    for (const o of near(p)) { push(p, 'saw_player', { name: o.name, room }); push(o, 'saw_player', { name: p.name, room }); }
    push(p, 'room_changed', { room });
    for (const b of ship.bodies) {
      if (b.room === room && !p.seenBodies.has(b.name)) { p.seenBodies.add(b.name); push(p, 'saw_body', { name: b.name, room }); }
    }
  }

  function end(winner, reason) {
    if (ship.over) return;
    ship.over = true;
    all('game_ended', { winner, reason });
  }

  function checkWin(reasonCrew = 'CrewmatesByVote') {
    const imps = players.filter((p) => p.alive && isImp(p)).length;
    const crew = players.filter((p) => p.alive && !isImp(p)).length;
    if (imps === 0) end('crew', reasonCrew);
    else if (imps >= crew) end('impostors', 'ImpostorsByKill');
    else if (players.filter((p) => !isImp(p)).every((p) => p.tasks.every((t) => t.done))) end('crew', 'CrewmatesByTask');
  }

  function fixed() {
    clearTimeout(ship.sab.timer);
    const kind = ship.sab.kind;
    ship.sab = null;
    all('sabotage_fixed', { type: kind });
  }

  // The reactor is fixed only while both panels (0 and 1) are held.
  function hold(p, id) {
    if (!ship.sab || ship.sab.kind !== 'reactor') return;
    ship.sab.held.set(p.name, id);
    if (new Set(ship.sab.held.values()).size === 2) fixed();
  }

  function startMeeting(caller, body) {
    ship.phase = 'meeting';
    ship.meeting = { caller: caller.name, body, votes: new Map() };
    ship.bodies = [];
    all('meeting_started', { caller: caller.name, body });
    setTimeout(() => {
      const m = ship.meeting;
      if (!m) return;
      ship.phase = 'voting';
      all('voting_started');
      if (votingMs) m.timer = setTimeout(() => { if (ship.meeting === m) resolveVotes(true); }, votingMs);
    }, votingDelayMs);
  }

  // timeUp: the voting time ran out, so the votes cast so far decide.
  function resolveVotes(timeUp = false) {
    const m = ship.meeting;
    const living = players.filter((p) => p.alive);
    if (!timeUp && !living.every((p) => m.votes.has(p.name) || abstain.includes(p.name))) return;
    clearTimeout(m.timer);
    const tally = {};
    let skip = 0;
    for (const v of m.votes.values()) if (v === 'skip') skip++; else tally[v] = (tally[v] || 0) + 1;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const top = ranked[0]?.[1] ?? 0;
    const tie = ranked.length > 1 && ranked[1][1] === top;
    const out = top > skip && !tie ? byName(ranked[0][0]) : null;
    ship.meeting = null;
    ship.phase = 'voting_result';
    ship.voted = [...m.votes.keys()];
    // Like the mod: the results screen first, then meeting_ended (and the game's end, if this vote ends it).
    setTimeout(() => {
      all('meeting_ended', { ejected: out?.name ?? null, tie, ...(out ? { wasImpostor: isImp(out) } : {}) });
      if (out) out.alive = false;
      checkWin();
      if (ship.over) return;
      ship.phase = 'tasks';
      for (const p of players) if (p.alive) moveTo(p, 'Cafeteria');
      // The mod forgets its sightings at a meeting, so everyone in view is seen anew.
      for (const p of players) if (p.alive) for (const o of near(p)) push(p, 'saw_player', { name: o.name, room: p.room });
    }, resultsMs);
  }

  function act(p, a) {
    const ok = () => ({ ok: true, accepted: a.do });
    const err = (error) => ({ ok: false, error });
    ship.calls.push({ who: p.name, ...a });
    switch (a.do) {
      case 'stay':
        return ok();
      case 'move_to':
        if (a.room && !ROOMS.includes(a.room)) return err(`unknown room '${a.room}' (${ROOMS.join(',')})`);
        later(() => { moveTo(p, a.room ?? p.room); push(p, 'arrived', { room: p.room }); });
        return ok();
      case 'do_task': {
        const t = p.tasks.find((x) => x.id === a.id);
        if (!t) return err('no such task');
        if (t.done || t.fake) return err('task already done');
        later(() => {
          moveTo(p, t.room);
          later(() => {
            if (ship.phase !== 'tasks' || ship.over) return;
            if (isImp(p)) { t.fake = true; push(p, 'task_faked', { id: t.id, name: t.name }); return; }
            t.done = true;
            push(p, 'task_done', { id: t.id, name: t.name });
            checkWin('CrewmatesByTask');
          });
        });
        return ok();
      }
      case 'follow':
        return near(p).some((o) => o.name === a.target) ? ok() : err('target not visible');
      case 'kill': {
        if (!isImp(p)) return err('only an impostor can kill');
        const v = near(p).find((o) => o.name === a.target);
        if (!v) return err('target not visible');
        v.alive = false;
        ship.bodies.push({ name: v.name, room: p.room });
        push(p, 'kill_done', { victim: v.name, room: p.room });
        push(v, 'you_died', { cause: 'killed', killer: p.name });
        for (const o of near(p)) {
          push(o, 'saw_kill', { killer: p.name, victim: v.name, room: p.room });
          o.seenBodies.add(v.name);
          push(o, 'saw_body', { name: v.name, room: p.room });
        }
        checkWin();
        return { ...ok(), target: v.name, distance: 1 };
      }
      case 'report': {
        const b = ship.bodies.find((x) => x.room === p.room);
        if (!b) return err('no body visible');
        startMeeting(p, b.name);
        return ok();
      }
      case 'call_meeting':
        later(() => startMeeting(p, null));
        return ok();
      case 'sabotage': // a ghost impostor may sabotage too, as in the mod
        if (!isImp(p)) return err('only an impostor can sabotage');
        if (ship.sab) return err('a sabotage is already active');
        ship.sab = { kind: a.type, held: new Map() };
        if (a.type === 'reactor') ship.sab.timer = setTimeout(() => end('impostors', 'ImpostorsBySabotage'), reactorMs);
        all('sabotage', { type: a.type });
        return { ...ok(), type: a.type };
      case 'fix':
        if (isImp(p)) return err('impostors cannot repair sabotage');
        if (!ship.sab || ship.sab.kind !== a.type) return err(`no active ${a.type} sabotage`);
        if (a.type !== 'reactor') { later(fixed); return ok(); }
        if (a.id !== undefined && a.id !== 0 && a.id !== 1) return err('no console with that id');
        if (++ship.fixes === stuckFix) { later(() => push(p, 'stuck')); return ok(); }
        // Like the mod, no id means the nearest panel: here always panel 1.
        later(() => { moveTo(p, 'Reactor'); later(() => hold(p, a.id ?? 1)); });
        return ok();
      case 'chat':
        if (!ship.meeting && ship.phase !== 'voting') return err('chat is only available in meetings');
        if (String(a.text ?? '').length > 100) return err('chat text too long (max 100)');
        all('chat', { from: p.name, text: a.text });
        return ok();
      case 'vote':
        if (ship.phase !== 'voting' || !ship.meeting) return err('voting is not open yet');
        if (abstain.includes(p.name)) return err('this copy refuses to vote');
        if (ship.meeting.votes.has(p.name)) return err('already voted');
        if (busyVote.includes(p.name)) {
          const m = ship.meeting;
          later(() => { if (ship.meeting === m && !m.votes.has(p.name)) { m.votes.set(p.name, a.target); resolveVotes(); } });
          return err('game thread busy');
        }
        ship.meeting.votes.set(p.name, a.target);
        resolveVotes();
        return ok();
      case 'vent': {
        if (!isImp(p) || !p.alive) return err('you cannot use vents');
        if (a.to !== undefined) {
          const v = p.vent && VENTS.find((x) => x.id === Number(a.to) && p.vent.to.includes(x.id));
          if (!v) return err('no such neighbouring vent (left|right|center|id)');
          // The game's own refusal while the jump into the vent is still animating.
          if (Date.now() - p.ventAt < 150) return err('vent move failed: Player was still in the middle of animating into current vent; not allowed to move vents that fast');
          p.vent = v;
          p.room = v.room;
          push(p, 'room_changed', { room: v.room });
          return { ...ok(), vent: v.id };
        }
        if (a.enter === false) {
          if (!p.vent) return err('not in a vent');
          const id = p.vent.id;
          p.vent = null;
          for (const o of near(p)) push(o, 'saw_vent', { name: p.name, vent: id, action: 'exit' });
          return { ...ok(), exit: id };
        }
        if (p.vent) return err('already in a vent');
        const v = VENTS.find((x) => x.room === p.room);
        if (!v) return err('no usable vent in reach');
        for (const o of near(p)) push(o, 'saw_vent', { name: p.name, vent: v.id, action: 'enter' });
        p.vent = v;
        p.ventAt = Date.now();
        return { ...ok(), enter: v.id };
      }
      default:
        return err(`unknown action: ${a.do}`);
    }
  }

  function state(p) {
    const base = { ok: true, id: p.i + 1, stage: ship.stage, scene: 'OnlineGame', players: players.map((o) => ({ name: o.name, color: o.i, isLocal: o === p })) };
    if (ship.stage === 'lobby') return { ...base, game: null };
    const imp = isImp(p);
    const crewTasks = players.filter((o) => !isImp(o)).flatMap((o) => o.tasks);
    return {
      ...base,
      game: {
        phase: ship.over ? 'ended' : ship.phase, intro: false, canMove: ship.phase === 'tasks' && p.alive,
        me: {
          name: p.name, color: p.i, alive: p.alive, role: p.alive ? p.role : (imp ? 'ghost_imp' : 'ghost_crew'),
          pos: [0, 0], room: p.room, killCooldown: 0, killRange: imp ? 1.5 : 0, inVent: !!p.vent,
          partner: partners(p)[0] ?? null, partners: partners(p),
        },
        tasks: p.tasks.map((t) => ({ id: t.id, name: t.name, room: t.room, done: !!t.done, ...(t.fake ? { fake: true } : {}) })),
        taskBar: crewTasks.length ? crewTasks.filter((t) => t.done).length / crewTasks.length : 0,
        visible: p.alive ? near(p).map((o) => ({ name: o.name, color: o.i, pos: [1, 0], room: o.room, alive: true, distance: 1, inVent: false })) : [],
        bodies: ship.bodies.filter((b) => b.room === p.room).map((b) => ({ name: b.name, color: 0, pos: [0, 1], room: b.room, distance: 0.5 })),
        sabotage: { active: ship.sab?.kind ?? null, timer: ship.sab ? 30 : 0, cooldown: imp && !ship.sab ? sabotageCooldown : 0 },
        // Like the mod: vents in view with where they lead, plus the one the impostor is inside.
        vents: imp && p.alive ? [
          ...VENTS.filter((v) => v.room === p.room).map((v) => ({ id: v.id, pos: [2, 2], room: v.room, distance: 1, to: ventExits(v) })),
          ...(p.vent ? [{ current: p.vent.id, to: ventExits(p.vent) }] : []),
        ] : [],
        meeting: ship.meeting ? { caller: ship.meeting.caller, reportedBody: ship.meeting.body, voted: [...ship.meeting.votes.keys()] }
          : ship.phase === 'voting_result' ? { voted: ship.voted } : null,
        busy: 'idle',
      },
    };
  }

  function start() {
    if (ship.stage !== 'lobby') return { ok: false, error: 'already started' };
    ship.stage = 'ingame';
    ship.phase = 'tasks';
    ship.t0 = Date.now();
    for (const p of players) {
      if ([impostor].flat().includes(p.name)) p.role = 'impostor';
      p.tasks = Array.from({ length: tasksPerPlayer }, (_, k) => ({ id: k, ...TASKS[(p.i + k) % TASKS.length] }));
    }
    for (const p of players) push(p, 'game_started', { role: p.role, partner: partners(p)[0] ?? null, partners: partners(p), tasks: p.tasks.length });
    // Like the mod, everyone already in view counts as newly seen.
    for (const p of players) for (const o of near(p)) push(p, 'saw_player', { name: o.name, room: p.room });
    return { ok: true };
  }

  async function handle(p, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return { ok: false, error: 'bad json' }; }
    if (msg.token !== token) return { ok: false, error: 'bad token' };
    switch (msg.cmd) {
      case 'state': return state(p);
      case 'configure': ship.config = msg; return { ok: true };
      case 'start': return start();
      case 'act': return act(p, msg);
      case 'autopilot': ship.calls.push({ who: p.name, do: 'autopilot', on: msg.on }); return { ok: true };
      case 'wait_event': {
        const since = msg.since ?? 0;
        const fresh = () => p.events.filter((e) => e.seq > since);
        if (!fresh().length && msg.timeout > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, msg.timeout * 1000);
            p.waiters.push(() => { clearTimeout(timer); resolve(); });
          });
        }
        return { ok: true, seq: p.seq, events: fresh() };
      }
      default: return { ok: false, error: `unknown cmd ${msg.cmd}` };
    }
  }

  const servers = [];
  for (const p of players) {
    const server = net.createServer((sock) => {
      ship.sockets.add(sock);
      sock.on('close', () => ship.sockets.delete(sock));
      sock.on('error', () => {});
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', async (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const reply = await handle(p, line);
          if (!sock.destroyed) sock.write(`${JSON.stringify(reply)}\n`);
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    p.port = server.address().port;
    servers.push(server);
  }

  return {
    ship,
    players,
    ports: players.map((p) => p.port),
    async close() {
      clearTimeout(ship.sab?.timer);
      clearTimeout(ship.meeting?.timer);
      for (const p of players) { const w = p.waiters; p.waiters = []; w.forEach((f) => f()); }
      for (const s of ship.sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    },
  };
}
