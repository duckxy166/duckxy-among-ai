import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, namesIn } from '../src/engine/game.js';
import { ROOM_NAMES, shortestPath } from '../src/engine/map.js';
import { createRng } from '../src/rng.js';

const SEATS = ['red', 'blue', 'green', 'pink', 'cyan'].map((c) => ({ id: c, name: c.toUpperCase(), color: c }));

// A 5-player game with RED as the only impostor, everyone parked where the test wants them.
function setup(rooms, rules = {}) {
  const g = new Game({ seats: SEATS, rng: createRng(1), rules: { impostors: 1, ...rules }, language: 'en' });
  for (const p of g.players) {
    p.role = p.id === 'red' ? 'impostor' : 'crew';
    p.room = rooms[p.id] ?? 'Cafeteria';
    p.needs = null;
    p.killCd = 0;
  }
  for (const p of g.players) g.look(p, 'silent');
  g.drain();
  return g;
}
const obs = (g, who) => g.drain().filter((e) => e.type === 'obs' && e.p === who);
const P = (g, id) => g.byId(id);

test('every room is reachable from every other room', () => {
  for (const a of ROOM_NAMES) for (const b of ROOM_NAMES) assert.ok(shortestPath(a, b), `${a} -> ${b}`);
  assert.equal(shortestPath('Reactor', 'Reactor').time, 0);
});

test('a kill in an empty room has no witness, and the body is found later', () => {
  const g = setup({ red: 'Electrical', blue: 'Electrical', green: 'Storage' });
  assert.ok(g.legalActions('red').some((a) => a.id === 'kill:BLUE'));
  g.act('red', 'kill:BLUE');
  assert.equal(P(g, 'blue').alive, false);
  assert.deepEqual(g.bodies.map((b) => b.room), ['Electrical']);
  assert.equal(obs(g, 'green').length, 0);

  g.act('green', 'move:Electrical');
  for (let i = 0; i < 6; i++) g.step();
  const lines = obs(g, 'green');
  assert.ok(lines.some((e) => e.kind === 'saw_body'), 'green finds the body');
  assert.equal(P(g, 'green').needs, 'saw_body');
  assert.ok(g.legalActions('green').some((a) => a.id === 'report'));
});

test('a witness in the room sees the killer by name', () => {
  const g = setup({ red: 'Admin', blue: 'Admin', green: 'Admin' });
  g.act('red', 'kill:BLUE');
  const seen = obs(g, 'green').find((e) => e.kind === 'saw_kill');
  assert.match(seen.text, /RED killed BLUE/);
  assert.equal(P(g, 'green').needs, 'saw_kill');
});

test('with the lights out a crewmate only sees a shadow kill', () => {
  const g = setup({ red: 'Admin', blue: 'Admin', green: 'Admin' });
  g.sabotageNow(P(g, 'red'), 'lights');
  g.step();
  g.drain();
  g.act('red', 'kill:BLUE');
  const seen = obs(g, 'green').find((e) => e.kind === 'saw_kill');
  assert.match(seen.text, /shadow/);
  assert.doesNotMatch(seen.text, /RED/);
});

test('kills need the cooldown and the same room', () => {
  const g = setup({ red: 'Admin', blue: 'Storage' });
  assert.ok(!g.legalActions('red').some((a) => a.id.startsWith('kill:')));
  P(g, 'blue').room = 'Admin';
  P(g, 'red').killCd = 5;
  g.look(P(g, 'red'), 'silent');
  assert.ok(!g.legalActions('red').some((a) => a.id.startsWith('kill:')));
  assert.equal(g.act('red', 'kill:BLUE').ok, false);
  assert.equal(P(g, 'blue').alive, true);
});

test('venting in front of someone is seen on both ends', () => {
  const g = setup({ red: 'Electrical', blue: 'Electrical', green: 'MedBay' });
  g.act('red', 'vent:MedBay');
  assert.equal(P(g, 'red').room, 'MedBay');
  const events = g.drain().filter((e) => e.type === 'obs');
  assert.ok(events.some((e) => e.p === 'blue' && e.kind === 'saw_vent' && /jump into a vent/.test(e.text)));
  assert.ok(events.some((e) => e.p === 'green' && e.kind === 'saw_vent' && /climb out/.test(e.text)));
});

