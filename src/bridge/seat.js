// One player in the real game: the AUBridge copy it plays through, what that copy has shown it,
// and the plan its body is carrying out. Bridge events become lines in this seat's memory only,
// with the same kinds and wording the simulator writes, so the Agent, prompts and mock brain
// work unchanged. view() and legalActions() have the simulator's shapes too.

import { say } from '../i18n.js';
import { ROOMS_REAL, roomToBridge, roomFromBridge, taskName, SABOTAGE_TYPES } from './skeld.js';

const TICK_MS = 500;
const REPORT_REACH = 1.0; // closer than this, report from where we stand; else walk to the body first

export class BridgeSeat {
  // match: { lang, rules, now(), emit(event), meeting, over, onBridgeEvent(seat, e), onKill(seat, victim, room), onSabotage(seat, type), warn(text) }
  constructor({ seat, client, match }) {
    this.seat = seat;
    this.id = seat.id;
    this.name = seat.name;
    this.client = client;
    this.match = match;
    this.agent = null;
    this.role = null; // 'crew' | 'impostor', as in the simulator
    this.partners = [];
    this.alive = true;
    this.state = null; // the `game` part of the last `state` reply
    this.room = 'Cafeteria';
    this.seen = new Set(); // names in view, from saw_player / lost_player
    this.seq = 0;
    this.needs = null;
    this.waiter = null;
    this.plan = null;
    this.deciding = false;
    this.stopped = false;
    this.buffered = [];
    this.emergencies = match.rules.emergencyMeetings ?? 1;
    this.lastChance = { name: null, at: -99 };
    this.talkWokeAt = -Infinity;
    this.spokeTo = new Map(); // name -> when this seat last named them out loud
  }

  // ------------------------------------------------------------------ plumbing

  attach(agent) {
    this.agent = agent;
    for (const b of this.buffered) this.write(b);
    this.buffered = [];
  }

  async refresh() {
    const r = await this.client.state();
    this.stage = r.stage;
    this.state = r.game ?? null;
    const me = this.state?.me;
    if (me) {
      this.alive = me.alive !== false;
      this.room = roomFromBridge(me.room) ?? this.room;
    }
    return this.state;
  }

  // Skip whatever the copy buffered before this match (an earlier game in the same window).
  async syncEvents() {
    const r = await this.client.waitEvents(0, 0);
    this.seq = r.seq ?? 0;
  }

  async pump() {
    while (!this.stopped) {
      let r;
      try {
        r = await this.client.waitEvents(this.seq, 20);
      } catch (e) {
        if (this.stopped) break;
        this.match.warn(`${this.name}: events: ${e.message}`);
        await sleep(1000);
        continue;
      }
      if (typeof r.seq === 'number') this.seq = r.seq;
      for (const e of r.events ?? []) {
        try { this.onEvent(e); } catch (err) { this.match.warn(`${this.name}: ${e.type}: ${err.message}`); }
      }
    }
  }

  async ticker() {
    while (!this.stopped) {
      await sleep(TICK_MS);
      if (this.match.over || this.match.meeting || !this.alive) continue;
      try { await this.tick(); } catch (e) { this.match.warn(`${this.name}: ${e.message}`); }
    }
  }

  stop() {
    this.stopped = true;
    this.wake(null);
  }

