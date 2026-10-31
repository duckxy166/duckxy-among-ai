// Opens the game copies for a real-game match: copy 1 hosts a local lobby, the others join it.
// AUBridge does the clicking (--aub-mode=host|join). Local (LAN) lobbies only, never official servers.
// The token is made fresh for each run and goes only to the copies' command lines.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeClient } from './client.js';
import { colorId } from './skeld.js';
import { sleep, until } from './seat.js';

export const newToken = () => crypto.randomBytes(16).toString('hex');

// Copy n listens on basePort + n, the AUBridge default when basePort is 47000.
export function makeClients(seats, { token, basePort = 47000 }) {
  return new Map(seats.map((s, i) => [s.id, new BridgeClient({ id: i + 1, port: basePort + i + 1, token })]));
}

// window: "1920x1080" opens the copy windowed and borderless at that size; sound: a bot copy plays its
// sound anyway. Both are for recording every copy on its own (studio docs).
export function launchArgs({ id, mode, name, color, token, port, mute = true, sound = false, window = null }) {
  const args = [
    `--aub-id=${id}`, `--aub-mode=${mode}`, `--aub-nameb64=${Buffer.from(name, 'utf8').toString('base64')}`,
    `--aub-color=${colorId(color)}`, `--aub-mute=${mute ? 1 : 0}`, `--aub-token=${token}`, `--aub-port=${port}`,
  ];
  if (sound) args.push('--aub-sound=1');
  const size = /^(\d+)x(\d+)$/.exec(window ?? '');
  if (size) args.push(`--aub-window=${window}`, '-screen-width', size[1], '-screen-height', size[2], '-screen-fullscreen', '0', '-popupwindow');
  return args;
}

export async function openLobby({ gamePath, seats, token, basePort = 47000, joinDelayMs = 4000, mute = true, sound = false, window = null, log = () => {} }) {
  if (!gamePath || !fs.existsSync(gamePath)) throw new Error(`Among Us.exe not found: ${gamePath || '(bridge.gamePath is empty)'}`);
  const clients = makeClients(seats, { token, basePort });
  const procs = [];
  const open = (i, mode) => {
    const s = seats[i];
    const args = launchArgs({ id: i + 1, mode, name: s.name, color: s.color, token, port: basePort + i + 1, mute, sound, window });
    procs.push(spawn(gamePath, args, { cwd: path.dirname(gamePath), stdio: 'ignore' }));
  };
  const close = () => { for (const p of procs) { try { p.kill(); } catch { /* already gone */ } } };
  const host = clients.get(seats[0].id);

  try {
    open(0, 'host');
    log(`Copy 1 (${seats[0].name}) is opening a local lobby...`);
    if (!(await until(async () => (await host.state()).stage === 'lobby', 150000, 2000))) {
      throw new Error('the host copy did not reach its lobby in 150s');
    }
    for (let i = 1; i < seats.length; i++) {
      open(i, 'join');
      await sleep(joinDelayMs);
    }
    log(`${seats.length - 1} copies are joining...`);
    const full = await until(async () => ((await host.state()).players ?? []).length >= seats.length, 60000 + seats.length * 20000, 2000);
    if (!full) throw new Error(`only ${((await host.state()).players ?? []).length} of ${seats.length} copies reached the lobby`);
    // A joiner's name shows up a moment after it joins.
    await until(async () => ((await host.state()).players ?? []).every((p) => p.name), 15000, 1000);
  } catch (e) {
    close();
    throw e;
  }
  return { clients, close };
}
