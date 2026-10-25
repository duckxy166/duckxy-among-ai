// The simulated match: the "body" of every player. It moves people one game second at a time,
// decides who can see what, and writes each player's own observations. Brains never read this
// state directly; they get `view(id)` and their memory log, nothing else.

import {
  ROOM_NAMES, BUTTON_ROOM, SABOTAGE_ROOMS, TASKS, edgeBetween, shortestPath, ventExits,
} from './map.js';
import { say } from '../i18n.js';

export const DEFAULT_RULES = {
  impostors: null, // null: 1 impostor up to 6 players, 2 above
  tasksPerPlayer: 5,
  killCooldown: 25,
  firstKillCooldown: 12,
  sabotageCooldown: 30,
  firstSabotageCooldown: 15,
  lightsFixTime: 3,
  reactorDeadline: 40,
  emergencyCooldown: 15,
  emergenciesPerPlayer: 1,
  confirmEjects: true,
  maxGameSeconds: 900,
  doorwaySeconds: 1.5, // how long someone stays visible from the room they just left
  followSeconds: 20,
  talkWakeSeconds: 5, // a spoken line wakes the same listener at most this often
  replySeconds: 20, // a line from someone you just spoke to counts as their answer to you
};

const sameCorridor = (a, b) =>
  (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);

// The names out of `names` that `text` calls. Latin letters around a name make it part of another
// word ("covered" is not "Red"); Thai written right after it ("Redไปไหน") still counts. Longer names
// are matched first and taken out, so "Claude Haiku" does not also call "Claude".
export function namesIn(text, names) {
  let rest = String(text ?? '');
  const called = new Set();
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rest = rest.replace(new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'gi'), () => {
      called.add(name);
      return ' ';
    });
  }
  return called;
}

export class Game {
  constructor({ seats, rng, rules = {}, language = 'th' }) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.lang = language;
    this.t = 0;
    this.phase = 'roam';
    this.winner = null;
    this.reason = null;
    this.out = [];
    this.bodies = [];
    this.sabotage = null;
    this.sabotageCd = this.rules.firstSabotageCooldown;
    this.emergencyCd = 0;
    this.meeting = null;
    this.meetingCount = 0;
    this.publicDead = new Set();
    this.talkWakes = new Set();

