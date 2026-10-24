// Among AI match viewer: plays the event log of a saved match, or of the running match live.
// One game second plays as one real second (times the speed); meetings pause briefly per line.
// URL options: ?replay=<matchId> ?speed=4 ?focus=<playerId>

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const params = new URLSearchParams(location.search);
const HOLD = { meeting_start: 1200, chat: 1500, vote_result: 2500, kill: 600 };

let S;

function reset() {
  S = {
    events: [], idx: 0, clock: 0, lastT: 0, holdUntil: 0, last: performance.now(),
    playing: true, live: false, over: false, start: null,
    people: new Map(), bodies: [], sabotage: null, selected: params.get('focus'), memory: new Map(),
  };
  for (const s of ['#ship', '#bodies', '#people', '#players', '#memory .lines', '#log .lines']) $(s).innerHTML = '';
  $('#alert').textContent = '';
  setTasks(0, 0);
}

const svg = (tag, attrs, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const clock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const P = (id) => S.people.get(id);
const nameOf = (id) => (id === 'skip' ? 'skip' : P(id)?.name ?? id);
const clean = (s) => (s || '').replace(/^\[mock:[^\]]+\]\s*/, ''); // the mock bot tags its thoughts for the tests

function setTasks(done, total) {
  $('#bar').value = total ? done / total : 0;
  $('#count').textContent = `${done}/${total}`;
}

function addLine(list, t, text, { hot = false, thought = '' } = {}) {
  const li = node('li', hot ? 'hot' : '');
  li.append(node('span', 't', clock(t)), text);
  if (thought) li.appendChild(node('span', 'thought', `💭 ${thought}`));
  list.appendChild(li);
  while (list.children.length > 200) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}
const log = (t, text, opts) => addLine($('#log .lines'), t, text, opts);

function select(id) {
  S.selected = id;
  for (const p of S.people.values()) p.row.classList.toggle('selected', p.id === id);
  $('#who').textContent = P(id)?.name ?? '—';
  const list = $('#memory .lines');
  list.innerHTML = '';
  for (const m of S.memory.get(id) ?? []) addLine(list, m.t, m.text, { hot: /saw_kill|saw_vent|saw_body|you_killed/.test(m.kind) });
}

function render(p) {
  p.row.classList.toggle('out', !p.alive);
  p.row.querySelector('.status').textContent = p.ejected ? 'ejected' : p.alive ? '' : 'dead';
  p.row.querySelector('.thought').textContent = p.thought ? `💭 ${p.thought}` : '';
  p.row.querySelector('.say').textContent = p.say ? `💬 ${p.say}` : '';
}

