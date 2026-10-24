import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EpisodicMemory, appendLongTerm, loadLongTerm } from '../src/agents/memory.js';
import { matchAction, matchName, parseJson } from '../src/agents/agent.js';
import { SCHEMAS } from '../src/agents/prompts.js';

test('log lines carry the game time', () => {
  const m = new EpisodicMemory();
  m.observe(70, 'saw_player', 'Saw YELLOW standing still outside Electrical');
  assert.equal(m.renderLog(), '[01:10] Saw YELLOW standing still outside Electrical');
});

test('old routine lines become a route, old evidence is kept word for word', () => {
  const m = new EpisodicMemory();
  m.observe(5, 'arrived', 'Arrived at Admin', { room: 'Admin' });
  m.observe(9, 'saw_vent', 'Saw RED jump into a vent in Admin!!', { who: 'RED' });
  m.observe(12, 'lost_player', 'Lost sight of BLUE');
  m.observe(15, 'arrived', 'Arrived at Storage', { room: 'Storage' });
  for (let t = 20; t < 50; t++) m.observe(t, 'saw_player', `line ${t}`);
  const log = m.renderLog(10);
  assert.match(log, /route: Admin → Storage/);
  assert.match(log, /\[00:09\] Saw RED jump into a vent/);
  assert.doesNotMatch(log, /Lost sight of BLUE/);
  assert.match(log, /line 49/);
  assert.doesNotMatch(log, /line 20\b/);
});

test('evidence() pulls out who did what', () => {
  const m = new EpisodicMemory();
  m.observe(9, 'saw_vent', 'x', { who: 'RED' });
  m.observe(10, 'saw_kill', 'x', { killer: 'RED', victim: 'BLUE', room: 'Admin' });
  m.observe(11, 'saw_kill', 'x', { killer: null, victim: 'PINK', room: 'Admin' });
  assert.deepEqual(m.evidence().map((e) => `${e.kind}:${e.who}`), ['vent:RED', 'kill:RED']);
});

test('long-term memory keeps the newest entries first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-'));
  const seat = { id: 'claude', name: 'Claude' };
  for (let i = 1; i <= 10; i++) {
    appendLongTerm(dir, seat, { date: '2026-10-25', matchId: `m${i}`, role: 'crew', result: 'won', lesson: `lesson ${i}` });
  }
  const lines = loadLongTerm(dir, 'claude').split('\n');
  assert.equal(lines.length, 8);
  assert.match(lines[0], /lesson 10/);
  assert.match(lines[7], /lesson 3/);
});

test('sloppy action ids and names still resolve', () => {
  const legal = [{ id: 'move:Electrical' }, { id: 'move:LowerEngine' }, { id: 'kill:GPT' }, { id: 'wait:5' }];
  assert.equal(matchAction('move:Electrical', legal), 'move:Electrical');
  assert.equal(matchAction('Move: electrical', legal), 'move:Electrical');
  assert.equal(matchAction('kill:GPT  (kill GPT right now)', legal), 'kill:GPT');
  assert.equal(matchAction('fly:Mars', legal), null);
  assert.equal(matchName('I vote Claude Haiku', ['Claude', 'Claude Haiku'], ['skip']), 'Claude Haiku');
  assert.equal(matchName('SKIP', ['Claude'], ['skip']), 'skip');
});

test('JSON is read even when wrapped in a code fence', () => {
  const text = '```json\n{"secret_thought": "ok", "action": "wait:5", "note": ""}\n```';
  assert.deepEqual(parseJson(text, SCHEMAS.roam.schema), { secret_thought: 'ok', action: 'wait:5', note: '' });
  assert.equal(parseJson('{"secret_thought": "no action"}', SCHEMAS.roam.schema), null);
  assert.equal(parseJson('not json', SCHEMAS.roam.schema), null);
});
