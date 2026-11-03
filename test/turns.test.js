import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingTurns, names } from '../src/match/turns.js';
import { speakPrompt, systemPrompt } from '../src/agents/prompts.js';

const seats = ['Red', 'Blue', 'Haiku 3', 'Pink'].map((name) => ({ name }));
const [red, blue, h3, pink] = seats;

function play(rounds, said) {
  const turns = meetingTurns(seats, rounds);
  const out = [];
  for (let t = turns.next(); t; t = turns.next()) {
    out.push(`${t.round}:${t.seat.name}${t.replyTo ? `<${t.replyTo.name}` : ''}`);
    const [text, accused] = said(t) ?? [];
    turns.heard(t.seat, text ?? '', accused ?? null);
  }
  return out;
}

test('a meeting goes around the table, and an accused player answers at once, once per round', () => {
  assert.deepEqual(play(2, () => null), ['1:Red', '1:Blue', '1:Haiku 3', '1:Pink', '2:Red', '2:Blue', '2:Haiku 3', '2:Pink']);
  // Red names Pink: Pink answers next, in place of its own turn this round.
  assert.deepEqual(play(1, (t) => (t.seat === red ? ['pink is sus!!', pink] : null)), ['1:Red', '1:Pink<Red', '1:Blue', '1:Haiku 3']);
  // Blue accuses Pink, Pink turns it back, Blue (who has spoken) gets one extra answer, and the
  // ping-pong stops there: Pink has answered in this round already.
  assert.deepEqual(play(1, (t) => (t.seat === pink ? ['it was blue', blue] : t.seat === blue ? ['no, PINK did it', pink] : null)),
    ['1:Red', '1:Blue', '1:Pink<Blue', '1:Blue<Pink', '1:Haiku 3']);
  // A suspicion that is never said out loud, or a name that is next anyway, changes nothing.
  assert.deepEqual(play(1, (t) => (t.seat === red ? ['hmm', h3] : t.seat === blue ? ['haiku3?', h3] : null)), ['1:Red', '1:Blue', '1:Haiku 3', '1:Pink']);
  assert.ok(names('Haiku3 โกหก', 'Haiku 3') && !names('Haiku 3', 'Haiku 4'));
});

test('meeting prompts ask for player talk: no clock times, an answer when accused', () => {
  const memory = { renderMeetings: () => '', renderLog: () => '', renderNotes: () => '', renderThoughts: () => '' };
  const m = { n: 1, t: 30, reason: 'button', callerName: 'Red', alive: ['Red', 'Pink'], dead: [] };
  assert.match(speakPrompt(m, memory, [], 1, 2, 'Pink', 'Red'), /Red just accused you/);
  assert.doesNotMatch(speakPrompt(m, memory, [], 1, 2, 'Pink'), /just accused you/);
  const sys = systemPrompt({ me: { id: 'pink', name: 'Pink' }, role: 'crew', partners: [], roster: [{ id: 'pink', name: 'Pink', color: 'pink' }], rules: { emergenciesPerPlayer: 1, confirmEjects: true }, impostorCount: 1, language: 'th', realGame: true });
  assert.match(sys, /never quote one/);
});