  // `reason` is what the prompt says woke this player up (see REASONS in prompts.js).
  wake(reason) {
    if (reason && (!this.alive || this.match.meeting || this.match.over)) return;
    if (reason) this.needs = reason;
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  nextNeed() {
    if (this.needs || this.stopped) return Promise.resolve();
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  // One memory line, written the way the simulator's Game.note() writes it.
  note(t, kind, key, vars = {}, { data, interrupt = false } = {}) {
    if (!this.alive && kind !== 'you_died') return;
    this.write({ t, kind, text: say(this.match.lang, key, vars), data });
    if (interrupt) this.wake(kind);
  }

  write(line) {
    if (!this.agent) { this.buffered.push(line); return; }
    this.agent.memory.observe(line.t, line.kind, line.text, line.data);
    this.match.emit({ type: 'memory', t: line.t, p: this.id, kind: line.kind, text: line.text });
  }

  where(room) { return room ?? say(this.match.lang, 'corridor'); }

  resetForMeeting() {
    this.plan = null;
    this.needs = null;
    this.seen.clear();
  }

  // The plan ended. One the brain is already replacing (stale: a decision started after it) wakes
  // nobody, or that player would decide twice in a row.
  endPlan(plan, reason = 'idle') {
    this.plan = null;
    if (!plan?.stale) this.wake(reason);
  }

  // ------------------------------------------------------------------ events from the copy

  // Field names as the mod sends them: an event field called `type` arrives as `kind` (the event's own
  // name is `type`), and the mod's `t` starts before the intro ends, so memory uses the match clock.
  onEvent(e) {
    const t = this.match.now();
    const room = roomFromBridge(e.room);
    const plan = this.plan;
    switch (e.type) {
      case 'room_changed':
        if (!room) break;
        this.room = room;
        this.match.emit({ type: 'arrive', t: this.match.now(), p: this.id, room, ghost: !this.alive });
        if (this.alive) {
          const named = [...this.seen];
          const who = named.length ? say(this.match.lang, 'who_list', { list: named.join(', ') }) : say(this.match.lang, 'who_none');
          this.note(t, 'arrived', 'arrived', { room, who }, { data: { room, saw: named } });
        }
        break;
      case 'arrived':
        if (plan?.kind === 'move') this.endPlan(plan);
        if (plan?.kind === 'report') this.tryReport().catch((err) => this.match.warn(`${this.name}: report: ${err.message}`));
        break;
      case 'saw_player':
        this.seen.add(e.name);
        this.note(t, 'saw_player', 'spotted', { name: e.name, where: this.where(room) }, { data: { who: e.name, room } });
        break;
      case 'lost_player':
        this.seen.delete(e.name);
        // Walking away from people is not news (the simulator skips it too).
        if (!plan?.moving) this.note(t, 'lost_player', 'lost', { name: e.name }, { data: { who: e.name } });
        break;
      case 'saw_body':
        this.note(t, 'saw_body', 'body', { name: e.name, room: this.where(room) }, { data: { body: e.name, room }, interrupt: true });
        break;
      case 'saw_kill':
        this.note(t, 'saw_kill', 'kill_seen', { killer: e.killer, victim: e.victim, room: this.where(room) },
          { data: { killer: e.killer, victim: e.victim, room }, interrupt: true });
        break;
      case 'saw_vent':
        this.note(t, 'saw_vent', e.action === 'exit' ? 'vent_out' : 'vent_in', { name: e.name, room: this.where(this.room) },
          { data: { who: e.name, room: this.room }, interrupt: true });
        break;
      case 'task_done': {
        const tasks = this.state?.tasks ?? [];
        const task = tasks.find((x) => x.id === e.id);
        const done = tasks.filter((x) => x.done || x.id === e.id).length;
        this.note(t, 'task_done', 'task_done', { task: taskName(e.name), room: this.where(roomFromBridge(task?.room) ?? this.room), done, total: tasks.length });
        this.match.emit({ type: 'task_done', t: this.match.now(), p: this.id, task: taskName(e.name), room: this.room, ghost: !this.alive });
        this.match.onTaskDone(this);
        if (plan?.kind === 'task') this.endPlan(plan);
        break;
      }
      case 'task_faked':
        this.note(t, 'fake_done', 'fake_done', { task: taskName(e.name), room: this.where(this.room) });
        if (plan?.kind === 'task') this.endPlan(plan);
        break;
      case 'stuck':
        this.note(t, 'stuck', 'stuck');
        if (plan) this.endPlan(plan, 'stuck');
        break;
      case 'lost_sight':
        this.note(t, 'lost_player', 'lost_follow', { name: e.name }, { data: { who: e.name } });
        if (plan?.kind === 'follow' || plan?.kind === 'kill') this.endPlan(plan, 'lost_sight');
        break;
      case 'kill_done': {
        const witnesses = [...this.seen].filter((n) => n !== e.victim);
        this.note(t, 'you_killed', 'you_killed', {
          victim: e.victim, room: this.where(room), witnesses: witnesses.join(', ') || say(this.match.lang, 'nobody'),
        });
        this.match.onKill(this, e.victim, room ?? this.room);
        this.endPlan(plan);
        break;
      }
      case 'you_died':
        if (e.cause !== 'killed') break; // ejections are written by the meeting
        this.note(t, 'you_died', e.killer ? 'you_died' : 'you_died_unseen', { killer: e.killer, room: this.where(this.room) });
        this.alive = false;
        this.plan = null;
        this.needs = null;
        this.match.onDeath(this);
        break;
      case 'sabotage': {
        const secs = Math.round(this.state?.sabotage?.timer ?? 30);
        const key = e.kind === 'lights' && this.role === 'impostor' ? 'sab_lights_imp' : `sab_${e.kind}`;
        this.note(t, 'sabotage', key, { secs }, { interrupt: this.role !== 'impostor' });
        break;
      }
      case 'sabotage_fixed':
        this.note(t, 'sabotage', `fixed_${e.kind}`);
        this.match.onSabotageFixed(e.kind);
        if (plan?.kind === 'fix') this.endPlan(plan);
        break;
      case 'fix_finished':
        if (plan?.kind === 'fix') this.endPlan(plan);
        break;
      case 'button_pressed':
        this.emergencies = Math.max(0, this.emergencies - 1);
        break;
      case 'button_refused':
        this.rejected('emergency', e.reason);
        break;
      default:
        break;
    }
    this.match.onBridgeEvent(this, e);
  }

  // ------------------------------------------------------------------ what the brain sees

  view(reason) {
    const st = this.state ?? {};
    const me = st.me ?? {};
    const visible = (st.visible ?? []).filter((v) => v.alive !== false);
    const sab = st.sabotage?.active ? { kind: st.sabotage.active, secondsLeft: st.sabotage.timer ? Math.round(st.sabotage.timer) : null } : null;
    const tasks = (st.tasks ?? []).map((x) => ({
      id: x.id, name: taskName(x.name), room: roomFromBridge(x.room) ?? x.room ?? '?', done: !!(x.done || x.fake), visual: false,
    }));
    const room = roomFromBridge(me.room);
    return {
      t: Math.round(this.match.now()),
      you: this.name,
      role: this.role,
      location: room ?? say(this.match.lang, 'corridor'),
      room,
      walking: !!this.plan?.moving,
      reason,
      visible: visible.map((v) => ({ name: v.name, where: this.where(roomFromBridge(v.room)), doing: '' })),
      shadows: 0,
      bodies: (st.bodies ?? []).map((b) => b.name),
      lightsOut: sab?.kind === 'lights',
      sabotage: sab,
      tasks,
      taskBar: { done: Math.round((st.taskBar ?? 0) * 100), total: 100 },
      partners: this.partners,
      killCooldown: Math.ceil(me.killCooldown ?? 0),
      sabotageCooldown: Math.ceil(st.sabotage?.cooldown ?? 0),
      vents: [],
      knownDead: [...this.match.knownDead],
      emergencies: this.emergencies,
      legal: this.legalActions(),
    };
  }

  legalActions() {
    const st = this.state;
    if (!this.alive || !st || st.phase !== 'tasks') return [];
    const me = st.me ?? {};
    const here = roomFromBridge(me.room);
    const acts = [];
    const add = (id, label) => acts.push({ id, label });
    const visible = (st.visible ?? []).filter((v) => v.alive !== false);

    add('wait:5', 'stay where you are for 5s');
    add('wait:15', 'stay where you are for 15s');
    for (const r of ROOMS_REAL) if (r !== here) add(`move:${r}`, `walk to ${r}`);
    const impostor = this.role === 'impostor';
    for (const x of st.tasks ?? []) {
      if (x.done || x.fake) continue;
      const where = roomFromBridge(x.room) ?? x.room;
      add(`${impostor ? 'fake' : 'task'}:${x.id}`, `${impostor ? 'pretend to do' : 'do'} ${taskName(x.name)} @ ${where}`);
    }
    for (const v of visible) add(`follow:${v.name}`, `follow ${v.name} for up to ${this.match.rules.followSeconds}s`);
    if (st.bodies?.length) add('report', `report the body of ${st.bodies.map((b) => b.name).join(', ')}`);
    if (this.emergencies > 0) add('emergency', `walk to the Cafeteria button and call a meeting (${this.emergencies} left)`);
    const sab = st.sabotage?.active;
    if (sab && !impostor) add('fix', `fix ${sab}`);
    if (impostor) {
      if ((me.killCooldown ?? 99) <= 0) {
        const reach = (me.killRange ?? 1) + 2;
        for (const v of visible) {
          if (this.partners.includes(v.name) || (v.distance ?? 99) > reach) continue;
          add(`kill:${v.name}`, `kill ${v.name} right now`);
        }
      }
      if (!sab && (st.sabotage?.cooldown ?? 99) <= 0) {
        for (const type of SABOTAGE_TYPES) add(`sabotage:${type}`, `sabotage ${type}`);
      }
    }
    return acts;
  }

  // ------------------------------------------------------------------ acting

  async execute(action) {
    const [verb, ...rest] = action.split(':');
    const arg = rest.join(':');
    const now = this.match.now();
    const send = (args) => this.client.act(args);
    let r;
    let plan = null;
    switch (verb) {
      case 'wait':
        r = await send({ do: 'stay' });
        plan = { kind: 'wait', until: now + (Number(arg) || 5) };
        break;
      // `until` on every plan: if the copy never reports the end (no arrived / task_done), decide again.
      case 'move':
        r = await send({ do: 'move_to', room: roomToBridge(arg) });
        plan = { kind: 'move', moving: true, until: now + 60 };
        break;
      case 'task':
      case 'fake':
        r = await send({ do: 'do_task', id: Number(arg) });
        plan = { kind: 'task', moving: true, until: now + 90 };
        break;
      case 'follow':
        r = await send({ do: 'follow', target: arg, distance: 1.5 });
        plan = { kind: 'follow', moving: true, until: now + this.match.rules.followSeconds };
        break;
      case 'emergency':
        r = await send({ do: 'call_meeting' });
        plan = { kind: 'button', moving: true, until: now + 60 };
        break;
      case 'fix':
        r = await send({ do: 'fix', type: this.state?.sabotage?.active });
        plan = { kind: 'fix', moving: true, until: now + 90 };
        break;
      case 'report':
        return this.startReport();
      case 'kill':
        return this.startKill(arg);
      case 'sabotage':
        r = await send({ do: 'sabotage', type: arg });
        if (r.ok) {
          this.note(now, 'you_sabotaged', 'you_sabotaged', { kind: arg });
          this.match.onSabotage(this, arg);
          this.wake('idle');
        }
        break;
      default:
        r = { ok: false, error: 'unknown action' };
    }
    if (!r.ok) return this.rejected(action, r.error);
    if (plan) this.plan = plan;
    return r;
  }

  rejected(action, reason) {
    this.note(this.match.now(), 'rejected', 'rejected', { action, reason: reason ?? '?' });
    this.plan = null;
    // A short pause, so a brain that keeps picking an impossible action does not spin.
    setTimeout(() => this.wake('idle'), 1000);
    return { ok: false, error: reason };
  }

  async startReport() {
    const body = this.state?.bodies?.[0];
    if (!body) return this.rejected('report', 'no body in view');
    if ((body.distance ?? 99) <= REPORT_REACH) return this.tryReport(true);
    const r = await this.client.act({ do: 'move_to', pos: body.pos });
    if (!r.ok) return this.rejected('report', r.error);
    this.plan = { kind: 'report', moving: true, until: this.match.now() + 15 };
    return r;
  }

  async tryReport(final = false) {
    const r = await this.client.act({ do: 'report' });
    if (r.ok) { this.plan = null; return r; }
    if (final || !this.plan) return this.rejected('report', r.error);
    return r; // still walking: the ticker tries again
  }

  async startKill(name) {
    const st = await this.refresh();
    const v = (st?.visible ?? []).find((x) => x.name === name && x.alive !== false);
    if (!v) return this.rejected(`kill:${name}`, 'target not visible');
    if ((v.distance ?? 99) <= (st.me?.killRange ?? 1)) {
      const r = await this.client.act({ do: 'kill', target: name });
      return r.ok ? r : this.rejected(`kill:${name}`, r.error);
    }
    const r = await this.client.act({ do: 'follow', target: name, distance: 0.5 });
    if (!r.ok) return this.rejected(`kill:${name}`, r.error);
    this.plan = { kind: 'kill', target: name, moving: true, until: this.match.now() + 8 };
    return r;
  }

  // Timers and the parts of a plan that need the copy's state.
  async tick() {
    const p = this.plan;
    const now = this.match.now();
    if (p?.until && now >= p.until) {
      if (p.kind === 'kill' && !p.stale) await this.client.act({ do: 'stay' });
      this.endPlan(p);
      return;
    }
    if (p?.kind === 'kill' && !p.stale) {
      const st = await this.refresh();
      const v = (st?.visible ?? []).find((x) => x.name === p.target && x.alive !== false);
      if (!v) { this.plan = null; this.wake('lost_sight'); return; }
      if ((st.me?.killCooldown ?? 99) <= 0 && (v.distance ?? 99) <= (st.me?.killRange ?? 1)) {
        await this.client.act({ do: 'kill', target: p.target }); // kill_done ends the plan
      }
      return;
    }
    if (p?.kind === 'report') {
      const st = await this.refresh();
      if ((st?.bodies?.[0]?.distance ?? 99) <= REPORT_REACH) await this.tryReport();
      return;
    }
    if (this.role === 'impostor' && !this.deciding && !this.needs) await this.checkChance(now);
  }

  // The simulator's "opportunity": alone with one crewmate and the kill is ready.
  async checkChance(now) {
    const st = await this.refresh();
    if (!st || st.phase !== 'tasks' || (st.me?.killCooldown ?? 99) > 0) return;
    const others = (st.visible ?? []).filter((v) => v.alive !== false);
    const prey = others.filter((v) => !this.partners.includes(v.name));
    if (others.length !== 1 || prey.length !== 1) return;
    const name = prey[0].name;
    if (this.lastChance.name === name && now - this.lastChance.at < 15) return;
    this.lastChance = { name, at: now };
    this.note(now, 'opportunity', 'opportunity', { name, room: this.where(this.room) }, { interrupt: true });
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls fn() (errors count as "not yet") until it is truthy or the time is up.
export async function until(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(stepMs);
  }
  return false;
}
