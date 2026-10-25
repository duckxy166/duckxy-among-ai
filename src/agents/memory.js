// Episodic memory: one per player, never shared. It holds what this player saw (timestamped by the
// engine), their own notes to self, their own secret thoughts and the public meeting record.
// Old routine lines are squashed into a location trail; evidence lines are never dropped.

import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../i18n.js';

const EVIDENCE = new Set([
  'saw_body', 'saw_kill', 'saw_vent', 'saw_task_visual', 'saw_task_fake', 'opportunity',
  'you_killed', 'you_vented', 'you_sabotaged', 'sabotage', 'task_done', 'meeting', 'meeting_result',
  'heard', 'you_said',
]);

const line = (e) => `[${clock(e.t)}] ${e.text}`;

export class EpisodicMemory {
  constructor() {
    this.entries = [];
    this.notes = [];
    this.thoughts = [];
    this.meetings = [];
  }

  observe(t, kind, text, data) { this.entries.push({ t, kind, text, data }); }
  note(t, text) { if (text?.trim()) this.notes.push({ t, text: text.trim() }); }
  thought(t, phase, text) { if (text?.trim()) this.thoughts.push({ t, phase, text: text.trim() }); }
  addMeeting(summary) { this.meetings.push(summary); }

  // The newest `limit` lines verbatim; older evidence verbatim; the rest of the past as a trail.
  renderLog(limit = 25, trailLabel = 'route') {
    const list = this.entries;
    if (!list.length) return '(nothing yet)';
    if (list.length <= limit) return list.map(line).join('\n');
    const old = list.slice(0, list.length - limit);
    const fresh = list.slice(-limit);
    const rooms = old.filter((e) => e.kind === 'arrived' && e.data?.room).map((e) => e.data.room);
    const trail = rooms.filter((r, i) => r !== rooms[i - 1]);
    const out = [];
    if (trail.length) out.push(`[${clock(old[0].t)}–${clock(old.at(-1).t)}] ${trailLabel}: ${trail.join(' → ')}`);
    out.push(...old.filter((e) => EVIDENCE.has(e.kind)).map(line), ...fresh.map(line));
    return out.join('\n');
  }

  renderNotes(limit = 12) {
    return this.notes.length ? this.notes.slice(-limit).map((n) => `[${clock(n.t)}] ${n.text}`).join('\n') : '(none)';
  }

  renderThoughts(limit = 4) {
    return this.thoughts.length
      ? this.thoughts.slice(-limit).map((x) => `[${clock(x.t)} ${x.phase}] ${x.text}`).join('\n')
      : '(none yet)';
  }

  renderMeetings() {
    return this.meetings.length ? this.meetings.join('\n\n') : '(no meetings yet)';
  }

  // Hard facts in a machine-friendly shape (used by the mock brain).
  evidence() {
    const facts = [];
    for (const e of this.entries) {
      const d = e.data || {};
      if (e.kind === 'saw_kill' && d.killer) facts.push({ t: e.t, kind: 'kill', who: d.killer });
      if (e.kind === 'saw_vent') facts.push({ t: e.t, kind: 'vent', who: d.who });
      if (e.kind === 'saw_task_fake') facts.push({ t: e.t, kind: 'fake', who: d.who });
      if (e.kind === 'saw_task_visual') facts.push({ t: e.t, kind: 'proof', who: d.who });
      if (e.kind === 'saw_body') facts.push({ t: e.t, kind: 'body', who: d.body, room: d.room });
      if (e.kind === 'heard') facts.push({ t: e.t, kind: 'heard', who: d.who ?? null, text: d.text, toMe: !!d.toMe });
      if (e.kind === 'arrived' || e.kind === 'saw_player') {
        for (const who of d.saw ?? (d.who ? [d.who] : [])) facts.push({ t: e.t, kind: 'seen', who, room: d.room });
      }
    }
    return facts;
  }
}

// ------------------------------------------------------------ memory across matches

const HEADER = (name) => `# Long-term memory: ${name}\n\nWritten by the agent itself after each match, newest first. Loaded into its next match.\n\n`;

export function loadLongTerm(dir, seatId) {
  const file = path.join(dir, `${seatId}.md`);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- ')).join('\n');
}

export function appendLongTerm(dir, seat, entry, keep = 8) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${seat.id}.md`);
  const old = loadLongTerm(dir, seat.id).split('\n').filter(Boolean);
  const lesson = entry.lesson.replace(/\s+/g, ' ').trim();
  const fresh = `- ${entry.date} · match ${entry.matchId} · ${entry.role} · ${entry.result} — ${lesson}`;
  fs.writeFileSync(file, HEADER(seat.name) + [fresh, ...old].slice(0, keep).join('\n') + '\n', 'utf8');
}
