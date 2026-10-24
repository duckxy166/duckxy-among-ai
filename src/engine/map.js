// A Skeld-like ship drawn from scratch (no game assets). Room centres are viewer pixels on a
// 1200x720 board; walking time between two rooms is their distance / SPEED, in game seconds.

export const BOARD = { width: 1200, height: 720 };
export const SPEED = 50;

export const ROOMS = {
  UpperEngine: { x: 170, y: 150, w: 180, h: 120 },
  Reactor: { x: 70, y: 360, w: 100, h: 160 },
  Security: { x: 270, y: 360, w: 120, h: 100 },
  LowerEngine: { x: 170, y: 570, w: 180, h: 120 },
  MedBay: { x: 400, y: 250, w: 140, h: 110 },
  Cafeteria: { x: 620, y: 140, w: 260, h: 180 },
  Weapons: { x: 900, y: 140, w: 160, h: 120 },
  O2: { x: 850, y: 330, w: 120, h: 90 },
  Navigation: { x: 1110, y: 360, w: 150, h: 130 },
  Shields: { x: 940, y: 590, w: 150, h: 110 },
  Communications: { x: 760, y: 640, w: 150, h: 90 },
  Storage: { x: 560, y: 580, w: 180, h: 150 },
  Admin: { x: 720, y: 430, w: 160, h: 110 },
  Electrical: { x: 390, y: 500, w: 140, h: 110 },
};

export const ROOM_NAMES = Object.keys(ROOMS);

const CORRIDORS = [
  ['UpperEngine', 'MedBay'], ['MedBay', 'Cafeteria'], ['Cafeteria', 'Weapons'],
  ['Weapons', 'O2'], ['O2', 'Navigation'], ['Navigation', 'Shields'],
  ['Shields', 'Communications'], ['Communications', 'Storage'], ['Storage', 'Admin'],
  ['Admin', 'Cafeteria'], ['Cafeteria', 'Storage'], ['Storage', 'Electrical'],
  ['Electrical', 'LowerEngine'], ['LowerEngine', 'Reactor'], ['Reactor', 'UpperEngine'],
  ['UpperEngine', 'Security'], ['Security', 'LowerEngine'],
];

export const EDGES = CORRIDORS.map(([a, b]) => {
  const dist = Math.hypot(ROOMS[a].x - ROOMS[b].x, ROOMS[a].y - ROOMS[b].y);
  return { a, b, time: Math.max(2, Math.round(dist / SPEED)) };
});

// Each group is one vent network: an impostor in any of its rooms can pop out in any other.
export const VENT_GROUPS = [
  ['Weapons', 'Navigation'],
  ['Navigation', 'Shields'],
  ['Cafeteria', 'Admin'],
  ['MedBay', 'Security', 'Electrical'],
  ['Reactor', 'UpperEngine', 'LowerEngine'],
];

export const BUTTON_ROOM = 'Cafeteria';
export const SABOTAGE_ROOMS = { lights: 'Electrical', reactor: 'Reactor' };

// visual: other players see an animation, so watching one proves the doer is a crewmate.
export const TASKS = [
  { id: 'wires_elec', name: 'Fix Wiring', room: 'Electrical', dur: 4 },
  { id: 'wires_admin', name: 'Fix Wiring', room: 'Admin', dur: 4 },
  { id: 'swipe', name: 'Swipe Card', room: 'Admin', dur: 3 },
  { id: 'calibrate', name: 'Calibrate Distributor', room: 'Electrical', dur: 4 },
  { id: 'divert', name: 'Divert Power', room: 'Electrical', dur: 2 },
  { id: 'scan', name: 'Submit Scan', room: 'MedBay', dur: 10, visual: true },
  { id: 'sample', name: 'Inspect Sample', room: 'MedBay', dur: 6 },
  { id: 'asteroids', name: 'Clear Asteroids', room: 'Weapons', dur: 8, visual: true },
  { id: 'download', name: 'Download Data', room: 'Weapons', dur: 5 },
  { id: 'o2filter', name: 'Clean O2 Filter', room: 'O2', dur: 5 },
  { id: 'garbage', name: 'Empty Garbage', room: 'Storage', dur: 4, visual: true },
  { id: 'fuel', name: 'Fuel Engines', room: 'LowerEngine', dur: 4 },
  { id: 'align_up', name: 'Align Engine Output', room: 'UpperEngine', dur: 3 },
  { id: 'align_low', name: 'Align Engine Output', room: 'LowerEngine', dur: 3 },
  { id: 'reactor_start', name: 'Start Reactor', room: 'Reactor', dur: 8 },
  { id: 'manifolds', name: 'Unlock Manifolds', room: 'Reactor', dur: 4 },
  { id: 'chart', name: 'Chart Course', room: 'Navigation', dur: 3 },
  { id: 'steering', name: 'Stabilize Steering', room: 'Navigation', dur: 2 },
  { id: 'shields', name: 'Prime Shields', room: 'Shields', dur: 3, visual: true },
  { id: 'upload', name: 'Upload Data', room: 'Communications', dur: 5 },
];

export const COLORS = {
  red: '#c51111', blue: '#132ed1', green: '#117f2d', pink: '#ed54ba',
  orange: '#ef7d0d', yellow: '#f5f557', black: '#3f474e', white: '#d6e0f0',
  purple: '#6b2fbb', brown: '#71491e', cyan: '#38fedc', lime: '#50ef39',
};

export function edgeBetween(a, b) {
  return EDGES.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)) || null;
}

export function neighbours(room) {
  return EDGES.filter((e) => e.a === room || e.b === room).map((e) => ({
    room: e.a === room ? e.b : e.a,
    time: e.time,
  }));
}

export function ventExits(room) {
  const out = new Set();
  for (const g of VENT_GROUPS) if (g.includes(room)) g.forEach((r) => r !== room && out.add(r));
  return [...out];
}

// Dijkstra over corridors. Returns { rooms: [next, ..., to], time } or null.
export function shortestPath(from, to) {
  if (from === to) return { rooms: [], time: 0 };
  const dist = { [from]: 0 };
  const prev = {};
  const open = new Set([from]);
  while (open.size) {
    let cur = null;
    for (const r of open) if (cur === null || dist[r] < dist[cur]) cur = r;
    open.delete(cur);
    if (cur === to) break;
    for (const n of neighbours(cur)) {
      const d = dist[cur] + n.time;
      if (dist[n.room] === undefined || d < dist[n.room]) {
        dist[n.room] = d;
        prev[n.room] = cur;
        open.add(n.room);
      }
    }
  }
  if (dist[to] === undefined) return null;
  const rooms = [];
  for (let r = to; r !== from; r = prev[r]) rooms.unshift(r);
  return { rooms, time: dist[to] };
}