function apply(e) {
  const p = e.p ? P(e.p) : null;
  switch (e.type) {
    case 'match_start': {
      S.start = e;
      for (const c of e.edges) {
        const a = e.rooms[c.a];
        const b = e.rooms[c.b];
        svg('line', { class: 'corridor', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, $('#ship'));
      }
      for (const [name, r] of Object.entries(e.rooms)) {
        const g = svg('g', { class: 'room' }, $('#ship'));
        svg('rect', { x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, rx: 12 }, g);
        svg('text', { x: r.x, y: r.y - r.h / 2 + 20 }, g).textContent = name;
      }
      for (const x of e.players) {
        const q = { ...x, alive: true, ghost: false, room: 'Cafeteria', move: null, thought: '', say: '' };
        q.dot = svg('g', { class: 'person' }, $('#people'));
        svg('circle', { r: 13, fill: x.hex }, q.dot);
        svg('text', { y: 30 }, q.dot).textContent = x.name;
        q.row = node('div', 'player');
        q.row.style.borderLeftColor = x.hex;
        q.row.append(node('span', `role ${x.role}`, x.role), node('b', '', x.name), node('small', '', x.label),
          node('p', 'status'), node('p', 'thought'), node('p', 'say'));
        q.row.onclick = () => select(x.id);
        $('#players').appendChild(q.row);
        S.people.set(x.id, q);
        S.memory.set(x.id, []);
      }
      select(S.selected && P(S.selected) ? S.selected : e.players[0].id);
      log(e.t, `Match ${e.matchId} · seed ${e.seed} · ${e.players.length} players`);
      break;
    }
    case 'decision':
      p.thought = clean(e.thought);
      render(p);
      if (e.error) log(e.t, `${p.name}: brain error (${e.error})`);
      break;
    case 'move':
      p.room = null;
      p.move = { from: e.from, to: e.to, start: e.t, dur: e.dur };
      p.ghost = e.ghost;
      break;
    case 'arrive':
      p.move = null;
      p.room = e.room;
      break;
    case 'taskbar':
      setTasks(e.done, e.total);
      break;
    case 'kill': {
      const v = P(e.victim);
      Object.assign(v, { alive: false, ghost: true, move: null, room: e.room });
      S.bodies.push({ id: v.id, room: e.room });
      drawBodies();
      render(v);
      log(e.t, `${P(e.killer).name} killed ${v.name} in ${e.room}`, { hot: true });
      break;
    }
    case 'vent':
      p.move = null;
      p.room = e.to;
      log(e.t, `${p.name} vented ${e.from} → ${e.to}`, { hot: true });
      break;
    case 'sabotage':
      S.sabotage = e;
      log(e.t, `${nameOf(e.by)} sabotaged ${e.kind}`, { hot: true });
      break;
    case 'sabotage_fixed':
      S.sabotage = null;
      if (e.by.length) log(e.t, `${e.kind} fixed by ${e.by.map(nameOf).join(', ')}`);
      break;
    case 'meeting_start':
      S.bodies = [];
      drawBodies();
      for (const q of S.people.values()) if (q.alive) { q.move = null; q.room = 'Cafeteria'; q.say = ''; render(q); }
      log(e.t, `Meeting #${e.n}: ${e.reason === 'body' ? `${nameOf(e.caller)} reported ${nameOf(e.body)} in ${e.room}` : `${nameOf(e.caller)} pressed the button`}`, { hot: true });
      break;
    case 'chat':
      p.say = e.text || '(quiet)';
      p.thought = clean(e.thought);
      render(p);
      log(e.t, `${p.name}: ${e.text || '(quiet)'}`, { thought: clean(e.thought) });
      break;
    case 'vote':
      p.thought = clean(e.thought);
      render(p);
      break;
    case 'vote_result': {
      const votes = S.events.filter((v) => v.type === 'vote' && v.seq < e.seq && v.seq > (S.lastResult ?? -1));
      S.lastResult = e.seq;
      log(e.t, `Votes: ${votes.map((v) => `${nameOf(v.p)}→${nameOf(v.target)}`).join(', ')}`);
      if (e.ejected) {
        Object.assign(P(e.ejected), { alive: false, ghost: true, ejected: true });
        render(P(e.ejected));
      }
      log(e.t, e.ejected ? `${nameOf(e.ejected)} was ejected${e.reveal ? (e.wasImpostor ? ' (Impostor)' : ' (not an Impostor)') : ''}` : `Nobody was ejected (${e.why})`, { hot: true });
      break;
    }
    case 'memory': {
      S.memory.get(e.p).push(e);
      if (e.p === S.selected) addLine($('#memory .lines'), e.t, e.text, { hot: /saw_kill|saw_vent|saw_body|you_killed/.test(e.kind) });
      break;
    }
    case 'game_over':
      S.over = true;
      log(e.t, `Game over: ${{ crew: 'crewmates win', impostor: 'impostors win', none: 'nobody wins' }[e.winner]} (${e.reason})`, { hot: true });
      break;
    case 'reflection':
      if (e.lesson) log(e.t, `${p.name} → next match: ${e.lesson}`);
      break;
    case 'match_error':
      log(e.t, `Match stopped: ${e.error}`, { hot: true });
      break;
  }
}

function drawBodies() {
  $('#bodies').innerHTML = '';
  S.bodies.forEach((b, i) => {
    const r = S.start.rooms[b.room];
    svg('text', { x: r.x - 20 + (i % 3) * 20, y: r.y + 40, 'font-size': 20 }, $('#bodies')).textContent = '💀';
  });
}

function position(q) {
  if (q.move) {
    const a = S.start.rooms[q.move.from];
    const b = S.start.rooms[q.move.to];
    const k = Math.min(1, Math.max(0, (S.clock - q.move.start) / q.move.dur));
    return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
  }
  const r = S.start.rooms[q.room];
  const here = [...S.people.values()].filter((o) => !o.move && o.room === q.room && (o.alive || o.ghost));
  const i = here.indexOf(q);
  const cols = Math.min(4, Math.ceil(Math.sqrt(here.length)));
  const rows = Math.ceil(here.length / cols);
  return [r.x + ((i % cols) - (cols - 1) / 2) * 52, r.y + 6 + (Math.floor(i / cols) - (rows - 1) / 2) * 46];
}

function draw() {
  if (!S.start) return;
  $('#clock').textContent = clock(S.clock);
  const s = S.sabotage;
  $('#alert').textContent = !s ? '' : s.kind === 'lights' ? 'LIGHTS OUT' : `REACTOR ${Math.max(0, Math.ceil(s.deadline - S.clock))}s`;
  for (const q of S.people.values()) {
    const shown = q.alive || q.ghost;
    q.dot.setAttribute('class', `person${q.ghost ? ' ghost' : ''}`);
    q.dot.setAttribute('display', shown ? 'inline' : 'none');
    if (shown) {
      const [x, y] = position(q);
      q.dot.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    }
  }
}

function frame(now) {
  const speed = Number($('#speed').value);
  const dt = Math.min(0.25, (now - S.last) / 1000) * speed;
  S.last = now;
  if (S.playing && now >= S.holdUntil) {
    const catchUp = S.live && S.events.length - S.idx > 40; // opened late: skip the pauses
    while (S.idx < S.events.length) {
      const ev = S.events[S.idx];
      if (ev.t > S.clock + 1e-6 && !catchUp) break;
      if (catchUp) S.clock = Math.max(S.clock, ev.t);
      apply(ev);
      S.idx++;
      const hold = catchUp ? 0 : HOLD[ev.type] ?? 0;
      if (hold) { S.holdUntil = now + hold / speed; break; }
    }
    if (now >= S.holdUntil && !S.over) {
      const next = S.events[S.idx];
      const cap = next ? next.t : S.live ? S.lastT : S.clock;
      if (cap > S.clock) S.clock = Math.min(cap, S.clock + dt);
    }
  }
  draw();
  requestAnimationFrame(frame);
}

let source = null;

async function loadReplay(id) {
  source?.close();
  reset();
  const res = await fetch(`/api/matches/${encodeURIComponent(id)}/events`);
  if (!res.ok) return log(0, `No match ${id}`);
  S.events = await res.json();
  S.lastT = S.events.at(-1)?.t ?? 0;
}

function startLive() {
  source?.close();
  reset();
  S.live = true;
  source = new EventSource('/events');
  source.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    S.events.push(ev);
    S.lastT = Math.max(S.lastT, ev.t ?? 0);
  };
}

async function init() {
  if (params.get('speed')) $('#speed').value = params.get('speed');
  reset();
  const status = await fetch('/api/status').then((r) => r.json()).catch(() => ({ live: false }));
  const matches = await fetch('/api/matches').then((r) => r.json()).catch(() => []);
  const pick = $('#match');
  if (status.live) pick.appendChild(new Option('LIVE', ''));
  for (const id of matches) pick.appendChild(new Option(id, id));
  const wanted = params.get('replay');
  if (wanted) pick.value = wanted;
  if (wanted || !status.live) {
    const id = wanted || matches[0];
    if (id) await loadReplay(id); else log(0, 'No matches yet. Run: npm run mock');
  } else {
    startLive();
  }
  pick.onchange = () => (pick.value ? loadReplay(pick.value) : startLive());
  $('#play').onclick = () => { S.playing = !S.playing; $('#play').textContent = S.playing ? '⏸' : '▶'; };
  requestAnimationFrame(frame);
}

init();
