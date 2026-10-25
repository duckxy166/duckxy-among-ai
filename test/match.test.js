import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../src/match/runner.js';
import { createProvider } from '../src/providers/index.js';

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
