import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agents/agent.js';
import { SCHEMAS, roamSchema } from '../src/agents/prompts.js';

const SEAT = { id: 'red', name: 'Red', effort: 'low', model: 'script' };

// A scripted provider that records the schema each turn was asked with and replies with `reply`
// (an object per kind, or a function of the context). Follows the pattern in test/bridge.test.js.
function recorder(reply) {
  const seen = [];
  const provider = {
    async complete({ user, schema, context }) {
      seen.push({ kind: context.kind, schema, user });
      const out = typeof reply === 'function' ? reply(context) : reply[context.kind];
      return { text: JSON.stringify(out), refused: false, model: 'script', usage: {} };
    },
  };
  return { provider, seen };
}

// A minimal roam view: three legal actions for this turn.
function roamView(legal = [{ id: 'move:Electrical', label: 'go to Electrical' }, { id: 'wait:5', label: 'wait' }, { id: 'report', label: 'report body' }]) {
  return {
    t: 10, location: 'Cafeteria', role: 'crew', reason: 'idle', walking: false,
    visible: [], shadows: 0, bodies: [], knownDead: [], tasks: [], taskBar: { done: 0, total: 5 },
    legal,
  };
}

test('roamSchema builds the action enum from the legal ids and returns the base schema on empty', () => {
  const ids = ['move:Electrical', 'wait:5', 'report'];
  const s = roamSchema(ids);
  assert.deepEqual(s.properties.action.enum, ids);
  // Same fields, same order, still a string: only `enum` was added to `action`.
  assert.equal(s.properties.action.type, 'string');
  assert.deepEqual(Object.keys(s.properties), Object.keys(SCHEMAS.roam.schema.properties));
  assert.deepEqual(s.required, SCHEMAS.roam.schema.required);
  // The other fields are untouched and carry no enum.
  for (const k of ['secret_thought', 'say', 'note']) assert.equal(s.properties[k].enum, undefined);

  // The shared base schema is never mutated.
  assert.equal(SCHEMAS.roam.schema.properties.action.enum, undefined);

  // An empty (or missing) legal list returns the base schema unchanged (no provider-rejected empty enum).
  assert.equal(roamSchema([]), SCHEMAS.roam.schema);
  assert.equal(roamSchema(), SCHEMAS.roam.schema);
  assert.equal(SCHEMAS.roam.schema.properties.action.enum, undefined);
});

test('a roam turn is asked with an action enum equal to this turn\'s legal ids', async () => {
  const view = roamView();
  const { provider, seen } = recorder({ roam: { secret_thought: 't', action: 'move:Electrical', say: '', note: '' } });
  const agent = new Agent({ seat: SEAT, role: 'crew', provider, system: 'sys' });
  const r = await agent.decideRoam(view);

  assert.equal(r.action, 'move:Electrical');
  const asked = seen.find((s) => s.kind === 'roam');
  assert.deepEqual(asked.schema.properties.action.enum, view.legal.map((a) => a.id));
});

test('vote and speak turns carry no action enum (only roam is constrained)', async () => {
  const meeting = { t: 20, n: 1, reason: 'body', callerName: 'Red', bodyName: 'Green', room: 'Cafeteria', alive: ['Red', 'Blue'], dead: ['Green'] };
  const { provider, seen } = recorder({
    speak: { secret_thought: 't', chat_message: 'hi', suspect: 'none' },
    vote: { secret_thought: 't', vote: 'skip' },
  });
  const agent = new Agent({ seat: SEAT, role: 'crew', provider, system: 'sys' });
  await agent.speak(meeting, [], 1, 1);
  await agent.vote(meeting, [], ['Blue']);

  const speak = seen.find((s) => s.kind === 'speak');
  const vote = seen.find((s) => s.kind === 'vote');
  assert.equal(speak.schema, SCHEMAS.speak.schema);
  assert.equal(vote.schema, SCHEMAS.vote.schema);
  assert.equal('action' in speak.schema.properties, false);
  assert.equal('action' in vote.schema.properties, false);
});

test('fallback: an off-enum but resolvable action still lands on a legal id via matchAction', async () => {
  const view = roamView();
  // Simulates a json_object provider that ignored the enum and echoed the id with the label after it.
  const { provider } = recorder({ roam: { secret_thought: 't', action: 'move:Electrical (go to Electrical)', say: '', note: '' } });
  const agent = new Agent({ seat: SEAT, role: 'crew', provider, system: 'sys' });
  const r = await agent.decideRoam(view);
  assert.equal(r.action, 'move:Electrical');
  assert.equal(agent.stats.invalid, 0);
});

test('fallback: a truly off-list action becomes wait:5 and counts as invalid', async () => {
  const view = roamView();
  const { provider } = recorder({ roam: { secret_thought: 't', action: 'fly:Mars', say: '', note: '' } });
  const agent = new Agent({ seat: SEAT, role: 'crew', provider, system: 'sys' });
  const r = await agent.decideRoam(view);
  assert.equal(r.action, 'wait:5');
  assert.equal(r.raw, 'fly:Mars');
  assert.equal(agent.stats.invalid, 1);
});
