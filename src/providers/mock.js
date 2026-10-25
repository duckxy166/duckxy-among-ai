// A rule-based player that needs no API key. It reads the same structured context the prompt is
// built from and answers with the same JSON a model would, so dry runs exercise the whole pipeline.
// Its thoughts carry a "[mock:<seat>#n]" tag, which the tests use to prove memories stay separate.

import { createRng } from '../rng.js';

export function createMock(seat, seed = 0) {
  const rng = createRng((seed ^ hash(seat.id)) >>> 0);
  let n = 0;
  const tag = () => `[mock:${seat.id}#${++n}]`;

  return {
    async complete({ context }) {
      const out = BRAINS[context.kind](context, rng);
      out.secret_thought = `${tag()} ${out.secret_thought}`;
      return { text: JSON.stringify(out), refused: false, model: 'mock', usage: { input: 0, output: 0, cacheRead: 0 } };
    },
  };
}

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const BRAINS = {
  roam(ctx, rng) {
    const { view, evidence, seat } = ctx;
    const has = (id) => view.legal.some((a) => a.id === id);
    const all = (prefix) => view.legal.filter((a) => a.id.startsWith(prefix)).map((a) => a.id);
    const reply = (action, thought, note = '', line = '') => ({ secret_thought: thought, action, say: line, note });
    const others = view.visible.map((v) => v.name);
    const heard = evidence.filter((e) => e.kind === 'heard' && view.t - e.t <= 3);
    const askedMe = view.reason === 'heard' && heard.find((e) => e.toMe && e.who && e.text.includes('ไปไหนมา'));
    // Someone said they would fix the lights: the first name in the alphabet takes the job, the rest carry on.
    const claim = view.sabotage?.kind === 'lights' && heard.find((e) => e.who && e.text.includes('ซ่อมไฟ') && e.who < seat.name);

    if (has('report') && (view.role === 'crew' || rng.chance(0.3))) {
      return reply('report', `เจอศพ ${view.bodies[0]} ต้องรีบรายงาน`, `เจอศพ ${view.bodies[0]} ที่ ${view.room}`);
    }
    if (view.role === 'impostor') {
      if (view.dead) {
        const sabs = all('sabotage:');
        return sabs.length && rng.chance(0.5) ? reply(rng.pick(sabs), 'ตายแล้วแต่ยังป่วนลูกเรือได้') : reply('wait:15', 'รอจังหวะให้คู่หูก่อน');
      }
      const kills = all('kill:');
      if (kills.length && view.visible.length === 1) return reply(kills[0], `${kills[0].slice(5)} อยู่คนเดียว ไม่มีพยาน ลงมือเลย`);
      const fakes = all('fake:');
      if (askedMe) return reply(fakes[0] ?? rng.pick(all('move:')), `${askedMe.who} ถามว่าไปไหนมา ตอบเนียน ๆ ไป`, '', 'ทำ task อยู่ ไม่ได้ไปไหนเลย');
      if (view.sabotage?.kind === 'lights' && others.length && rng.chance(0.3)) {
        return reply(fakes[0] ?? rng.pick(all('move:')), 'บอกว่าจะไปซ่อมไฟ ลูกเรือจะได้ไม่ไป', '', 'เดี๋ยวเราไปซ่อมไฟเอง');
      }
      const vents = all('vent:');
      if (vents.length && view.visible.length === 0 && view.reason === 'idle' && rng.chance(0.15)) return reply(rng.pick(vents), 'มุด vent หนีไปห้องอื่นก่อน');
      if (has('sabotage:lights') && rng.chance(0.12)) return reply('sabotage:lights', 'ปิดไฟให้ลูกเรือมองไม่เห็น');
      if (has('sabotage:reactor') && rng.chance(0.04)) return reply('sabotage:reactor', 'ให้ reactor ระเบิด ดึงลูกเรือไปรวมที่เดียว');
      if (fakes.length && rng.chance(0.6)) return reply(rng.pick(fakes), 'ทำเป็นทำ task ให้ดูเนียน');
      return reply(rng.pick(all('move:')), 'เดินหาเหยื่อที่อยู่คนเดียว');
    }
    const tasks = all('task:');
    const carryOn = tasks[0] ?? rng.pick(all('move:'));
    const answer = askedMe ? `ทำ task อยู่ที่ ${view.room ?? 'ทางเดิน'}` : '';
    // A sabotage comes before small talk: a question asked on the way is answered while going to fix it.
    if (has('fix') && view.sabotage) {
      if (claim && view.reason === 'heard') return reply(carryOn, `${claim.who} บอกว่าจะไปซ่อมไฟ งั้นทำ task ต่อ`, `${claim.who} บอกว่าจะไปซ่อมไฟ`, `โอเค ${claim.who} ฝากด้วย`);
      const call = view.reason !== 'sabotage' || !others.length ? ''
        : view.sabotage.kind === 'lights' ? `เราไปซ่อมไฟเอง ${others[0]} ทำ task ต่อเลย` : `${others[0]} ไป Reactor ด้วยกัน ต้องใช้สองคน`;
      return reply('fix', `ต้องไปซ่อม ${view.sabotage.kind}`, '', answer || call);
    }
    if (askedMe) return reply(carryOn, `${askedMe.who} ถามว่าไปไหนมา ตอบตามจริง`, '', answer);
    if (view.reason === 'saw_kill' || view.reason === 'saw_vent') {
      if (has('emergency')) return reply('emergency', 'เห็นกับตา ต้องเรียกประชุมเดี๋ยวนี้', 'เห็นหลักฐานชัด ๆ');
    }
    if (others.length && view.reason === 'idle' && rng.chance(0.12)) {
      return reply(carryOn, `ลองถาม ${others[0]} ดูว่าไปไหนมา`, '', `${others[0]} ไปไหนมา`);
    }
    if (tasks.length) return reply(tasks[0], 'ไปทำ task ต่อ');
    return reply(rng.pick(all('move:')), 'task หมดแล้ว เดินดูคนอื่น');
  },

  speak(ctx, rng) {
    const { meeting, transcript, evidence, seat, role, partners } = ctx;
    const me = seat.name;
    const alive = meeting.alive.filter((x) => x !== me);
    if (role === 'impostor') {
      const crew = alive.filter((x) => !partners.includes(x));
      const accuser = transcript.find((c) => c.text?.includes(me) && crew.includes(c.name))?.name;
      const target = accuser ?? (rng.chance(0.5) ? rng.pick(crew) : null);
      if (!target) return { secret_thought: 'เงียบไว้ก่อน อย่าเด่น', chat_message: 'ผมทำ task อยู่ ไม่เห็นอะไรเลย', suspect: 'none' };
      return { secret_thought: `โยนความผิดให้ ${target} ก่อนที่จะมีคนสงสัยเรา`, chat_message: `${target} ดูแปลก ๆ นะ เมื่อกี้ไม่เห็นทำ task เลย`, suspect: target };
    }
    const caught = evidence.filter((e) => ['kill', 'vent', 'fake'].includes(e.kind) && alive.includes(e.who)).at(-1);
    if (caught) {
      const what = { kill: 'ฆ่าคน', vent: 'มุด vent', fake: 'ยืนทำ task แต่ไม่มีแอนิเมชัน' }[caught.kind];
      return { secret_thought: `หลักฐานชัด ${caught.who} โกหกไม่ได้`, chat_message: `ผมเห็น ${caught.who} ${what} โหวต ${caught.who} เลย`, suspect: caught.who };
    }
    const body = evidence.filter((e) => e.kind === 'body').at(-1);
    const near = body && evidence.filter((e) => e.kind === 'seen' && e.room === body.room && body.t - e.t <= 40 && alive.includes(e.who)).at(-1);
    if (near) {
      return { secret_thought: `${near.who} อยู่แถว ${body.room} ก่อนเจอศพ`, chat_message: `เมื่อกี้เห็น ${near.who} แถว ${body.room} ก่อนเจอศพนะ`, suspect: near.who };
    }
    const named = mostMentioned(transcript, alive);
    if (named && rng.chance(0.5)) return { secret_thought: `หลายคนพูดถึง ${named} ตามน้ำไปก่อน`, chat_message: `${named} ตอนนั้นอยู่ไหน`, suspect: named };
    return { secret_thought: 'ไม่มีข้อมูลเลย ฟังคนอื่นก่อน', chat_message: rng.chance(0.5) ? 'ไม่เห็นอะไรเลย ทำ task อยู่' : '', suspect: 'none' };
  },

  vote(ctx) {
    const { transcript, evidence, options, seat, role, partners } = ctx;
    const alive = options.filter((x) => x !== seat.name && !(role === 'impostor' && partners.includes(x)));
    if (role === 'impostor') {
      const named = mostMentioned(transcript, alive, 2);
      return named ? { secret_thought: `ตามน้ำโหวต ${named}`, vote: named } : { secret_thought: 'skip ปลอดภัยสุด', vote: 'skip' };
    }
    const caught = evidence.filter((e) => ['kill', 'vent', 'fake'].includes(e.kind) && alive.includes(e.who)).at(-1);
    if (caught) return { secret_thought: `โหวต ${caught.who} ตามหลักฐาน`, vote: caught.who };
    const named = mostMentioned(transcript, alive, 2);
    if (named) return { secret_thought: `${named} โดนพูดถึงเยอะ โหวตตาม`, vote: named };
    return { secret_thought: 'ข้อมูลไม่พอ skip', vote: 'skip' };
  },

  reflect(ctx) {
    return { secret_thought: 'จบเกมแล้ว', lesson: `เกมนี้ ${ctx.result.headline} จำไว้ว่าใครพูดอะไร` };
  },

  ping() {
    return { secret_thought: 'ready', ok: 'yes' };
  },
};

function mostMentioned(transcript, names, min = 1) {
  const counts = new Map();
  for (const c of transcript) for (const n of names) if (c.text?.includes(n)) counts.set(n, (counts.get(n) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= min ? top[0] : null;
}
