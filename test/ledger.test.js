import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchLedger } from '../src/bridge/ledger.js';

const SEATS = ['Red', 'Blue', 'Green', 'Pink'].map((name) => ({ id: name.toLowerCase(), name }));

// sight: seat id -> the names its own copy shows it.
function open(sight = {}) {
  const events = [];
  const ledger = new MatchLedger({ seats: SEATS, emit: (e) => events.push(e), inView: (id) => new Set(sight[id] ?? []) });
  return { ledger, events };
}

test('crewmates fixing the reactor get both panels and keep theirs when they ask again', () => {
  const { ledger } = open();
  ledger.sabotaged('pink', 'reactor');
  assert.equal(ledger.reactorPanel('red', 'reactor'), 0);
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1);
  // Blue decides `fix` again after an interrupt: it stays on its panel.
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1);
  assert.equal(ledger.reactorPanel('red', 'reactor'), 0);
  // Both panels held once each: a tie goes to panel 0.
  assert.equal(ledger.reactorPanel('green', 'reactor'), 0);
});

test('a seat that lets go of its panel or dies no longer counts', () => {
  const { ledger } = open();
  ledger.sabotaged('pink', 'reactor');
  ledger.reactorPanel('red', 'reactor');
  ledger.reactorPanel('blue', 'reactor');
  ledger.releasePanel('blue'); // went off to do a task
  assert.equal(ledger.reactorPanel('green', 'reactor'), 1);
  ledger.died('green');
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1);
});

test('on a tie a seat keeps its panel; it moves only to an emptier one', () => {
  const { ledger } = open();
  ledger.sabotaged('pink', 'reactor');
  ledger.reactorPanel('red', 'reactor'); // 0
  ledger.reactorPanel('blue', 'reactor'); // 1
  ledger.releasePanel('red');
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 1, 'alone on panel 1: Blue does not walk over to 0');
  ledger.reactorPanel('red', 'reactor'); // 0
  ledger.reactorPanel('green', 'reactor'); // one each: 0
  ledger.releasePanel('blue');
  // Panel 1 is empty now and Green shares panel 0 with Red: Green moves.
  assert.equal(ledger.reactorPanel('green', 'reactor'), 1);
});

test('panels start over when the reactor is fixed or a new sabotage starts; other sabotages take the mod\'s choice', () => {
  const { ledger } = open();
  ledger.sabotaged('pink', 'reactor');
  ledger.reactorPanel('red', 'reactor');
  ledger.fixed('reactor');
  assert.equal(ledger.reactorPanel('blue', 'reactor'), 0);
  ledger.sabotaged('pink', 'reactor');
  assert.equal(ledger.reactorPanel('green', 'reactor'), 0);
  assert.equal(ledger.reactorPanel('red', 'lights'), undefined);
});

test('a sabotage is logged once with who did it and closed once, however many copies report the fix', () => {
  const { ledger, events } = open();
  ledger.sabotaged('pink', 'o2');
  ledger.fixed('o2');
  ledger.fixed('o2');
  ledger.fixed('o2');
  ledger.fixed('reactor'); // not the active one
  assert.deepEqual(events, [
    { type: 'sabotage', kind: 'o2', by: 'pink', deadline: null },
    { type: 'sabotage_fixed', kind: 'o2', by: [] },
  ]);
});

test('a kill marks the victim dead, keeps the body\'s room and names the living seats that had the killer in view', () => {
  const { ledger, events } = open({ red: ['Pink', 'Green'], blue: ['Green'], green: ['Pink'] });
  ledger.killed('pink', 'Green', 'O2');
  assert.equal(ledger.alive('green'), false);
  assert.equal(ledger.bodyRoom('Green'), 'O2');
  assert.equal(ledger.bodyRoom('Blue'), null);
  assert.deepEqual(events, [{ type: 'kill', killer: 'pink', victim: 'green', room: 'O2', witnesses: ['red'] }]);
});

test('death is one-way, whichever copy reports it first', () => {
  const { ledger, events } = open();
  assert.equal(ledger.alive('red'), true);
  ledger.died('red'); // the victim's own copy was faster than the killer's
  ledger.killed('pink', 'Red', 'Admin');
  ledger.died('red');
  assert.equal(ledger.alive('red'), false);
  assert.equal(events.filter((e) => e.type === 'kill').length, 1);
});

test('a meeting announces only the deaths since the last one; an ejection is public at once', () => {
  const { ledger } = open();
  ledger.killed('pink', 'Green', 'O2');
  assert.deepEqual(ledger.knownDead(), [], 'nobody has been told yet');
  assert.deepEqual(ledger.announceDead(), ['green']);
  assert.deepEqual(ledger.announceDead(), []);
  ledger.ejected('pink');
  assert.equal(ledger.alive('pink'), false);
  assert.deepEqual(ledger.knownDead(), ['Green', 'Pink']);
  assert.deepEqual(ledger.announceDead(), []);
});
