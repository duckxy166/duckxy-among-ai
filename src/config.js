// arena.config.json: the match settings and the seats (one seat = one player = one model).

import fs from 'node:fs';
import { COLORS } from './engine/map.js';
import { PRESETS } from './providers/index.js';
import { randomSeed } from './rng.js';

const DEFAULTS = {
  language: 'th',
  seed: null,
  discussionRounds: 2,
  revealModels: true,
  persistentMemory: true,
  logPrompts: true,
  rules: {},
};

const RESERVED = new Set(['skip', 'none']);

export function loadConfig(file, { mock = false, seed, seats: seatLimit } = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { seats: rawSeats = [], ...rest } = raw;
  const config = { ...DEFAULTS, ...rest, rules: { ...(raw.rules ?? {}) } };
  for (const k of Object.keys(config)) if (k.startsWith('_')) delete config[k];
  if (seed !== undefined) config.seed = seed;
  if (config.seed === null || config.seed === undefined) config.seed = randomSeed();

  let seats = rawSeats.filter((s) => s.enabled !== false);
  if (seatLimit) seats = seats.slice(0, seatLimit);
  seats = seats.map(({ _comment, ...s }) => ({ ...s, label: s.label ?? s.model ?? s.provider }));
  if (mock) seats = seats.map((s) => ({ ...s, provider: 'mock', label: `${s.label} (mock)` }));
  validate(config, seats);
  return { config, seats };
}

function validate(config, seats) {
  const errors = [];
  if (seats.length < 4 || seats.length > 10) errors.push(`a match needs 4 to 10 seats, this config has ${seats.length}`);
  if (!Number.isInteger(config.discussionRounds) || config.discussionRounds < 1) errors.push('discussionRounds must be 1 or more');
  const taken = { id: new Set(), name: new Set(), color: new Set() };
  for (const s of seats) {
    const who = `seat "${s.id ?? s.name ?? '?'}"`;
    if (!/^[a-z0-9_-]{1,32}$/i.test(s.id ?? '')) errors.push(`${who}: id must be 1-32 letters, digits, - or _`);
    if (!s.name || s.name.length > 16) errors.push(`${who}: name must be 1-16 characters`);
    if (RESERVED.has(String(s.name).toLowerCase())) errors.push(`${who}: "${s.name}" is a reserved word`);
    if (!COLORS[s.color]) errors.push(`${who}: colour "${s.color}" is not one of ${Object.keys(COLORS).join(', ')}`);
    if (!PRESETS[s.provider]) errors.push(`${who}: provider "${s.provider}" is not one of ${Object.keys(PRESETS).join(', ')}`);
    if (s.provider !== 'mock' && !s.model) errors.push(`${who}: model is required`);
    for (const k of Object.keys(taken)) {
      const v = String(s[k] ?? '').toLowerCase();
      if (taken[k].has(v)) errors.push(`${who}: duplicate ${k} "${s[k]}"`);
      taken[k].add(v);
    }
  }
  if (errors.length) throw new Error(`Bad config:\n- ${errors.join('\n- ')}`);
}
