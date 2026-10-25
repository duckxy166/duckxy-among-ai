import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBridgeMatch, fitChat } from '../src/bridge/runner.js';
import { BridgeClient } from '../src/bridge/client.js';
import { BridgeSeat, until } from '../src/bridge/seat.js';
import { MatchLedger } from '../src/bridge/ledger.js';
import { roamPrompt } from '../src/agents/prompts.js';
import { launchArgs } from '../src/bridge/launcher.js';
import { roomFromBridge, roomToBridge, colorId } from '../src/bridge/skeld.js';
import { EpisodicMemory } from '../src/agents/memory.js';
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/rng.js';
import { createProvider } from '../src/providers/index.js';
import { startFakeShip } from './fake-bridge.js';

const TOKEN = 'test-token-0123456789abcdef';
const NAMES = ['Red', 'Blue', 'Green', 'Pink'];
const SEATS = NAMES.map((n) => ({ id: n.toLowerCase(), name: n, color: n.toLowerCase(), provider: 'mock', label: 'mock' }));
const CONFIG = {
  seed: 5, language: 'en', discussionRounds: 1, revealModels: true, persistentMemory: false, logPrompts: false, rules: {},
  bridge: { lobby: { discussion: 0, voting: 5 }, maxMinutes: 1 },
};

async function play(ship, providers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-bridge-'));
  const clients = new Map(SEATS.map((s, i) => [s.id, new BridgeClient({ id: i + 1, port: ship.ports[i], token: TOKEN })]));
  return runBridgeMatch({ config: CONFIG, seats: SEATS, providers, clients, matchId: 'test-bridge', dir, memoryDir: path.join(dir, 'memory') });
}

