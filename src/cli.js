#!/usr/bin/env node
// Among AI command line.
//   node src/cli.js run [--mock] [--serve] [--config file] [--seed n] [--seats n] [--port n]
//   node src/cli.js real [--mock] [--serve] [--config file] [--seats n] [--attach] [--keep-open]
//                                               the real Among Us through AUBridge (docs/REAL_GAME.md)
//   node src/cli.js replay [matchId] [--port n]
//   node src/cli.js check [--config file]       one tiny request per seat: keys, model ids, latency
//   node src/cli.js list
// Paths (.env, arena.config.json, matches/, memory/) are relative to the current directory, so the
// same CLI works from this repository and from a project that installs it (`npx among-ai`).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createProvider, missingKeys } from './providers/index.js';
import { runMatch } from './match/runner.js';
import { runBridgeMatch } from './bridge/runner.js';
import { openLobby, makeClients, newToken } from './bridge/launcher.js';
import { validRealName } from './bridge/skeld.js';
import { createHub, startServer, listMatches, readEvents } from './server/server.js';
import { SCHEMAS } from './agents/prompts.js';
import { FatalSeatError } from './agents/agent.js';

const ROOT = process.cwd();
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATCHES = path.join(ROOT, 'matches');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    mock: { type: 'boolean', default: false },
    serve: { type: 'boolean', default: false },
    seed: { type: 'string' },
    seats: { type: 'string' },
    port: { type: 'string', default: '7777' },
    attach: { type: 'boolean', default: false },
    'keep-open': { type: 'boolean', default: false },
  },
});
const [command = 'help', arg] = positionals;
const port = Number(opt.port);