test('a visual task proves a crewmate; a faked one shows no animation', () => {
  const g = setup({ red: 'MedBay', blue: 'MedBay', green: 'MedBay' });
  const blueScan = { id: 'scan', name: 'Submit Scan', room: 'MedBay', dur: 10, visual: true, done: false };
  P(g, 'blue').tasks = [blueScan];
  P(g, 'red').tasks = [{ ...blueScan }];
  g.act('blue', 'task:scan');
  g.act('red', 'fake:scan');
  g.step();
  const lines = obs(g, 'green');
  assert.ok(lines.some((e) => e.kind === 'saw_task_visual' && e.data.who === 'BLUE'));
  assert.ok(lines.some((e) => e.kind === 'saw_task_fake' && e.data.who === 'RED'));
});

test('walking past someone in a corridor is remembered with the time', () => {
  const g = setup({ blue: 'Storage', green: 'Electrical' });
  g.act('blue', 'move:Electrical');
  g.act('green', 'move:Storage');
  for (let i = 0; i < 2; i++) g.step();
  const passed = obs(g, 'blue').find((e) => e.kind === 'saw_player');
  assert.match(passed.text, /GREEN/);
  assert.ok(passed.t > 0);
});

test('votes: majority ejects, a tie or a skip majority does not', () => {
  const g = setup({});
  g.startMeeting('blue', null);
  let r = g.resolveVotes({ red: 'skip', blue: 'red', green: 'red', pink: 'red', cyan: 'skip' });
  assert.equal(r.ejected, 'red');
  assert.equal(r.wasImpostor, true);

  const g2 = setup({});
  g2.startMeeting('blue', null);
  r = g2.resolveVotes({ red: 'blue', blue: 'red', green: 'red', pink: 'blue', cyan: 'skip' });
  assert.equal(r.ejected, null);
  assert.equal(r.why, 'tie');

  const g3 = setup({});
  g3.startMeeting('blue', null);
  r = g3.resolveVotes({ red: 'skip', blue: 'skip', green: 'skip', pink: 'red', cyan: 'skip' });
  assert.equal(r.ejected, null);
  assert.equal(r.why, 'skip');
});

test('impostors win at parity; crew wins when the impostor is ejected', () => {
  const g = setup({ red: 'Admin', blue: 'Admin', green: 'Admin', pink: 'Admin', cyan: 'Admin' });
  P(g, 'green').alive = false;
  P(g, 'pink').alive = false;
  g.act('red', 'kill:BLUE');
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'impostor');

  const g2 = setup({});
  g2.startMeeting('blue', null);
  g2.resolveVotes({ blue: 'red', green: 'red', pink: 'red' });
  g2.endMeeting();
  assert.equal(g2.winner, 'crew');
});

test('a reactor meltdown needs two players at once', () => {
  const g = setup({ red: 'Admin', blue: 'Reactor', green: 'Reactor' }, { reactorDeadline: 10 });
  g.sabotageNow(P(g, 'red'), 'reactor');
  g.act('blue', 'fix');
  g.step();
  assert.ok(g.sabotage, 'one pair of hands is not enough');
  g.act('green', 'fix');
  g.step();
  assert.equal(g.sabotage, null);

  const g2 = setup({ red: 'Admin' }, { reactorDeadline: 3 });
  g2.sabotageNow(P(g2, 'red'), 'reactor');
  for (let i = 0; i < 4; i++) g2.step();
  assert.equal(g2.winner, 'impostor');
  assert.equal(g2.reason, 'reactor');
});