    const n = seats.length;
    const impostors = this.rules.impostors ?? (n <= 6 ? 1 : 2);
    const picked = new Set(rng.shuffle([...Array(n).keys()]).slice(0, impostors));
    this.players = seats.map((s, i) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      role: picked.has(i) ? 'impostor' : 'crew',
      alive: true,
      room: BUTTON_ROOM,
      edge: null,
      intent: null,
      busy: null,
      tasks: rng.shuffle(TASKS).slice(0, this.rules.tasksPerPlayer).map((t) => ({ ...t, done: false })),
      killCd: this.rules.firstKillCooldown,
      emergencies: this.rules.emergenciesPerPlayer,
      needs: 'start',
      seen: new Map(),
      seenBodies: new Set(),
      opportunity: '',
      movedAt: -1,
      arrivedAt: -1,
      talkWokeAt: -Infinity,
      spokeTo: new Map(), // listener id -> when this player last named them out loud
    }));
  }

  // ---------------------------------------------------------------- queries

  byId(id) { return this.players.find((p) => p.id === id); }
  byName(name) {
    const n = String(name ?? '').trim().toLowerCase();
    return this.players.find((p) => p.name.toLowerCase() === n || p.id.toLowerCase() === n);
  }
  living() { return this.players.filter((p) => p.alive); }
  where(p) { return p.room ?? `${p.edge.from}→${p.edge.to}`; }

  taskBar() {
    let done = 0;
    let total = 0;
    for (const p of this.players) {
      if (p.role !== 'crew') continue;
      total += p.tasks.length;
      done += p.tasks.filter((t) => t.done).length;
    }
    return { done, total };
  }

  pendingDecisions() {
    return this.phase === 'roam' ? this.living().filter((p) => p.needs) : [];
  }

  // Who `viewer` can see right now: null, 'named', or 'anon' (a shadow in the dark).
  canSee(viewer, other) {
    if (!viewer.alive || !other.alive || viewer === other) return null;
    const dark = this.sabotage?.kind === 'lights' && viewer.role === 'crew';
    if (viewer.room && other.room) return viewer.room === other.room ? (dark ? 'anon' : 'named') : null;
    if (dark) return null;
    if (viewer.edge && other.edge) return sameCorridor(viewer.edge, other.edge) ? 'named' : null;
    const still = viewer.room ? viewer : other;
    const walking = viewer.room ? other : viewer;
    const e = walking.edge;
    const d = this.rules.doorwaySeconds;
    if (e.from === still.room && e.elapsed <= d) return 'named';
    if (e.to === still.room && e.dur - e.elapsed <= d) return 'named';
    return null;
  }

  bodiesVisible(p) {
    return p.alive && p.room ? this.bodies.filter((b) => b.room === p.room) : [];
  }

  watchers(p) {
    return this.living().filter((w) => w !== p && this.canSee(w, p) === 'named');
  }

  doing(o) {
    if (o.edge) return `walking to ${o.edge.to}`;
    if (o.busy?.kind === 'fix') return 'fixing lights';
    if (o.busy) return 'doing a task';
    return 'standing';
  }

  emergencyBlocked(p) {
    if (p.emergencies <= 0) return 'no emergency meetings left';
    if (this.emergencyCd > 0) return `button cooling down (${this.emergencyCd}s)`;
    if (this.sabotage?.kind === 'reactor') return 'cannot call a meeting during a reactor meltdown';
    return null;
  }

  // Everything one brain is allowed to know right now.
  view(id) {
    const p = this.byId(id);
    const visible = [];
    let shadows = 0;
    for (const [oid, s] of p.seen) {
      if (s === 'anon') { shadows++; continue; }
      const o = this.byId(oid);
      visible.push({ name: o.name, where: this.where(o), doing: this.doing(o) });
    }
    const s = this.sabotage;
    return {
      t: this.t,
      you: p.name,
      role: p.role,
      location: this.where(p),
      room: p.room,
      walking: !!p.edge,
      reason: p.needs,
      visible,
      shadows,
      bodies: this.bodiesVisible(p).map((b) => this.byId(b.id).name),
      lightsOut: s?.kind === 'lights',
      sabotage: s ? { kind: s.kind, secondsLeft: s.deadline ? s.deadline - this.t : null } : null,
      tasks: p.tasks.map((t) => ({ id: t.id, name: t.name, room: t.room, done: t.done, visual: !!t.visual })),
      taskBar: this.taskBar(),
      partners: p.role === 'impostor'
        ? this.players.filter((o) => o.role === 'impostor' && o !== p).map((o) => o.name) : [],
      killCooldown: p.killCd,
      sabotageCooldown: this.sabotageCd,
      vents: p.role === 'impostor' && p.room ? ventExits(p.room) : [],
      knownDead: [...this.publicDead].map((d) => this.byId(d).name),
      emergencies: p.emergencies,
      legal: this.legalActions(id),
    };
  }

  legalActions(id) {
    const p = this.byId(id);
    if (!p?.alive || this.phase !== 'roam') return [];
    const here = p.room ?? p.edge.to; // a walker finishes the corridor before a new plan starts
    const lead = p.edge ? p.edge.dur - p.edge.elapsed : 0;
    const eta = (room) => lead + (shortestPath(here, room)?.time ?? 0);
    const acts = [];
    const add = (aid, label) => acts.push({ id: aid, label });

    add('wait:5', 'stay where you are for 5s');
    add('wait:15', 'stay where you are for 15s');
    for (const r of ROOM_NAMES) if (r !== p.room) add(`move:${r}`, `walk to ${r} (~${eta(r)}s)`);
    const verb = p.role === 'impostor' ? 'fake' : 'task';
    for (const t of p.tasks.filter((x) => !x.done)) {
      const what = verb === 'fake' ? 'pretend to do' : 'do';
      add(`${verb}:${t.id}`, `${what} ${t.name} @ ${t.room} (~${eta(t.room)}s away, takes ${t.dur}s${t.visual ? ', visual task' : ''})`);
    }
    for (const [oid, s] of p.seen) {
      if (s === 'named') add(`follow:${this.byId(oid).name}`, `follow ${this.byId(oid).name} for up to ${this.rules.followSeconds}s`);
    }
    const bodies = this.bodiesVisible(p);
    if (bodies.length) add('report', `report the body of ${bodies.map((b) => this.byId(b.id).name).join(', ')}`);
    if (!this.emergencyBlocked(p)) {
      add('emergency', `walk to the ${BUTTON_ROOM} button and call a meeting (~${eta(BUTTON_ROOM)}s, ${p.emergencies} left)`);
    }
    if (this.sabotage) {
      const room = SABOTAGE_ROOMS[this.sabotage.kind];
      const two = this.sabotage.kind === 'reactor' ? ', needs 2 players there at once' : '';
      add('fix', `fix ${this.sabotage.kind} @ ${room} (~${eta(room)}s${two})`);
    }
    if (p.role === 'impostor') {
      if (p.room && p.killCd <= 0) {
        for (const [oid, s] of p.seen) {
          const o = this.byId(oid);
          if (s === 'named' && o.role !== 'impostor' && o.room === p.room) add(`kill:${o.name}`, `kill ${o.name} right now`);
        }
      }
      if (p.room) for (const r of ventExits(p.room)) add(`vent:${r}`, `vent to ${r} (instant; anyone watching sees it)`);
      if (!this.sabotage && this.sabotageCd <= 0) {
        add('sabotage:lights', 'sabotage lights (crewmates lose colours and range)');
        add('sabotage:reactor', `sabotage reactor (crew must fix it within ${this.rules.reactorDeadline}s or you win)`);
      }
    }
    return acts;
  }

  // ---------------------------------------------------------------- events

  emit(evt) { this.out.push({ t: this.t, ...evt }); }
  drain() { const o = this.out; this.out = []; return o; }

  // One line in one player's memory log. `interrupt` wakes the brain up for a new decision.
  note(p, kind, key, vars = {}, { interrupt = false, data } = {}) {
    if (!p.alive) return;
    this.emit({ type: 'obs', p: p.id, kind, text: say(this.lang, key, vars), data });
    if (interrupt) p.needs = kind;
  }

  reject(p, action, reason) {
    this.note(p, 'rejected', 'rejected', { action, reason });
  }

  // ---------------------------------------------------------------- the clock

  start() {
    this.emit({ type: 'roam_start' });
    this.emit({ type: 'taskbar', ...this.taskBar() });
    for (const p of this.living()) this.look(p, 'arrive');
  }

  step() {
    if (this.phase !== 'roam') return;
    this.t += 1;
    for (const p of this.players) if (p.killCd > 0) p.killCd -= 1;
    if (this.sabotageCd > 0) this.sabotageCd -= 1;
    if (this.emergencyCd > 0) this.emergencyCd -= 1;
    for (const id of this.talkWakes) {
      const l = this.byId(id);
      if (l.alive && !l.needs) l.needs = 'heard';
    }
    this.talkWakes.clear();

    const arrived = new Set();
    for (const p of this.players) {
      if (!p.alive && p.role === 'impostor') continue; // an ejected impostor only watches
      if (p.edge) {
        p.edge.elapsed += 1;
        if (p.edge.elapsed >= p.edge.dur) {
          p.room = p.edge.to;
          p.edge = null;
          p.arrivedAt = this.t;
          arrived.add(p);
          this.emit({ type: 'arrive', p: p.id, room: p.room, ghost: !p.alive });
        }
        continue;
      }
      if (p.busy) this.tickBusy(p);
      else if (p.intent) this.advanceIntent(p);
      else if (!p.alive) this.ghostPlan(p);
      if (this.phase !== 'roam') return; // an emergency button press starts a meeting mid-loop
    }
    this.tickSabotage();
    if (this.phase !== 'roam') return;
    for (const p of this.living()) this.look(p, arrived.has(p) ? 'arrive' : 'diff');
    this.checkOpportunities();
    this.checkWin();
  }

  // Compare what `v` sees now with last second and write the differences to their memory.
  look(v, mode) {
    const now = new Map();
    for (const o of this.players) {
      const s = this.canSee(v, o);
      if (s) now.set(o.id, s);
    }
    if (mode === 'arrive') {
      const named = [...now].filter(([, s]) => s === 'named').map(([id]) => this.byId(id).name);
      const anon = [...now.values()].filter((s) => s === 'anon').length;
      const parts = [...named];
      if (anon) parts.push(say(this.lang, 'shadows', { n: anon }));
      const who = parts.length ? say(this.lang, 'who_list', { list: parts.join(', ') }) : say(this.lang, 'who_none');
      this.note(v, 'arrived', 'arrived', { room: v.room, who }, { data: { room: v.room, saw: named } });
    } else if (mode === 'diff') {
      for (const [id, s] of now) {
        if (s === 'anon' || v.seen.get(id) === s) continue;
        const o = this.byId(id);
        const data = { who: o.name, room: v.room ?? null };
        if (v.room && o.room === v.room && o.arrivedAt === this.t) {
          this.note(v, 'saw_player', 'entered', { name: o.name, room: v.room }, { data });
        } else if (v.edge && o.edge) {
          this.note(v, 'saw_player', 'passed', { name: o.name, a: v.edge.from, b: v.edge.to }, { data });
        } else {
          this.note(v, 'saw_player', 'spotted', { name: o.name, where: this.where(o) }, { data });
        }
      }
      // Walking out of a room makes everyone in it disappear; that is not news.
      for (const [id, s] of v.movedAt === this.t ? [] : v.seen) {
        if (now.has(id) || s === 'anon') continue;
        const o = this.byId(id);
        if (!o.alive || !v.room) continue;
        if (o.edge && o.edge.from === v.room) {
          this.note(v, 'lost_player', 'left_toward', { name: o.name, room: v.room, to: o.edge.to }, { data: { who: o.name, to: o.edge.to } });
        } else {
          this.note(v, 'lost_player', 'lost', { name: o.name }, { data: { who: o.name } });
        }
      }
    }
    v.seen = now;
    for (const b of this.bodiesVisible(v)) {
      if (v.seenBodies.has(b.id)) continue;
      v.seenBodies.add(b.id);
      const name = this.byId(b.id).name;
      this.note(v, 'saw_body', 'body', { name, room: b.room }, { interrupt: true, data: { body: name, room: b.room } });
    }
  }

  checkOpportunities() {
    for (const p of this.living()) {
      if (p.role !== 'impostor' || !p.room || p.killCd > 0) { p.opportunity = ''; continue; }
      const others = [...p.seen.keys()].map((id) => this.byId(id)).filter((o) => o.role !== 'impostor');
      const target = others.length === 1 && others[0].room === p.room ? others[0] : null;
      if (!target) { p.opportunity = ''; continue; }
      const key = `${p.room}:${target.id}`;
      if (p.opportunity === key) continue;
      p.opportunity = key;
      this.note(p, 'opportunity', 'opportunity', { name: target.name, room: p.room }, { interrupt: true, data: { who: target.name } });
    }
  }

  checkWin() {
    if (this.phase === 'over') return;
    const imps = this.living().filter((p) => p.role === 'impostor').length;
    const crew = this.living().filter((p) => p.role === 'crew').length;
    const bar = this.taskBar();
    if (imps === 0) return this.end('crew', 'ejected');
    if (imps >= crew) return this.end('impostor', 'outnumbered');
    if (bar.total && bar.done >= bar.total) return this.end('crew', 'tasks');
    if (this.t >= this.rules.maxGameSeconds) return this.end('none', 'timeout');
  }

  end(winner, reason) {
    this.phase = 'over';
    this.winner = winner;
    this.reason = reason;
    this.emit({ type: 'game_over', winner, reason, roles: Object.fromEntries(this.players.map((p) => [p.id, p.role])) });
  }

  // ---------------------------------------------------------------- orders from a brain

  act(id, actionId) {
    const p = this.byId(id);
    if (!p?.alive || this.phase !== 'roam') return { ok: false, error: 'not playing right now' };
    p.needs = null;
    if (!this.legalActions(id).some((a) => a.id === actionId)) {
      this.reject(p, actionId, 'not a legal action right now');
      p.intent = { kind: 'wait', left: 2 };
      return { ok: false, error: 'illegal action' };
    }
    const cut = actionId.indexOf(':');
    const verb = cut < 0 ? actionId : actionId.slice(0, cut);
    const arg = cut < 0 ? '' : actionId.slice(cut + 1);
    // A new order replaces whatever the body was doing; the same job (asked again after a wake-up) carries on.
    const same = p.busy && (p.busy.kind === 'fix' ? verb === 'fix' : p.busy.kind === verb && p.busy.task === arg);
    if (!same) p.busy = null;
    this.emit({ type: 'intent', p: p.id, action: actionId });
    switch (verb) {
      case 'wait': p.intent = { kind: 'wait', left: Number(arg) }; break;
      case 'move': p.intent = { kind: 'move', room: arg }; break;
      case 'task':
      case 'fake': p.intent = { kind: verb, task: arg }; break;
      case 'follow': p.intent = { kind: 'follow', target: this.byName(arg).id, left: this.rules.followSeconds }; break;
      case 'fix': p.intent = { kind: 'fix' }; break;
      case 'emergency': p.intent = { kind: 'emergency' }; break;
      case 'report':
        p.intent = null;
        this.startMeeting(p.id, this.bodiesVisible(p)[0].id);
        break;
      case 'kill': this.kill(p, this.byName(arg)); p.intent = { kind: 'wait', left: 1 }; break;
      case 'vent': this.vent(p, arg); p.intent = { kind: 'wait', left: 1 }; break;
      case 'sabotage': this.sabotageNow(p, arg); p.intent = { kind: 'wait', left: 1 }; break;
    }
    return { ok: true };
  }

  finish(p) {
    p.intent = null;
    if (p.alive && !p.needs) p.needs = 'idle';
  }

  advanceIntent(p) {
    const it = p.intent;
    switch (it.kind) {
      case 'wait':
        if (--it.left <= 0) this.finish(p);
        return;
      case 'move':
        if (p.room === it.room) return this.finish(p);
        return this.walkToward(p, it.room);
      case 'task':
      case 'fake': {
        const task = p.tasks.find((x) => x.id === it.task);
        if (!task || task.done) return this.finish(p);
        if (p.room !== task.room) return this.walkToward(p, task.room);
        return this.startBusy(p, it.kind, task);
      }
      case 'fix': {
        if (!this.sabotage) return this.finish(p);
        const room = SABOTAGE_ROOMS[this.sabotage.kind];
        if (p.room !== room) return this.walkToward(p, room);
        if (this.sabotage.kind === 'lights') return this.startBusy(p, 'fix', null);
        return; // reactor: hold the panel; tickSabotage counts the hands
      }
      case 'emergency': {
        if (p.room !== BUTTON_ROOM) return this.walkToward(p, BUTTON_ROOM);
        const why = this.emergencyBlocked(p);
        if (why) { this.reject(p, 'emergency', why); return this.finish(p); }
        p.emergencies -= 1;
        p.intent = null;
        return this.startMeeting(p.id, null);
      }
      case 'follow': {
        const o = this.byId(it.target);
        if (--it.left <= 0 || !o.alive) return this.finish(p);
        if (!this.canSee(p, o)) {
          p.intent = null;
          return this.note(p, 'lost_sight', 'lost_follow', { name: o.name }, { interrupt: true });
        }
        if (o.room === p.room) return;
        const dest = o.room ?? o.edge.to;
        if (dest !== p.room) this.walkToward(p, dest);
        return;
      }
    }
  }

  walkToward(p, dest) {
    const path = shortestPath(p.room, dest);
    if (!path?.rooms.length) return this.finish(p);
    const next = path.rooms[0];
    const dur = edgeBetween(p.room, next).time;
    p.edge = { from: p.room, to: next, elapsed: 0, dur };
    p.room = null;
    p.movedAt = this.t;
    this.emit({ type: 'move', p: p.id, from: p.edge.from, to: next, dur, ghost: !p.alive });
  }

  startBusy(p, kind, task) {
    const dur = kind === 'fix' ? this.rules.lightsFixTime : task.dur;
    p.busy = { kind, task: task?.id, left: dur };
    const visual = kind === 'task' && !!task.visual;
    this.emit({ type: 'task_start', p: p.id, kind, task: task?.name ?? 'lights', room: p.room, visual, dur, ghost: !p.alive });
    if (!p.alive) return;
    for (const w of this.watchers(p)) {
      const data = { who: p.name, room: p.room };
      if (kind === 'fix') this.note(w, 'saw_fix', 'fixing', { name: p.name, what: 'lights', room: p.room }, { data });
      else if (visual) this.note(w, 'saw_task_visual', 'task_visual', { name: p.name, task: task.name, room: p.room }, { data: { ...data, proof: true } });
      else if (task.visual) this.note(w, 'saw_task_fake', 'task_fake_visual', { name: p.name, task: task.name, room: p.room }, { data: { ...data, fake: true } });
      else this.note(w, 'saw_task', 'task_seen', { name: p.name, room: p.room }, { data });
    }
  }

  tickBusy(p) {
    const b = p.busy;
    if (b.kind === 'fix' && this.sabotage?.kind !== 'lights') { p.busy = null; return this.finish(p); }
    if (--b.left > 0) return;
    p.busy = null;
    if (b.kind === 'fix') { this.fixSabotage([p]); return this.finish(p); }
    const task = p.tasks.find((x) => x.id === b.task);
    task.done = true; // for an impostor this only crosses the task off their cover story
    if (b.kind === 'task') {
      this.emit({ type: 'task_done', p: p.id, task: task.name, room: p.room, ghost: !p.alive });
      this.emit({ type: 'taskbar', ...this.taskBar() });
      const mine = p.tasks.filter((x) => x.done).length;
      this.note(p, 'task_done', 'task_done', { task: task.name, room: p.room, done: mine, total: p.tasks.length });
    } else {
      this.note(p, 'fake_done', 'fake_done', { task: task.name, room: p.room });
    }
    this.finish(p);
  }

  // Dead crewmates keep doing their tasks as ghosts, on autopilot (no brain, no cost).
  ghostPlan(p) {
    if (p.role !== 'crew') return;
    const next = p.tasks.find((x) => !x.done);
    if (next) p.intent = { kind: 'task', task: next.id };
  }

  kill(p, victim) {
    const room = p.room;
    const witnesses = [];
    for (const w of this.living()) {
      if (w === p || w === victim) continue;
      const s = this.canSee(w, p) || this.canSee(w, victim);
      if (!s) continue;
      witnesses.push(w);
      const data = { killer: s === 'named' ? p.name : null, victim: victim.name, room };
      if (s === 'named') this.note(w, 'saw_kill', 'kill_seen', { killer: p.name, victim: victim.name, room }, { interrupt: true, data });
      else this.note(w, 'saw_kill', 'kill_seen_dark', { victim: victim.name, room }, { interrupt: true, data });
    }
    this.note(victim, 'you_died', 'you_died', { killer: p.name, room });
    const names = witnesses.filter((w) => this.canSee(p, w)).map((w) => w.name).join(', ');
    this.note(p, 'you_killed', 'you_killed', { victim: victim.name, room, witnesses: names || say(this.lang, 'nobody') });
    victim.alive = false;
    victim.intent = null;
    victim.busy = null;
    victim.needs = null;
    this.bodies.push({ id: victim.id, room, t: this.t });
    for (const w of [p, ...witnesses]) w.seenBodies.add(victim.id);
    p.killCd = this.rules.killCooldown;
    this.emit({ type: 'kill', killer: p.id, victim: victim.id, room, witnesses: witnesses.map((w) => w.id) });
    this.checkWin();
  }

  vent(p, to) {
    const from = p.room;
    for (const w of this.watchers(p)) {
      this.note(w, 'saw_vent', 'vent_in', { name: p.name, room: from }, { interrupt: true, data: { who: p.name, room: from } });
      w.seen.delete(p.id);
    }
    p.room = to;
    p.arrivedAt = this.t;
    this.emit({ type: 'vent', p: p.id, from, to });
    this.note(p, 'you_vented', 'you_vented', { from, to });
    for (const w of this.watchers(p)) {
      this.note(w, 'saw_vent', 'vent_out', { name: p.name, room: to }, { interrupt: true, data: { who: p.name, room: to } });
      w.seen.set(p.id, 'named');
    }
    this.look(p, 'arrive');
  }

  sabotageNow(p, kind) {
    const deadline = kind === 'reactor' ? this.t + this.rules.reactorDeadline : null;
    this.sabotage = { kind, by: p.id, since: this.t, deadline };
    this.sabotageCd = this.rules.sabotageCooldown;
    this.emit({ type: 'sabotage', kind, by: p.id, deadline });
    this.note(p, 'you_sabotaged', 'you_sabotaged', { kind });
    for (const o of this.living()) {
      if (o === p) continue;
      if (kind === 'reactor') this.note(o, 'sabotage', 'sab_reactor', { secs: this.rules.reactorDeadline }, { interrupt: true });
      else if (o.role === 'crew') this.note(o, 'sabotage', 'sab_lights', {}, { interrupt: true });
      else this.note(o, 'sabotage', 'sab_lights_imp');
    }
  }

  tickSabotage() {
    const s = this.sabotage;
    if (s?.kind !== 'reactor') return;
    const hands = this.living().filter((p) => p.room === SABOTAGE_ROOMS.reactor && p.intent?.kind === 'fix');
    if (hands.length >= 2) return this.fixSabotage(hands);
    if (this.t >= s.deadline) this.end('impostor', 'reactor');
  }

  fixSabotage(by) {
    const kind = this.sabotage.kind;
    this.sabotage = null;
    this.emit({ type: 'sabotage_fixed', kind, by: by.map((p) => p.id) });
    for (const o of this.living()) this.note(o, 'sabotage_fixed', kind === 'lights' ? 'fixed_lights' : 'fixed_reactor');
    for (const p of by) if (p.intent?.kind === 'fix') this.finish(p);
  }

  // A line said out loud during free roam. Whoever can see the speaker hears it (crewmates in the dark
  // hear a voice from a shadow). The speaker learns who heard, and that someone they named was out of
  // earshot, so they can go and find them. A listener who is named, who is being answered, or who hears
  // it during a sabotage gets to react; the wake-up waits for the next second so the listener's own
  // order from this round of decisions does not swallow it.
  speak(id, text) {
    const p = this.byId(id);
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!p?.alive || this.phase !== 'roam' || !line) return;
    const ears = this.living().map((l) => ({ l, s: this.canSee(l, p) })).filter((x) => x.s);
    const blind = this.sabotage?.kind === 'lights' && p.role === 'crew';
    const called = namesIn(line, this.players.map((o) => o.name));
    const missed = blind ? [] : this.players.filter((o) => o !== p && !ears.some((x) => x.l === o) && called.has(o.name));
    this.emit({
      type: 'say', p: p.id, text: line, room: this.where(p),
      heard: ears.map((x) => x.l.id), anon: ears.filter((x) => x.s === 'anon').map((x) => x.l.id), missed: missed.map((o) => o.id),
    });

    for (const { l, s } of ears) {
      const named = called.has(l.name);
      const answer = this.t - (l.spokeTo.get(p.id) ?? -Infinity) <= this.rules.replySeconds;
      if (named) p.spokeTo.set(l.id, this.t);
      const data = { who: s === 'named' ? p.name : null, text: line, room: l.room ?? null, toMe: named || answer };
      if (s === 'named') this.note(l, 'heard', 'heard', { name: p.name, text: line }, { data });
      else this.note(l, 'heard', 'heard_dark', { text: line }, { data });
      if ((named || answer || this.sabotage) && this.t - l.talkWokeAt >= this.rules.talkWakeSeconds) {
        l.talkWokeAt = this.t;
        this.talkWakes.add(l.id);
      }
    }

    const names = ears.filter((x) => this.canSee(p, x.l) === 'named').map((x) => x.l.name);
    const shadows = ears.length - names.length;
    const parts = [...names];
    if (shadows) parts.push(say(this.lang, 'shadows', { n: shadows }));
    const who = [parts.length ? say(this.lang, 'said_heard', { list: parts.join(', ') }) : say(this.lang, 'said_nobody')];
    if (missed.length) who.push(say(this.lang, 'said_missed', { list: missed.map((o) => o.name).join(', ') }));
    this.note(p, 'you_said', 'you_said', { text: line, who: who.join('; ') }, { data: { text: line, heard: names, missed: missed.map((o) => o.name) } });
  }

  // ---------------------------------------------------------------- meetings

  startMeeting(callerId, bodyId) {
    const caller = this.byId(callerId);
    const body = bodyId ? this.bodies.find((b) => b.id === bodyId) : null;
    const newlyDead = this.players.filter((p) => !p.alive && !this.publicDead.has(p.id));
    newlyDead.forEach((p) => this.publicDead.add(p.id));
    this.meetingCount += 1;
    this.meeting = {
      n: this.meetingCount,
      caller: callerId,
      body: bodyId,
      room: body?.room ?? BUTTON_ROOM,
      reason: body ? 'body' : 'button',
      newlyDead: newlyDead.map((p) => p.id),
    };
    this.bodies = [];
    this.talkWakes.clear();
    if (this.sabotage?.kind === 'reactor') {
      this.sabotage = null;
      this.emit({ type: 'sabotage_fixed', kind: 'reactor', by: [] });
    }
    for (const p of this.players) {
      p.intent = null;
      p.busy = null;
      p.needs = null;
      p.opportunity = '';
      if (p.alive) { p.edge = null; p.room = BUTTON_ROOM; }
    }
    this.phase = 'meeting';
    this.emit({ type: 'meeting_start', ...this.meeting, dead: [...this.publicDead] });
    const deadList = [...this.publicDead].map((id) => this.byId(id).name).join(', ');
    for (const p of this.living()) {
      if (body) this.note(p, 'meeting', 'meeting_body', { caller: caller.name, body: this.byId(body.id).name, room: body.room });
      else this.note(p, 'meeting', 'meeting_button', { caller: caller.name });
      if (deadList) this.note(p, 'meeting', 'dead_now', { list: deadList });
    }
  }

  // votes: { voterId: targetId | 'skip' }. Majority over every other option ejects; ties eject nobody.
  resolveVotes(votes) {
    const tally = {};
    let skip = 0;
    for (const voter of this.living()) {
      const v = votes[voter.id];
      if (!v || v === 'skip' || !this.byId(v)?.alive) skip++;
      else tally[v] = (tally[v] || 0) + 1;
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const top = ranked[0]?.[1] ?? 0;
    const tied = ranked.length > 1 && ranked[1][1] === top;
    const ejected = top > skip && !tied ? ranked[0][0] : null;
    const why = ejected ? null : (top > 0 && (top === skip || tied) ? 'tie' : 'skip');
    const target = ejected ? this.byId(ejected) : null;
    const result = { ejected, tally, skip, why, wasImpostor: target ? target.role === 'impostor' : null };
    if (target) {
      target.alive = false;
      this.publicDead.add(target.id);
    }
    this.emit({ type: 'vote_result', ...result, reveal: this.rules.confirmEjects });
    for (const p of this.living()) {
      if (target) {
        const role = !this.rules.confirmEjects ? '' : say(this.lang, result.wasImpostor ? 'ejected_imp' : 'ejected_crew');
        this.note(p, 'meeting_result', 'ejected', { name: target.name, role });
      } else {
        this.note(p, 'meeting_result', 'no_eject', { why: say(this.lang, why === 'tie' ? 'why_tie' : 'why_skip') });
      }
    }
    return result;
  }

  endMeeting() {
    this.meeting = null;
    this.phase = 'roam';
    this.emergencyCd = this.rules.emergencyCooldown;
    this.sabotageCd = Math.max(this.sabotageCd, this.rules.firstSabotageCooldown);
    for (const p of this.living()) {
      p.needs = 'meeting_over';
      p.seenBodies = new Set();
      if (p.role === 'impostor') p.killCd = this.rules.killCooldown;
    }
    this.emit({ type: 'meeting_end' });
    this.checkWin();
    if (this.phase === 'roam') for (const p of this.living()) this.look(p, 'silent');
  }
}
