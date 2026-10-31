// The subscription providers (claude-code, codex, antigravity) against a fake CLI: no real CLI runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider, missingKeys } from '../src/providers/index.js';
import { SCHEMAS } from '../src/agents/prompts.js';
import { Agent, FatalSeatError } from '../src/agents/agent.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.js');
const DIALECT = { 'claude-code': 'claude', codex: 'codex', antigravity: 'agy' };

let n = 0;
function seat(provider, model = 'ok', extra = {}) {
  n++;
  return { id: `s${n}`, name: `Seat${n}`, color: 'red', provider, model, command: [process.execPath, FAKE, DIALECT[provider]], concurrency: 10, ...extra };
}
function logFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'among-ai-fakecli-')), 'log.jsonl');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
}
const ask = (provider, system = 'You are Seat, a player.', effort = 'low') => provider.complete({
  system, user: 'Pick a move.', schema: SCHEMAS.ping.schema, schemaName: SCHEMAS.ping.name, effort, context: { kind: 'ping' },
});

test('subscription seats need no API key', () => {
  const seats = Object.keys(DIALECT).map((p) => seat(p));
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.deepEqual(missingKeys(seats), { errors: [], warnings: [] });
  } finally {
    if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
  }
});

for (const provider of Object.keys(DIALECT)) {
  test(`${provider}: answers through the CLI with the system prompt and the schema`, async () => {
    const log = logFile();
    const p = await createProvider(seat(provider));
    const res = await ask(p, 'You are Rocket, an orange crewmate.\nSecond line.');
    const data = JSON.parse(res.text);
    assert.equal(data.ok, 'fake ok');
    assert.equal(data.secret_thought, 'system: You are Rocket, an orange crewmate.');
    assert.equal(res.refused, false);
    assert.deepEqual(res.usage, { input: 10, output: 5, cacheRead: 2 });
    const [call] = log();
    // Run outside the project, so no CLAUDE.md or AGENTS.md reaches the player.
    assert.equal(path.basename(call.cwd), 'among-ai-cli');
    assert.match(call.prompt, /matches this JSON Schema/);
  });

  test(`${provider}: a CLI that is not signed in stops the seat`, async () => {
    logFile();
    const agent = new Agent({ seat: seat(provider, 'auth'), role: 'crew', provider: await createProvider(seat(provider, 'auth')), system: 'x' });
    await assert.rejects(agent.ask('ping', 'hi', 'low', {}), FatalSeatError);
  });
}

test('claude-code: the API key is not passed on, so the subscription is used', async () => {
  const log = logFile();
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  try {
    await ask(await createProvider(seat('claude-code')));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  const [call] = log();
  assert.equal(call.hasAnthropicKey, false);
  assert.ok(call.args.includes('--tools') && call.args[call.args.indexOf('--tools') + 1] === '');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'low');
});

test('claude-code: the answer is used as soon as it streams, without waiting for the CLI to exit', async () => {
  logFile();
  const p = await createProvider(seat('claude-code'));
  const started = Date.now();
  await ask(p);
  // The fake exits 3 s after answering, like the real CLI's summary request.
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`);
});

test('a started process waits for the next call; a different effort starts a new one', async () => {
  const log = logFile();
  const p = await createProvider(seat('claude-code'));
  await ask(p);
  await new Promise((r) => setTimeout(r, 600));
  await ask(p);
  await ask(p, 'You are Seat, a player.', 'medium');
  const calls = log();
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.pid)).size, 3);
  // The second call went to the process started during the first one, so it had waited already.
  assert.ok(calls[1].waitedMs >= 500, `waited ${calls[1].waitedMs}ms`);
  assert.equal(calls[2].args[calls[2].args.indexOf('--effort') + 1], 'medium');
});

test('codex: the system prompt goes in front of the prompt and effort is a config override', async () => {
  const log = logFile();
  await ask(await createProvider(seat('codex')), 'Rules of the game.', 'high');
  const [call] = log();
  assert.ok(call.prompt.startsWith('Rules of the game.\n\n---\n\n'));
  assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.ok(call.args.includes('--ephemeral'));
});

test('claude-code: a turn declined by the safeguards is a refusal, not an error', async () => {
  logFile();
  const res = await ask(await createProvider(seat('claude-code', 'refuse')));
  assert.equal(res.refused, true);
});

test('a CLI that crashes or hangs is an error, not a fatal seat', async () => {
  logFile();
  await assert.rejects(ask(await createProvider(seat('claude-code', 'crash'))), /exited \(3\) without an answer.*fake crash/);
  await assert.rejects(ask(await createProvider(seat('antigravity', 'hang', { timeoutMs: 500 }))), /no answer after 0.5s/);
});

test('a missing CLI says how to fix it and stops the seat', async () => {
  const s = { ...seat('claude-code'), command: 'among-ai-no-such-cli' };
  const err = await ask(await createProvider(s)).catch((e) => e);
  assert.equal(err.status, 404);
  assert.match(err.message, /not found/);
});

test('claude-code: a usage warning from the subscription is shown once', async () => {
  logFile();
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const p = await createProvider(seat('claude-code', 'limit'));
    await ask(p);
    await ask(p);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /allowed_warning \(five_hour 91%\)/);
});
