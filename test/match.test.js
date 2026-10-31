import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../src/match/runner.js';
import { createProvider } from '../src/providers/index.js';
import { createMock } from '../src/providers/mock.js';
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/rng.js';

const COLORS = ['red', 'blue', 'green', 'pink', 'orange', 'yellow', 'cyan', 'purple'];
const SEATS = COLORS.map((c) => ({ id: c, name: c[0].toUpperCase() + c.slice(1), color: c, provider: 'mock', label: 'mock' }));

async function play(seed, { spy } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-match-'));
  const config = { seed, language: 'th', discussionRounds: 2, revealModels: true, persistentMemory: false, logPrompts: true, rules: { impostors: 2 } };
  const providers = new Map();
  for (const s of SEATS) {
    const p = await createProvider(s, { seed });
    providers.set(s.id, spy ? { complete: (req) => { spy(s.id, req.user); return p.complete(req); } } : p);
  }
  return runMatch({ config, seats: SEATS, providers, matchId: `test-${seed}`, dir, memoryDir: path.join(dir, 'memory') });
}

test('an 8-player mock match plays to the end and writes its files', async () => {
  const r = await play(7);
  assert.ok(['crew', 'impostor', 'none'].includes(r.winner));
  assert.ok(r.events.some((e) => e.type === 'decision'));
  assert.ok(fs.existsSync(path.join(r.dir, 'events.jsonl')));
  const stats = r.events.at(-1);
  assert.equal(stats.type, 'stats');
  assert.ok(Object.values(stats.seats).every((s) => s.calls > 0));
  const start = r.events.find((e) => e.type === 'match_start');
  assert.equal(start.players.filter((p) => p.role === 'impostor').length, 2);
  // Mock players talk on the ship; a line reaches exactly the players listed as hearing it.
  const says = r.events.filter((e) => e.type === 'say');
  assert.ok(says.length > 0);
  const nameOf = (id) => start.players.find((p) => p.id === id).name;
  for (const s of says) {
    for (const [id, a] of r.agents) {
      const who = s.anon.includes(id) ? null : nameOf(s.p);
      const got = a.memory.entries.some((m) => m.kind === 'heard' && m.t === s.t && m.data.text === s.text && m.data.who === who);
      assert.equal(got, s.heard.includes(id), `${id} and "${s.text}" at ${s.t}`);
    }
  }
});

test('the same seed replays the same match', async () => {
  // `ms` and the final stats carry wall-clock timings; everything else must match exactly.
  const strip = (r) => r.events.filter((e) => e.type !== 'stats').map(({ ms, ...e }) => JSON.stringify(e)).join('\n');
  const a = await play(11);
  const b = await play(11);
  assert.equal(a.winner, b.winner);
  assert.equal(strip(a), strip(b));
});

test('memories are separate: no prompt ever contains another player\'s secret thoughts', async () => {
  const prompts = new Map(SEATS.map((s) => [s.id, []]));
  const r = await play(3, { spy: (id, user) => prompts.get(id).push(user) });
  assert.ok(r.events.some((e) => e.type === 'chat'), 'the match should reach a meeting');
  for (const [id, list] of prompts) {
    const all = list.join('\n');
    for (const other of SEATS.map((s) => s.id).filter((x) => x !== id)) {
      assert.ok(!all.includes(`[mock:${other}#`), `${id} saw a thought of ${other}`);
    }
  }
  // ...while each player does get its own past thoughts back.
  assert.ok([...prompts].some(([id, list]) => list.some((u) => u.includes(`[mock:${id}#`))));
});