test('a line said out loud reaches only the players who can see the speaker', () => {
  const g = setup({ red: 'Admin', blue: 'Admin', green: 'Admin', pink: 'Storage' });
  g.speak('blue', 'GREEN where were you? And PINK?');
  const events = g.drain();
  const said = events.find((e) => e.type === 'say');
  assert.deepEqual(said.heard, ['red', 'green']);
  assert.deepEqual(said.missed, ['pink']);
  const heard = (id) => events.find((e) => e.type === 'obs' && e.p === id && e.kind === 'heard');
  assert.equal(heard('green').text, 'BLUE said: "GREEN where were you? And PINK?"');
  assert.equal(heard('green').data.toMe, true);
  assert.equal(heard('red').data.toMe, false);
  assert.equal(heard('pink'), undefined);
  // The speaker knows who heard, and that PINK was out of earshot (so BLUE can go and find them).
  const mine = events.find((e) => e.type === 'obs' && e.p === 'blue' && e.kind === 'you_said');
  assert.match(mine.text, /heard by RED, GREEN; PINK not in earshot/);
  // Only the named listener is woken, on the next second, even after an order of their own.
  g.act('green', 'wait:15');
  g.step();
  assert.equal(P(g, 'green').needs, 'heard');
  assert.equal(P(g, 'red').needs, null);
});

test('an answer wakes the one who asked; a listener is not woken again right away', () => {
  const g = setup({ blue: 'Admin', green: 'Admin' });
  g.speak('blue', 'GREEN where were you?');
  g.step();
  assert.equal(P(g, 'green').needs, 'heard');
  g.speak('green', 'doing wires in Electrical');
  g.step();
  assert.equal(P(g, 'blue').needs, 'heard', 'GREEN answers BLUE without naming them');
  P(g, 'green').needs = null;
  g.speak('blue', 'GREEN really?');
  g.step();
  assert.equal(P(g, 'green').needs, null, 'woken less than talkWakeSeconds ago');
});

test('in the dark a crewmate hears a voice, not whose it is; during a sabotage every listener reacts', () => {
  const g = setup({ red: 'Admin', blue: 'Admin', green: 'Admin', pink: 'Storage' });
  g.sabotageNow(P(g, 'red'), 'lights');
  g.step();
  g.drain();
  for (const p of g.players) p.needs = null;
  g.speak('red', 'I will fix the lights');
  let events = g.drain();
  const voice = events.find((e) => e.type === 'obs' && e.p === 'green' && e.kind === 'heard');
  assert.equal(voice.text, 'A voice in the dark said: "I will fix the lights"');
  assert.equal(voice.data.who, null);
  assert.deepEqual(events.find((e) => e.type === 'say').anon, ['blue', 'green']);
  g.step();
  assert.equal(P(g, 'blue').needs, 'heard');
  assert.equal(P(g, 'green').needs, 'heard');

  // A crewmate in the dark cannot tell who heard them, nor that someone named is missing.
  g.speak('blue', 'PINK is that you?');
  events = g.drain();
  assert.deepEqual(events.find((e) => e.type === 'say').missed, []);
  assert.match(events.find((e) => e.type === 'obs' && e.p === 'blue' && e.kind === 'you_said').text, /heard by 2 shadow/);
});

test('asked again to do the job it is doing, a player carries on instead of starting over', () => {
  const g = setup({ blue: 'MedBay' });
  P(g, 'blue').tasks = [{ id: 'scan', name: 'Submit Scan', room: 'MedBay', dur: 10, visual: true, done: false }];
  g.act('blue', 'task:scan');
  for (let i = 0; i < 4; i++) g.step();
  const left = P(g, 'blue').busy.left;
  assert.ok(left < 10);
  g.act('blue', 'task:scan');
  assert.equal(P(g, 'blue').busy.left, left);
});

test('a line calls the longest name it holds: "Claude Haiku" is not also "Claude"', () => {
  const names = ['Claude', 'Claude Haiku', 'Red'];
  assert.deepEqual([...namesIn('Claude Haiku, come here', names)], ['Claude Haiku']);
  assert.deepEqual([...namesIn('claude and Claude Haiku', names)].sort(), ['Claude', 'Claude Haiku']);
  assert.deepEqual([...namesIn('Redไปไหนมา', names)], ['Red']);
  assert.equal(namesIn('who covered Reactor?', names).size, 0);
});