// The impostor (Pink) kills Green at once and kills again right after a meeting; the crew reports and
// accuses Pink. crewVote: what the crew votes ('Pink' ends the game at the first meeting, 'skip' plays on).
function scripted(seat, prompts, crewVote = 'Pink') {
  return {
    async complete({ user, context }) {
      prompts.push(user);
      const { kind, view, role } = context;
      const can = (id) => view.legal.some((a) => a.id === id);
      const thought = `[${seat.id}] ${kind}`;
      let out;
      if (kind === 'roam') {
        const again = view.reason === 'meeting_over' ? view.legal.find((a) => a.id.startsWith('kill:'))?.id : undefined;
        const kill = can('kill:Green') ? 'kill:Green' : again;
        const action = role === 'impostor' ? kill ?? 'wait:15' : can('report') ? 'report' : 'wait:15';
        out = { secret_thought: thought, action, note: '' };
      } else if (kind === 'speak') {
        out = role === 'impostor'
          ? { secret_thought: thought, chat_message: 'not me, I was doing tasks the whole time', suspect: 'none' }
          : { secret_thought: thought, chat_message: `I saw Pink kill Green in Cafeteria. ${'Vote Pink now! '.repeat(10)}`, suspect: 'Pink' };
      } else if (kind === 'vote') {
        out = { secret_thought: thought, vote: role === 'impostor' ? 'skip' : crewVote };
      } else {
        out = { secret_thought: thought, lesson: 'ok' };
      }
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
}

test('a scripted round through the bridge: kill, report, chat, vote, crew win', async () => {
  const ship = await startFakeShip({ names: NAMES, impostor: 'Pink', token: TOKEN, votingDelayMs: 2500 });
  const prompts = new Map(SEATS.map((s) => [s.id, []]));
  try {
    const providers = new Map(SEATS.map((s) => [s.id, scripted(s, prompts.get(s.id))]));
    const r = await play(ship, providers);
    const of = (type) => r.events.filter((e) => e.type === type);

    assert.equal(r.winner, 'crew');
    assert.equal(r.reason, 'CrewmatesByVote');
    assert.equal(of('match_error').length, 0);
    const start = of('match_start')[0];
    assert.equal(start.body, 'among-us');
    assert.deepEqual(start.players.map((p) => p.role), ['crew', 'crew', 'crew', 'impostor']);
    assert.equal(ship.ship.config.impostors, 1);

    const kill = of('kill')[0];
    assert.deepEqual([kill.killer, kill.victim, kill.room], ['pink', 'green', 'Cafeteria']);
    assert.deepEqual(kill.witnesses.sort(), ['blue', 'red']);
    const meeting = of('meeting_start')[0];
    assert.deepEqual([meeting.reason, meeting.body], ['body', 'green']);

    // Chat goes through the game, cut to its 100-character limit.
    const sent = ship.ship.calls.filter((c) => c.do === 'chat');
    assert.equal(sent.length, 3);
    assert.ok(sent.every((c) => c.text.length <= 100));
    assert.deepEqual(of('vote').map((v) => `${v.p}>${v.target}`).sort(), ['blue>pink', 'pink>skip', 'red>pink']);
    const result = of('vote_result')[0];
    assert.deepEqual([result.ejected, result.wasImpostor], ['pink', true]);
    assert.deepEqual(of('game_over')[0].winner, 'crew');
    // The game ends on this vote, yet the log tells the vote result first.
    assert.ok(result.seq < of('game_over')[0].seq);

    // Each memory holds only what that copy showed.
    const mem = (id) => r.agents.get(id).memory;
    assert.ok(mem('red').evidence().some((f) => f.kind === 'kill' && f.who === 'Pink'));
    assert.ok(mem('pink').entries.some((e) => e.kind === 'you_killed'));
    assert.ok(mem('green').entries.some((e) => e.kind === 'you_died'));
    assert.ok(!mem('pink').entries.some((e) => e.kind === 'saw_kill'));
    assert.ok(mem('red').meetings[0].includes('Pink was ejected (an Impostor)'));
    // A dead crewmate's copy keeps doing tasks on AUBridge's autopilot.
    assert.ok(ship.ship.calls.some((c) => c.who === 'Green' && c.do === 'autopilot'));
    for (const [id, list] of prompts) {
      for (const other of SEATS.map((s) => s.id).filter((x) => x !== id)) {
        assert.ok(!list.join('\n').includes(`[${other}] `), `${id} saw a thought of ${other}`);
      }
    }
  } finally {
    await ship.close();
  }
});

test('after a meeting that ejects nobody, play goes on until the impostor wins', async () => {
  const ship = await startFakeShip({ names: NAMES, impostor: 'Pink', token: TOKEN, votingDelayMs: 500 });
  try {
    const providers = new Map(SEATS.map((s) => [s.id, scripted(s, [], 'skip')]));
    const r = await play(ship, providers);
    const of = (type) => r.events.filter((e) => e.type === type);
    assert.equal(of('match_error').length, 0);
    const result = of('vote_result')[0];
    assert.deepEqual([result.ejected, result.why], [null, 'skip']);
    const end = of('meeting_end')[0];
    assert.ok(end, 'the meeting closes once every copy can move again');
    // Every living seat is woken by the end of the meeting and decides again.
    const after = of('decision').filter((d) => d.seq > end.seq && d.reason === 'meeting_over').map((d) => d.p).sort();
    assert.deepEqual(after, ['blue', 'pink', 'red']);
    assert.equal(of('kill').length, 2);
    assert.deepEqual([r.winner, r.reason], ['impostor', 'ImpostorsByKill']);
    assert.ok(r.agents.get('red').memory.meetings[0].includes('nobody was ejected (skip)'));
  } finally {
    await ship.close();
  }
});

test('crewmates fixing the reactor together hold different panels', async () => {
  // Pink sabotages the reactor once; the crew fixes it, then finishes its tasks.
  const brain = {
    async complete({ context }) {
      const { kind, view, role } = context;
      const can = (id) => view?.legal.some((a) => a.id === id);
      const task = view?.legal.find((a) => a.id.startsWith('task:'))?.id;
      let action = 'wait:15';
      if (role === 'impostor' && can('sabotage:reactor') && !brain.done) { action = 'sabotage:reactor'; brain.done = true; }
      if (role !== 'impostor') action = can('fix') ? 'fix' : task ?? 'wait:15';
      const out = kind === 'roam' ? { secret_thought: 'x', action, note: '' } : { secret_thought: 'x', chat_message: '', suspect: 'none', vote: 'skip', lesson: '' };
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
  const ship = await startFakeShip({ names: NAMES, impostor: 'Pink', token: TOKEN, sabotageCooldown: 0 });
  try {
    const r = await play(ship, new Map(SEATS.map((s) => [s.id, brain])));
    const of = (type) => r.events.filter((e) => e.type === type);
    const fixes = ship.ship.calls.filter((c) => c.do === 'fix');
    assert.ok(fixes.length >= 2);
    assert.deepEqual(fixes.slice(0, 2).map((c) => c.id).sort(), [0, 1]);
    assert.deepEqual(of('sabotage').map((e) => [e.kind, e.by]), [['reactor', 'pink']]);
    assert.deepEqual(of('sabotage_fixed').map((e) => e.kind), ['reactor']);
    assert.deepEqual([r.winner, r.reason], ['crew', 'CrewmatesByTask']);
    assert.ok(r.agents.get('red').memory.entries.some((e) => e.kind === 'sabotage' && /^Reactor meltdown!/.test(e.text)));
  } finally {
    await ship.close();
  }
});

// Two impostors, Pink and Blue. Red calls a meeting at once and everyone votes Pink out; Pink's ghost
// sabotages the lights, and Blue kills Green once they are out.
function ghostScript(seat, decisions) {
  return {
    async complete({ context }) {
      const { kind, view } = context;
      const can = (id) => view.legal.some((a) => a.id === id);
      const thought = `[${seat.id}] ${kind}`;
      let out;
      if (kind === 'roam') {
        decisions.push({ p: seat.id, dead: view.dead, reason: view.reason, legal: view.legal.map((a) => a.id) });
        let action = 'wait:15';
        if (view.dead && can('sabotage:lights')) action = 'sabotage:lights';
        else if (seat.id === 'blue') action = view.sabotage && can('kill:Green') ? 'kill:Green' : 'wait:5';
        else if (seat.id === 'red' && view.reason === 'start') action = 'emergency';
        out = { secret_thought: thought, action, note: '' };
      } else if (kind === 'speak') {
        out = { secret_thought: thought, chat_message: 'Pink is sus', suspect: 'Pink' };
      } else if (kind === 'vote') {
        out = { secret_thought: thought, vote: seat.id === 'pink' ? 'skip' : 'Pink' };
      } else {
        out = { secret_thought: thought, lesson: 'ok' };
      }
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
}

test('an ejected impostor sabotages as a ghost, and is not asked while it cannot', async () => {
  const ship = await startFakeShip({ names: NAMES, impostor: ['Pink', 'Blue'], token: TOKEN, sabotageCooldown: 0 });
  const decisions = [];
  try {
    const providers = new Map(SEATS.map((s) => [s.id, ghostScript(s, decisions)]));
    const r = await play(ship, providers);
    const of = (type) => r.events.filter((e) => e.type === type);
    assert.equal(of('match_error').length, 0);
    const result = of('vote_result')[0];
    assert.equal(result.ejected, 'pink');
    const sab = of('sabotage').find((e) => e.by === 'pink');
    assert.ok(sab && sab.seq > result.seq, 'the ghost sabotaged after its ejection');
    assert.ok(ship.ship.calls.some((c) => c.who === 'Pink' && c.do === 'sabotage' && c.type === 'lights'));
    assert.ok(r.agents.get('pink').memory.entries.some((e) => e.kind === 'you_sabotaged'));
    // One decision as a ghost: woken by a ready sabotage, offered nothing else, and with the
    // sabotage on there was nothing left to ask.
    const ghost = decisions.filter((d) => d.p === 'pink' && d.dead);
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0].reason, 'sabotage_ready');
    assert.ok(ghost[0].legal.every((id) => id.startsWith('wait:') || id.startsWith('sabotage:')));
    assert.deepEqual([r.winner, r.reason], ['impostor', 'ImpostorsByKill']);
  } finally {
    await ship.close();
  }
});

test('the mock brains play a whole game on the fake ship', async () => {
  const ship = await startFakeShip({ names: NAMES, impostor: 'Blue', token: TOKEN });
  try {
    const providers = new Map();
    for (const s of SEATS) providers.set(s.id, await createProvider(s, { seed: 9 }));
    const r = await play(ship, providers);
    assert.ok(['crew', 'impostor'].includes(r.winner));
    assert.equal(r.events.filter((e) => e.type === 'match_error').length, 0);
    const stats = r.events.at(-1);
    assert.equal(stats.type, 'stats');
    assert.ok(Object.values(stats.seats).every((s) => s.calls > 0));
    assert.ok(r.events.some((e) => e.type === 'memory' && e.kind === 'task_done'));
  } finally {
    await ship.close();
  }
});

// What a seat gets from its match, with a real ledger behind it.
function seatMatch(names, emitted = [], warnings = []) {
  const ledger = new MatchLedger({
    seats: names.map((n) => ({ id: n.toLowerCase(), name: n })), emit: (e) => emitted.push(e), inView: () => new Set(),
  });
  return {
    lang: 'en', rules: { followSeconds: 20, emergencyMeetings: 1 }, meeting: null, over: false,
    now: () => 12, emit: (e) => emitted.push(e), warn: (w) => warnings.push(w), ledger, onBridgeEvent() {},
  };
}

test('a seat turns bridge events into memory lines and actions into act commands', async () => {
  const STATE = {
    phase: 'tasks', canMove: true,
    me: { name: 'Red', alive: true, role: 'impostor', room: 'Nav', killCooldown: 0, killRange: 1.5, partner: null },
    tasks: [{ id: 3, name: 'StabilizeSteering', room: 'Nav', done: false }, { id: 4, name: 'FixWiring', room: 'Electrical', done: false, fake: true }],
    taskBar: 0.25,
    visible: [{ name: 'Blue', room: 'Nav', alive: true, distance: 1 }],
    bodies: [],
    sabotage: { active: null, timer: 0, cooldown: 0 },
  };
  const calls = [];
  const client = {
    act: async (a) => { calls.push(a); return a.do === 'kill' ? { ok: false, error: 'kill cooldown 3.0s left' } : { ok: true }; },
    state: async () => ({ ok: true, stage: 'ingame', game: STATE }),
  };
  const emitted = [];
  const match = seatMatch(['Red', 'Blue', 'Green'], emitted);
  const seat = new BridgeSeat({ seat: { id: 'red', name: 'Red' }, client, match });
  seat.role = 'impostor';
  const memory = new EpisodicMemory();
  seat.onEvent({ type: 'saw_player', t: 9, name: 'Blue', room: 'Nav' }); // before attach: buffered
  seat.attach({ memory });
  seat.state = STATE;

  seat.onEvent({ type: 'saw_kill', t: 10, killer: 'Blue', victim: 'Green', room: 'LifeSupp' });
  const line = memory.entries.at(-1);
  assert.equal(line.kind, 'saw_kill');
  assert.match(line.text, /Blue killed Green in O2/);
  assert.equal(seat.needs, 'saw_kill');
  assert.equal(memory.entries[0].kind, 'saw_player');

  seat.onEvent({ type: 'room_changed', t: 11, room: 'Nav' });
  assert.deepEqual(emitted.find((e) => e.type === 'arrive'), { type: 'arrive', t: 12, p: 'red', room: 'Navigation', ghost: false });
  assert.match(memory.entries.at(-1).text, /Arrived at Navigation — saw: Blue/);

  // The mod sends a sabotage's type as `kind`; memory lines carry the match clock, not the mod's `t`.
  seat.onEvent({ type: 'sabotage', t: 99, kind: 'reactor' });
  assert.match(memory.entries.at(-1).text, /^Reactor meltdown!/);
  assert.equal(memory.entries.at(-1).t, 12);

  const ids = seat.legalActions().map((a) => a.id);
  for (const id of ['move:O2', 'fake:3', 'follow:Blue', 'kill:Blue', 'sabotage:lights', 'emergency']) assert.ok(ids.includes(id), id);
  for (const id of ['move:Navigation', 'fake:4', 'task:3', 'fix', 'report']) assert.ok(!ids.includes(id), id);
  const view = seat.view('idle');
  assert.equal(view.location, 'Navigation');
  assert.deepEqual(view.taskBar, { done: 25, total: 100 });
  assert.deepEqual(view.tasks.map((x) => [x.name, x.room, x.done]), [['Stabilize Steering', 'Navigation', false], ['Fix Wiring', 'Electrical', true]]);

  // The view has the simulator's fields plus `dead` (its own liveness: a ghost impostor still decides)
  // and nothing more; another copy's kill becomes known only when a meeting announces it.
  const sim = new Game({ seats: ['red', 'blue', 'green', 'pink'].map((c) => ({ id: c, name: c, color: c })), rng: createRng(1) });
  assert.deepEqual(Object.keys(view).sort(), [...Object.keys(sim.view('red')), 'dead'].sort());
  match.ledger.killed('blue', 'Green', 'O2');
  assert.deepEqual(seat.view('idle').knownDead, []);
  match.ledger.announceDead();
  assert.deepEqual(seat.view('idle').knownDead, ['Green']);

  await seat.execute('move:O2');
  assert.deepEqual(calls.at(-1), { do: 'move_to', room: 'LifeSupp' });
  seat.needs = null;
  seat.onEvent({ type: 'arrived', t: 20, room: 'LifeSupp' });
  assert.equal(seat.plan, null);
  assert.equal(seat.needs, 'idle');

  // A walk that ends while the brain is already choosing its next action asks for no second decision.
  seat.needs = null;
  await seat.execute('move:Admin');
  seat.plan.stale = true;
  seat.onEvent({ type: 'arrived', t: 25, room: 'Admin' });
  assert.equal(seat.plan, null);
  assert.equal(seat.needs, null);

  await seat.execute('kill:Blue');
  assert.deepEqual(calls.at(-1), { do: 'kill', target: 'Blue' });
  assert.equal(memory.entries.at(-1).kind, 'rejected');
  assert.match(memory.entries.at(-1).text, /cooldown/);
});

test('a seat holds its reactor panel only while it is fixing', async () => {
  const STATE = {
    phase: 'tasks', canMove: true, me: { name: 'Red', alive: true, role: 'crewmate', room: 'Reactor' },
    tasks: [], visible: [], bodies: [], sabotage: { active: 'reactor', timer: 30, cooldown: 0 },
  };
  const calls = [];
  let refuse = false;
  const client = {
    act: async (a) => { calls.push(a); return refuse ? { ok: false, error: 'no path to the console' } : { ok: true }; },
    state: async () => ({ ok: true, stage: 'ingame', game: STATE }),
  };
  const match = seatMatch(['Red', 'Blue', 'Green']);
  const { ledger } = match;
  const seat = new BridgeSeat({ seat: { id: 'red', name: 'Red' }, client, match });
  seat.role = 'crew';
  seat.attach({ memory: new EpisodicMemory() });
  seat.state = STATE;

  await seat.execute('fix');
  assert.deepEqual(calls.at(-1), { do: 'fix', type: 'reactor', id: 0 });
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1);
  await seat.execute('fix'); // decides `fix` again: same panel
  assert.equal(calls.at(-1).id, 0);
  await seat.execute('move:Admin'); // walks off: panel 0 is free again
  ledger.releasePanel('blue');
  assert.equal(ledger.reactorPanel('green', 'reactor'), 0, 'nobody holds a panel');

  // A fix order the copy refuses holds nothing either.
  refuse = true;
  await seat.execute('fix');
  assert.equal(calls.at(-1).id, 1);
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1, 'only Green holds a panel');
});

test('an impostor vents through its copy: walk to the vent, in, one hop, out', async () => {
  const ship = await startFakeShip({ names: NAMES, impostor: 'Pink', token: TOKEN });
  const client = (i) => new BridgeClient({ id: i + 1, port: ship.ports[i], token: TOKEN });
  const emitted = [];
  const warnings = [];
  const match = seatMatch(NAMES, emitted, warnings);
  const pink = new BridgeSeat({ seat: { id: 'pink', name: 'Pink' }, client: client(3), match });
  const red = new BridgeSeat({ seat: { id: 'red', name: 'Red' }, client: client(0), match });
  try {
    await client(0).call('start');
    pink.role = 'impostor';
    red.role = 'crew';
    const memory = new EpisodicMemory();
    pink.attach({ memory });
    await pink.syncEvents();
    pink.pump();
    await Promise.all([pink.refresh(), red.refresh()]);

    // The vent in Cafeteria leads to Admin (the mod's `to`); crewmates get no vent actions.
    assert.deepEqual(pink.view('idle').vents, ['Admin']);
    assert.ok(pink.legalActions().some((a) => a.id === 'vent:Admin'));
    assert.ok(!red.legalActions().some((a) => a.id.startsWith('vent:')));

    await pink.execute('vent:Admin');
    assert.ok(await until(async () => pink.plan === null && !pink.venting, 5000, 20), 'the vent plan ends');
    // The first hop comes while the jump in is still animating; the game refuses it and it is sent again.
    const steps = ship.ship.calls.filter((c) => c.who === 'Pink').map((c) => (c.do === 'vent' ? `vent ${c.to ?? c.enter}` : c.do));
    assert.deepEqual(steps, ['move_to', 'vent true', 'vent 1', 'vent 1', 'vent false']);
    assert.ok(!memory.entries.some((e) => e.kind === 'rejected'));
    assert.equal(pink.room, 'Admin');
    assert.ok(memory.entries.some((e) => e.kind === 'you_vented' && /from Cafeteria to Admin/.test(e.text)));
    assert.ok(emitted.some((e) => e.type === 'vent' && e.p === 'pink' && e.from === 'Cafeteria' && e.to === 'Admin'));
    // Red stood in Cafeteria and saw Pink go in.
    assert.ok(ship.players[0].events.some((e) => e.type === 'saw_vent' && e.name === 'Pink' && e.action === 'enter'));

    // No vent in Admin leads to Electrical: refused without walking anywhere.
    const before = ship.ship.calls.length;
    await pink.execute('vent:Electrical');
    assert.equal(ship.ship.calls.length, before);
    assert.match(memory.entries.at(-1).text, /no vent here leads there/);
    assert.deepEqual(warnings, []);
  } finally {
    pink.stop();
    await ship.close();
  }
});

test('a dead impostor is offered sabotage only, and only when one is ready', async () => {
  const state = {
    phase: 'tasks', canMove: true, me: { name: 'Pink', alive: false, role: 'ghost_imp', room: 'Admin' },
    tasks: [], visible: [], bodies: [], vents: [], sabotage: { active: null, timer: 0, cooldown: 12 },
  };
  const calls = [];
  const client = {
    act: async (a) => { calls.push(a); return { ok: true }; },
    state: async () => ({ ok: true, stage: 'ingame', game: state }),
  };
  const match = seatMatch(NAMES);
  const pink = new BridgeSeat({ seat: { id: 'pink', name: 'Pink' }, client, match });
  pink.role = 'impostor';
  const memory = new EpisodicMemory();
  pink.attach({ memory });
  await pink.refresh();
  assert.equal(pink.alive, false);
  assert.deepEqual(pink.legalActions(), []);
  await pink.tick();
  assert.equal(pink.needs, null, 'no sabotage ready: nothing to decide');

  state.sabotage.cooldown = 0;
  await pink.tick();
  assert.equal(pink.needs, 'sabotage_ready');
  assert.deepEqual(pink.legalActions().map((a) => a.id), ['wait:15', 'sabotage:lights', 'sabotage:reactor', 'sabotage:o2', 'sabotage:comms']);
  const view = pink.view('sabotage_ready');
  assert.equal(view.dead, true);
  assert.match(roamPrompt(view, memory), /You are DEAD/);
  await pink.execute('sabotage:o2');
  assert.deepEqual(calls.at(-1), { do: 'sabotage', type: 'o2' });
  assert.equal(memory.entries.at(-1).kind, 'you_sabotaged');
  // The copy is not the host: its state still shows no sabotage for a moment. Live, the brain then
  // sent it again up to 5 times; now it counts as on until the copy shows it (3 s at most).
  assert.equal(state.sabotage.active, null);
  assert.deepEqual(pink.legalActions(), []);
  pink.needs = null;
  await pink.tick();
  assert.equal(pink.needs, null);

  // A dead crewmate's copy runs on autopilot: no choices and no wake-ups.
  const green = new BridgeSeat({ seat: { id: 'green', name: 'Green' }, client, match });
  green.role = 'crew';
  match.ledger.died('green');
  green.state = state;
  assert.deepEqual(green.legalActions(), []);
  green.wake('idle');
  assert.equal(green.needs, null);
});

test('names, chat length and launch arguments', () => {
  assert.equal(roomFromBridge('Comms'), 'Communications');
  assert.equal(roomFromBridge('Hallway'), null);
  assert.equal(roomToBridge('O2'), 'LifeSupp');
  assert.equal(colorId('pink'), 3);
  const long = `${'word '.repeat(40)}end`;
  const cut = fitChat(long);
  assert.ok(cut.length <= 100 && cut.endsWith('…') && !cut.includes('wor…'));
  assert.equal(fitChat('  short   text '), 'short text');
  const args = launchArgs({ id: 2, mode: 'join', name: 'Kimi', color: 'purple', token: TOKEN, port: 47002 });
  assert.ok(args.includes('--aub-mode=join') && args.includes('--aub-color=8') && args.includes('--aub-port=47002'));
  const b64 = args.find((a) => a.startsWith('--aub-nameb64=')).split('=')[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Kimi');
  assert.throws(() => new BridgeClient({ id: 1, token: 'short' }), /16 or more/);
});