test('a mock crewmate asked a question during a reactor meltdown answers on the way to fix it', async () => {
  const seat = { id: 'blue', name: 'Blue' };
  const mock = createMock(seat, 1);
  const view = {
    t: 10, role: 'crew', reason: 'heard', room: 'Admin', visible: [{ name: 'Red' }], bodies: [],
    sabotage: { kind: 'reactor', secondsLeft: 30 }, legal: [{ id: 'fix' }, { id: 'task:wires' }, { id: 'move:Storage' }],
  };
  const evidence = [{ t: 10, kind: 'heard', who: 'Red', text: 'Blue ไปไหนมา', toMe: true }];
  const res = await mock.complete({ context: { kind: 'roam', view, evidence, seat, role: 'crew', partners: [] } });
  const out = JSON.parse(res.text);
  assert.equal(out.action, 'fix');
  assert.match(out.say, /ทำ task อยู่/);
});

test('a kill in the middle of a decision round wakes every witness, whatever their turn', async () => {
  // Everyone starts in Cafeteria and decides at 00:00. With no first cooldown the impostor kills at
  // once; witnesses later in the round must decide again instead of carrying out an older plan.
  const brain = {
    async complete({ context }) {
      const { kind, view, role } = context;
      const kill = view?.legal.find((a) => a.id.startsWith('kill:'))?.id;
      const action = role === 'impostor' && kill ? kill : 'wait:15';
      // Crewmates say out loud why they are deciding, so the log shows which plan was spoken.
      const out = kind === 'roam' ? { secret_thought: 'x', action, say: role === 'impostor' ? '' : `because ${view.reason}`, note: '' } : { secret_thought: 'x', chat_message: '', suspect: 'none', vote: 'skip', lesson: '' };
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-match-'));
  const config = { seed: 4, language: 'en', discussionRounds: 1, revealModels: true, persistentMemory: false, logPrompts: false, rules: { impostors: 1, firstKillCooldown: 0 } };
  const r = await runMatch({ config, seats: SEATS, providers: new Map(SEATS.map((s) => [s.id, brain])), matchId: 'test-round', dir, memoryDir: path.join(dir, 'memory') });

  const kill = r.events.find((e) => e.type === 'kill');
  assert.equal(kill.t, 0);
  const order = r.events.find((e) => e.type === 'thinking').players;
  assert.ok(order.indexOf(kill.killer) < order.length - 1, 'some witness must come after the killer in the round');
  const woken = r.events.filter((e) => e.type === 'decision' && e.t === 0 && e.seq > kill.seq && e.reason === 'saw_kill').map((e) => e.p);
  assert.deepEqual(woken.sort(), [...kill.witnesses].sort());
  // The plans made before the kill are logged but never carried out, nor said out loud.
  const stale = r.events.filter((e) => e.type === 'decision' && e.t === 0 && e.stale).map((e) => e.p);
  assert.deepEqual(stale.sort(), order.filter((id) => kill.witnesses.includes(id) && order.indexOf(id) > order.indexOf(kill.killer)).sort());
  const said = r.events.filter((e) => e.type === 'say' && e.t === 0 && stale.includes(e.p)).map((e) => `${e.p}: ${e.text}`);
  assert.deepEqual(said.sort(), stale.map((id) => `${id}: because saw_kill`).sort());
});

test('a second round in the same second sees what the first one changed', async () => {
  // Two impostors start in Cafeteria with the kill ready. The first kill drops the partner's plan; in
  // the next round at 00:00 the victim must be gone from every view, not standing there to be killed again.
  const views = [];
  const brain = {
    async complete({ context }) {
      const { kind, view, role, seat } = context;
      if (kind === 'roam') views.push({ who: seat.id, t: view.t, visible: view.visible.map((v) => v.name), legal: view.legal.map((a) => a.id) });
      const kill = view?.legal.find((a) => a.id.startsWith('kill:'))?.id;
      const out = kind === 'roam' ? { secret_thought: 'x', action: role === 'impostor' && kill ? kill : 'wait:15', note: '' } : { secret_thought: 'x', chat_message: '', suspect: 'none', vote: 'skip', lesson: '' };
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-match-'));
  const config = { seed: 4, language: 'en', discussionRounds: 1, revealModels: true, persistentMemory: false, logPrompts: false, rules: { impostors: 2, firstKillCooldown: 0 } };
  const r = await runMatch({ config, seats: SEATS, providers: new Map(SEATS.map((s) => [s.id, brain])), matchId: 'test-sight', dir, memoryDir: path.join(dir, 'memory') });

  const kills = r.events.filter((e) => e.type === 'kill');
  assert.equal(new Set(kills.map((k) => k.victim)).size, kills.length, 'a victim was killed twice');
  const victim = SEATS.find((s) => s.id === kills[0].victim).name;
  const seen = new Set();
  const again = views.filter((v) => v.t === kills[0].t && (seen.has(v.who) || !seen.add(v.who)));
  assert.ok(again.length > 0, 'nobody decided twice at the second of the first kill');
  for (const v of again) {
    assert.ok(!v.visible.includes(victim), `${v.who} still sees ${victim}`);
    assert.ok(!v.legal.includes(`kill:${victim}`) && !v.legal.includes(`follow:${victim}`), `${v.who} can still kill or follow ${victim}`);
  }
});

test('a player whose plan was dropped decides again before the clock moves', async () => {
  // Cee walks Cafeteria → MedBay → UpperEngine and finds Vic's body in MedBay at 00:21. In the same
  // round Imp2, earlier in seat order, sabotages the lights, so Cee's report is dropped as stale. Cee
  // must decide again at 00:21, still in MedBay, instead of walking on along the old route.
  const names = ['Imp', 'Imp2', 'Cee', 'Vic', 'Dee', 'Eve', 'Fay'];
  const seats = names.map((n, i) => ({ id: n.toLowerCase(), name: n, color: COLORS[i], provider: 'script', label: 'script' }));
  const rules = { impostors: 2, firstKillCooldown: 0, firstSabotageCooldown: 0, maxGameSeconds: 60 };
  const impostors = (seed) => new Game({ seats, rng: createRng(seed), rules }).players.filter((p) => p.role === 'impostor').map((p) => p.name).join();
  let seed = 0;
  for (; impostors(seed) !== 'Imp,Imp2'; seed++) assert.ok(seed < 5000, 'no seed makes Imp and Imp2 the impostors');

  const brain = {
    async complete({ context }) {
      const { kind, view, seat } = context;
      const has = (id) => view?.legal.some((a) => a.id === id);
      let action = 'wait:15';
      if (seat.name === 'Imp') action = view?.t === 0 ? 'move:MedBay' : has('kill:Vic') ? 'kill:Vic' : 'wait:15';
      if (seat.name === 'Imp2') action = view?.t === 0 ? 'move:Storage' : view?.t === 21 && has('sabotage:lights') ? 'sabotage:lights' : 'wait:5';
      if (seat.name === 'Vic' && view?.t === 0) action = 'move:MedBay';
      if (seat.name === 'Cee') action = has('report') ? 'report' : view?.t === 15 ? 'move:UpperEngine' : 'wait:15';
      const out = kind === 'roam' ? { secret_thought: 'x', action, note: '' } : { secret_thought: 'x', chat_message: '', suspect: 'none', vote: 'skip', lesson: '' };
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-match-'));
  const config = { seed, language: 'en', discussionRounds: 1, revealModels: true, persistentMemory: false, logPrompts: false, rules };
  const r = await runMatch({ config, seats, providers: new Map(seats.map((s) => [s.id, brain])), matchId: 'test-stale', dir, memoryDir: path.join(dir, 'memory') });

  const of = (type) => r.events.filter((e) => e.type === type);
  assert.deepEqual(of('sabotage').map((e) => [e.kind, e.by, e.t])[0], ['lights', 'imp2', 21]);
  assert.ok(of('decision').some((e) => e.p === 'cee' && e.t === 21 && e.stale && e.action === 'report'));
  assert.ok(!of('move').some((e) => e.p === 'cee' && e.from === 'MedBay'), 'Cee walked on along the old route');
  const meeting = of('meeting_start')[0];
  assert.deepEqual([meeting.caller, meeting.room, meeting.t], ['cee', 'MedBay', 21]);
});