function configPath() {
  if (opt.config) return path.resolve(opt.config);
  const own = path.join(ROOT, 'arena.config.json');
  if (fs.existsSync(own)) return own;
  console.log('No arena.config.json yet, using arena.config.example.json (copy it to make your own).');
  const example = path.join(ROOT, 'arena.config.example.json');
  return fs.existsSync(example) ? example : path.join(PACKAGE, 'arena.config.example.json');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Config, API keys, providers and the live viewer: the same for both bodies.
async function prepare(check = () => {}) {
  const { config, seats } = loadConfig(configPath(), {
    mock: opt.mock,
    seed: opt.seed !== undefined ? Number(opt.seed) : undefined,
    seats: opt.seats ? Number(opt.seats) : undefined,
  });
  check(config, seats);
  const keys = missingKeys(seats);
  keys.warnings.forEach((w) => console.warn(`warning: ${w} (the SDK will try \`ant auth login\` credentials)`));
  if (keys.errors.length) {
    console.error(`Missing API keys:\n- ${keys.errors.join('\n- ')}\nPut them in .env, disable those seats, or try --mock.`);
    process.exit(1);
  }

  const providers = new Map();
  for (const s of seats) providers.set(s.id, await createProvider(s, { seed: config.seed }));
  const matchId = `${stamp()}-${config.seed}`;
  const memoryDir = path.join(ROOT, 'memory', opt.mock ? 'mock' : '');

  let hub = null;
  if (opt.serve) {
    hub = createHub();
    await startServer({ port, matchesDir: MATCHES, hub });
    console.log(`Viewer (live): http://localhost:${port}/`);
  }
  console.log(`Match ${matchId}: ${seats.map((s) => `${s.name} [${s.label}]`).join(', ')}`);
  return {
    config, seats, providers, matchId, memoryDir, hub,
    dir: path.join(MATCHES, matchId),
    publish: hub ? hub.publish : undefined,
    log: (line) => console.log(line),
  };
}

async function finished(play, { matchId, hub }) {
  try {
    const result = await play();
    console.log(`\nLog:    ${path.join(result.dir, 'events.jsonl')}`);
    console.log(`Replay: node src/cli.js replay ${matchId}`);
  } catch (e) {
    if (!(e instanceof FatalSeatError)) throw e;
    console.error(`\nMatch stopped: ${e.message}\nCheck that seat's API key and model id (node src/cli.js check).`);
    process.exitCode = 1;
  }
  if (hub) console.log(`Viewer still running at http://localhost:${port}/ (Ctrl+C to quit)`);
}

async function run() {
  const m = await prepare();
  await finished(() => runMatch(m), m);
}

// The real game: one Among Us copy per seat, driven through AUBridge. Without --attach this opens
// the copies itself (bridge.gamePath in the config, or AMONG_US_EXE); with --attach it uses copies
// that are already in one lobby, on ports 47001.., started with the token in AUB_TOKEN.
async function real() {
  const m = await prepare((config, seats) => {
    const bad = seats.filter((s) => !validRealName(s.name)).map((s) => `"${s.name}"`);
    if (bad.length) {
      console.error(`Names in the real game are 1-10 letters, digits, spaces, _ - or . : rename ${bad.join(', ')}.`);
      process.exit(1);
    }
  });
  const bridge = m.config.bridge ?? {};
  const basePort = bridge.basePort ?? 47000;
  let lobby;
  if (opt.attach) {
    const token = process.env.AUB_TOKEN;
    if (!token) { console.error('--attach needs the copies\' token in AUB_TOKEN.'); process.exit(1); }
    lobby = { clients: makeClients(m.seats, { token, basePort }), close: () => {} };
  } else {
    lobby = await openLobby({
      gamePath: bridge.gamePath || process.env.AMONG_US_EXE, seats: m.seats, token: newToken(), basePort,
      joinDelayMs: bridge.joinDelayMs, sound: bridge.sound, window: bridge.window, log: m.log,
    });
  }
  try {
    await finished(() => runBridgeMatch({ ...m, clients: lobby.clients }), m);
  } finally {
    if (!opt['keep-open']) lobby.close();
  }
}

async function replay() {
  const ids = listMatches(MATCHES);
  const id = arg ?? ids[0];
  if (!id || !readEvents(MATCHES, id)) {
    console.error(id ? `No match "${id}" in matches/.` : 'No matches recorded yet. Try: npm run mock');
    process.exit(1);
  }
  await startServer({ port, matchesDir: MATCHES });
  console.log(`Replay: http://localhost:${port}/?replay=${id}   (Ctrl+C to quit)`);
}

async function check() {
  const { config, seats } = loadConfig(configPath(), { mock: opt.mock });
  const keys = missingKeys(seats);
  for (const s of seats) {
    const missing = keys.errors.find((e) => e.startsWith(`${s.name}:`));
    if (missing) { console.log(`✗ ${s.name.padEnd(12)} ${missing}`); continue; }
    const provider = await createProvider(s, { seed: config.seed });
    const started = Date.now();
    try {
      const res = await provider.complete({
        system: 'You are checking that the connection works.',
        user: 'Reply as JSON: {"secret_thought": "a few words", "ok": "yes"}',
        schema: SCHEMAS.ping.schema, schemaName: SCHEMAS.ping.name, effort: 'low',
        context: { kind: 'ping', seat: s },
      });
      console.log(`✓ ${s.name.padEnd(12)} ${s.provider}/${res.model} ${Date.now() - started}ms ${res.refused ? '(refused)' : res.text.slice(0, 80)}`);
    } catch (e) {
      console.log(`✗ ${s.name.padEnd(12)} ${s.provider}/${s.model}: ${e?.status ?? ''} ${e?.message ?? e}`);
    }
  }
}

function list() {
  const ids = listMatches(MATCHES);
  if (!ids.length) return console.log('No matches yet.');
  for (const id of ids) {
    const over = readEvents(MATCHES, id).find((e) => e.type === 'game_over');
    console.log(`${id}  ${over ? `${over.winner} (${over.reason})` : 'unfinished'}`);
  }
}

const commands = { run, real, replay, check, list };
if (!commands[command]) {
  console.log('Usage: node src/cli.js <run|real|replay|check|list> [--mock] [--serve] [--config file] [--seed n] [--seats n] [--port n] [--attach] [--keep-open]');
} else {
  await commands[command]();
}
