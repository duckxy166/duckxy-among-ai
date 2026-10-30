// One player's brain. It owns a private EpisodicMemory and talks to exactly one model. Every
// reply is split in two: secret_thought (kept, logged, shown to viewers) and the public part.

import { EpisodicMemory } from './memory.js';
import { SCHEMAS, roamSchema, roamPrompt, speakPrompt, votePrompt, reflectPrompt } from './prompts.js';

export class FatalSeatError extends Error {}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}:]/gu, '');

// Models sometimes add spaces, change case or copy the label after the id; accept those.
export function matchAction(raw, legal) {
  if (!raw) return null;
  const exact = legal.find((a) => a.id === raw);
  if (exact) return exact.id;
  const n = norm(raw);
  const same = legal.find((a) => norm(a.id) === n);
  if (same) return same.id;
  const prefixed = legal.filter((a) => n.startsWith(norm(a.id))).sort((a, b) => b.id.length - a.id.length);
  return prefixed[0]?.id ?? null;
}

export function matchName(raw, names, keywords = []) {
  const n = norm(raw);
  if (!n) return null;
  const word = keywords.find((k) => norm(k) === n);
  if (word) return word;
  const longestFirst = [...names].sort((a, b) => b.length - a.length);
  return names.find((x) => norm(x) === n) ?? longestFirst.find((x) => n.includes(norm(x))) ?? null;
}

// Fields a reply may leave out (read as an empty string): `say` is newer than some scripted or custom brains.
const OPTIONAL = new Set(['say']);

export function parseJson(text, schema) {
  if (!text) return null;
  const body = String(text).replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const key of Object.keys(schema.properties)) {
    const missing = data[key] === undefined || data[key] === null;
    if (missing && !OPTIONAL.has(key)) return null;
    out[key] = missing ? '' : String(data[key]);
  }
  return out;
}

export class Agent {
  constructor({ seat, role, partners = [], provider, system, onCall }) {
    this.seat = seat;
    this.role = role;
    this.partners = partners;
    this.provider = provider;
    this.system = system;
    this.onCall = onCall;
    this.memory = new EpisodicMemory();
    this.stats = { calls: 0, errors: 0, invalid: 0, refusals: 0, ms: 0, input: 0, output: 0, cacheRead: 0 };
  }

  async ask(kind, user, effort, context) {
    const spec = SCHEMAS[kind];
    // On a roam turn, constrain `action` to THIS turn's legal ids so schema-enforcing providers
    // cannot return an off-list action. Built from the seat's own view.legal, so simulator
    // determinism and memory isolation are untouched. parseJson still runs on spec.schema: the
    // enum variant only adds `enum` to the same `action` field, so field parsing is unchanged.
    const reqSchema = kind === 'roam' && Array.isArray(context?.view?.legal) && context.view.legal.length
      ? roamSchema(context.view.legal.map((a) => a.id))
      : spec.schema;
    const started = Date.now();
    let res = null;
    let data = null;
    let error = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      const prompt = attempt === 0 ? user
        : `${user}\n\nYour last reply was not one JSON object with the fields ${Object.keys(spec.schema.properties).join(', ')}. Reply again with that JSON only.`;
      try {
        res = await this.provider.complete({
          system: this.system, user: prompt, schema: reqSchema, schemaName: spec.name, effort,
          context: { ...context, kind, seat: this.seat, role: this.role, partners: this.partners },
        });
      } catch (e) {
        this.stats.errors++;
        if ([401, 403, 404].includes(e?.status)) {
          throw new FatalSeatError(`${this.seat.name} (${this.seat.provider} ${this.seat.model}): ${e.message}`);
        }
        error = clip(e?.message ?? e, 200);
        break;
      }
      this.stats.input += res.usage?.input ?? 0;
      this.stats.output += res.usage?.output ?? 0;
      this.stats.cacheRead += res.usage?.cacheRead ?? 0;
      if (res.refused) { this.stats.refusals++; error = 'refused'; break; }
      data = parseJson(res.text, spec.schema);
      if (!data) error = 'bad json';
    }
    if (data) error = null;
    if (error === 'bad json') this.stats.invalid++;
    const ms = Date.now() - started;
    this.stats.calls++;
    this.stats.ms += ms;
    this.onCall?.({ seat: this.seat.id, kind, user, raw: res?.text ?? null, error, ms, model: res?.model });
    return { data, error, ms, model: res?.model ?? this.seat.model };
  }

  async decideRoam(view) {
    const r = await this.ask('roam', roamPrompt(view, this.memory), this.seat.effort, {
      view, evidence: this.memory.evidence(),
    });
    let action = matchAction(r.data?.action, view.legal);
    if (!action) {
      if (r.data) this.stats.invalid++;
      action = 'wait:5';
    }
    const thought = clip(r.data?.secret_thought, 500);
    const note = clip(r.data?.note, 200);
    const said = clip(r.data?.say, 120);
    this.memory.thought(view.t, 'roam', thought);
    this.memory.note(view.t, note);
    return { action, raw: r.data?.action ?? null, thought, say: said, note, error: r.error, ms: r.ms, model: r.model };
  }

  async speak(meeting, transcript, round, rounds) {
    const r = await this.ask('speak', speakPrompt(meeting, this.memory, transcript, round, rounds, this.seat.name),
      this.seat.meetingEffort ?? this.seat.effort,
      { meeting, transcript, round, evidence: this.memory.evidence() });
    const thought = clip(r.data?.secret_thought, 500);
    const others = meeting.alive.filter((n) => n !== this.seat.name);
    this.memory.thought(meeting.t, `meeting ${meeting.n}`, thought);
    return {
      chat: clip(r.data?.chat_message, 300),
      suspect: matchName(r.data?.suspect, others, ['none']) ?? 'none',
      thought, error: r.error, ms: r.ms, model: r.model,
    };
  }

  async vote(meeting, transcript, options) {
    const r = await this.ask('vote', votePrompt(meeting, this.memory, transcript, options, this.seat.name),
      this.seat.meetingEffort ?? this.seat.effort,
      { meeting, transcript, options, evidence: this.memory.evidence() });
    const thought = clip(r.data?.secret_thought, 500);
    this.memory.thought(meeting.t, `vote ${meeting.n}`, thought);
    const vote = matchName(r.data?.vote, options, ['skip']) ?? 'skip';
    if (r.data && !matchName(r.data.vote, options, ['skip'])) this.stats.invalid++;
    return { vote, thought, error: r.error, ms: r.ms, model: r.model };
  }

  async reflect(result) {
    const r = await this.ask('reflect', reflectPrompt(result, this.memory), this.seat.meetingEffort ?? this.seat.effort, { result });
    return {
      lesson: clip(r.data?.lesson, 400),
      thought: clip(r.data?.secret_thought, 500),
      error: r.error, ms: r.ms, model: r.model,
    };
  }
}
