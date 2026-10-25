// Names on the real Skeld. AUBridge speaks the game's own identifiers (SystemTypes, TaskTypes,
// colour ids); the brains, memory and viewer use the simulator's room names, so both bodies read the same.

import { ROOM_NAMES, COLORS } from '../engine/map.js';

const ROOM_TO_BRIDGE = { Navigation: 'Nav', O2: 'LifeSupp', Communications: 'Comms' };
const ROOM_FROM_BRIDGE = Object.fromEntries(Object.entries(ROOM_TO_BRIDGE).map(([a, b]) => [b, a]));

export const ROOMS_REAL = ROOM_NAMES;

export function roomToBridge(name) { return ROOM_TO_BRIDGE[name] ?? name; }

// null for corridors and for anything outside the simulator's 14 rooms.
export function roomFromBridge(id) {
  if (!id) return null;
  const name = ROOM_FROM_BRIDGE[id] ?? id;
  return ROOM_NAMES.includes(name) ? name : null;
}

// The colour ids 0-11 are in the same order as COLORS.
export function colorId(color) { return Object.keys(COLORS).indexOf(color); }

// "CalibrateDistributor" -> "Calibrate Distributor"
export function taskName(id) { return String(id ?? '').replace(/([a-z])([A-Z])/g, '$1 $2'); }

// AUBridge keeps 1-10 letters, digits, spaces, _ - . of a name; anything else would rename the player.
export function validRealName(name) { return /^[\p{L}\p{N} _.-]{1,10}$/u.test(name ?? ''); }

export const SABOTAGE_TYPES = ['lights', 'reactor', 'o2', 'comms'];
