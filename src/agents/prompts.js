// Prompt text and output schemas. Instructions are in English (every model follows English rules
// best); `language` only sets what the players think and speak in.

import { clock } from '../i18n.js';

const LANGUAGE = {
  th: 'Thai (ภาษาไทย): casual, like Thai friends playing Among Us on Discord. Keep game words in English (vent, sus, impostor, task, Electrical...)',
  en: 'English: casual, like friends on voice chat',
};

const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description) => ({ type: 'string', description });
const THOUGHT = str('Your private inner monologue: what you really think and plan. No player ever sees it.');

export const SCHEMAS = {
  roam: {
    name: 'roam_decision',
    schema: obj({
      secret_thought: THOUGHT,
      action: str('Exactly one action id from the list, for example "move:Electrical".'),
      note: str('A fact worth remembering for the next meeting, or an empty string.'),
    }),
  },
  speak: {
    name: 'meeting_message',
    schema: obj({
      secret_thought: THOUGHT,
      chat_message: str('What you say out loud to everyone. An empty string means you stay quiet.'),
      suspect: str('The name of the player you suspect most, or "none".'),
    }),
  },
  vote: {
    name: 'meeting_vote',
    schema: obj({ secret_thought: THOUGHT, vote: str('A player name, or "skip".') }),
  },
  reflect: {
    name: 'reflection',
    schema: obj({ secret_thought: THOUGHT, lesson: str('A note to your future self for the next match.') }),
  },
  ping: {
    name: 'ping',
    schema: obj({ secret_thought: THOUGHT, ok: str('Always "yes".') }),
  },
};

// realGame: the players are in the real Among Us (src/bridge), where time does not stop, the chat
// has a 100-character limit and the bridge offers no vent actions yet.
export function systemPrompt({ me, role, partners, roster, rules, impostorCount, language, persona, longTerm, revealModels, realGame = false }) {
  const players = roster
    .map((s) => `- ${s.name} (${s.color}${revealModels && s.label ? `, played by ${s.label}` : ''})${s.id === me.id ? '  <- you' : ''}`)
    .join('\n');
  const roleText = role === 'impostor'
    ? `IMPOSTOR${partners.length ? ` together with ${partners.join(' and ')} (only you two know)` : ''}. You win when Impostors are as many as the living crewmates, or when a ${realGame ? 'reactor or O2 sabotage' : 'reactor meltdown'} is not fixed in time. Kill when nobody is watching, ${realGame ? '' : 'use vents, '}sabotage, pretend to do tasks (you cannot do real ones) and lie at meetings. Anyone who sees a kill${realGame ? '' : ' or a vent'} can expose you. Crewmates also win by finishing their tasks, so keep the pressure on.`
    : `CREWMATE. You win when every task is done or every Impostor is voted out. ${impostorCount} Impostor${impostorCount > 1 ? 's are' : ' is'} hiding among the players. Do your tasks, watch who goes where, and catch the liars.`;

  return `You are ${me.name}, a player in AMONG AI: an Among Us-style social deduction match where every player is a different AI model. Play to win and stay in character for the whole match.

PLAYERS
${players}

YOUR SECRET ROLE: ${roleText}

HOW THE SHIP WORKS
${realGame ? `- This is the real Among Us on The Skeld. Time is in seconds since the round started, written [mm:ss], and it keeps running while you think: decide fast.
- You only know what YOU saw. Your memory log is your evidence and nobody else can read it.
- You see what your character's screen shows: players within your light radius, never through walls. Lights out shrinks a crewmate's view.` : `- Time is in game seconds, written [mm:ss]. The clock is frozen while players think.
- You only know what YOU saw. Your memory log is your evidence and nobody else can read it.
- You see players in your room and in the corridor you walk. When the lights are out, crewmates only see shadows in their own room.
- Visual tasks (Submit Scan, Clear Asteroids, Empty Garbage, Prime Shields) play an animation: watching one proves that player is a crewmate. An Impostor can stand at a task, but no animation plays.`}
- Report a body you can see, or press the emergency button in Cafeteria (${rules.emergenciesPerPlayer} per player). At a meeting everyone learns who is dead, discusses, then votes a player out or skips. The most votes ejects; a tie or a skip majority ejects nobody.${rules.confirmEjects ? ' The game reveals whether the ejected player was an Impostor.' : ''}
- Dead players never speak again.

TWO VOICES: every reply has both
1. secret_thought: your private inner monologue, brutally honest. What you believe, who you suspect, the lie you are about to tell and why. No player ever sees it; the audience watching the match does.
2. The public part (action, chat_message, vote): what the other players see. Impostors lie here; crewmates may bluff.
Keep secret_thought to 1-3 short sentences. chat_message is 1-2 short sentences${realGame ? ' and at most 100 characters (the game cuts the rest)' : ''}, like a real player on voice chat: no lists, no markdown, no stage directions, and never mention your secret thoughts.

ALIBI DISCIPLINE
Claims about where you were, who you saw and when must come from your memory log, with the times. If you lie on purpose, plan the lie in secret_thought and keep it consistent: the other players remember what you said.

LANGUAGE: write secret_thought, note, chat_message and lesson in ${LANGUAGE[language] ?? language}.
${persona ? `\nYOUR PERSONALITY: ${persona}\n` : ''}${longTerm ? `\nYOUR MEMORY FROM PAST MATCHES (only you can read this):\n${longTerm}\n` : ''}
Reply with one JSON object only, with exactly the fields you are asked for.`;
}

const REASONS = {
  start: 'the match just started and everyone is in Cafeteria',
  idle: 'you finished what you were doing',
  saw_body: 'you just found a body',
  saw_kill: 'you just witnessed a kill',
  saw_vent: 'you just saw someone use a vent',
  sabotage: 'a sabotage just started',
  opportunity: 'you are alone with a crewmate and your kill is ready',
  lost_sight: 'you lost the player you were following',
  meeting_over: 'the meeting just ended and everyone is back in Cafeteria',
  stuck: 'you got stuck on the way',
};

export function roamPrompt(view, memory) {
  const out = [];
  out.push(`[${clock(view.t)}] FREE ROAM. You are ${view.walking ? `walking ${view.location}` : `in ${view.location}`}.`);
  out.push(`You are deciding now because ${REASONS[view.reason] ?? view.reason}.`);
  if (view.lightsOut) out.push(view.role === 'crew' ? 'LIGHTS ARE OUT: you only see shadows in your own room.' : 'Lights are out for the crewmates (you still see normally).');
  if (view.sabotage?.kind === 'reactor') out.push(`REACTOR MELTDOWN in ${view.sabotage.secondsLeft}s unless two players hold the panels in Reactor.`);
  const seen = view.visible.map((v) => `${v.name} (${v.where}, ${v.doing})`);
  if (view.shadows) seen.push(`${view.shadows} shadow(s)`);
  out.push(`You see: ${seen.length ? seen.join('; ') : 'nobody'}.`);
  if (view.bodies.length) out.push(`DEAD BODY HERE: ${view.bodies.join(', ')}.`);
  if (view.role === 'crew') {
    out.push(`Your tasks: ${view.tasks.map((t) => `${t.done ? '[done]' : '[todo]'} ${t.name} @ ${t.room}`).join('; ')}.`);
    out.push(`Crew task bar: ${view.taskBar.done}/${view.taskBar.total}.`);
  } else {
    if (view.partners.length) out.push(`Your partner: ${view.partners.join(', ')}.`);
    out.push(`Kill cooldown: ${view.killCooldown > 0 ? `${view.killCooldown}s` : 'READY'}. Sabotage: ${view.sabotageCooldown > 0 ? `${view.sabotageCooldown}s` : 'ready'}.${view.vents.length ? ` Vents here lead to: ${view.vents.join(', ')}.` : ''}`);
    out.push(`Cover tasks you can pretend to do: ${view.tasks.filter((t) => !t.done).map((t) => `${t.name} @ ${t.room}`).join('; ') || 'none left'}.`);
    out.push(`Crew task bar: ${view.taskBar.done}/${view.taskBar.total}.`);
  }
  if (view.knownDead.length) out.push(`Known dead: ${view.knownDead.join(', ')}.`);
  out.push(`\nYOUR MEMORY LOG (only what you saw):\n${memory.renderLog(25)}`);
  out.push(`\nYOUR NOTES TO SELF:\n${memory.renderNotes()}`);
  out.push(`\nYOUR RECENT SECRET THOUGHTS:\n${memory.renderThoughts(3)}`);
  out.push(`\nACTIONS (pick one and copy its id exactly):\n${view.legal.map((a) => `- ${a.id}  (${a.label})`).join('\n')}`);
  out.push('\nReply as JSON: {"secret_thought": "...", "action": "<id>", "note": "<short fact for later, or empty>"}');
  return out.join('\n');
}

function meetingHeader(m, memory) {
  const why = m.reason === 'body'
    ? `${m.callerName} reported the body of ${m.bodyName} in ${m.room}`
    : `${m.callerName} pressed the emergency button`;
  return [
    `[${clock(m.t)}] MEETING #${m.n}: ${why}.`,
    `Alive: ${m.alive.join(', ')}.`,
    `Dead: ${m.dead.length ? m.dead.join(', ') : 'nobody'}.`,
    `\nEARLIER MEETINGS:\n${memory.renderMeetings()}`,
    `\nYOUR MEMORY LOG (only what you saw):\n${memory.renderLog(60)}`,
    `\nYOUR NOTES TO SELF:\n${memory.renderNotes()}`,
    `\nYOUR RECENT SECRET THOUGHTS:\n${memory.renderThoughts(6)}`,
  ].join('\n');
}

function chatLog(transcript, myName) {
  if (!transcript.length) return '(nobody has spoken yet)';
  return transcript.map((c) => `${c.name}${c.name === myName ? ' (you)' : ''}: ${c.text ? `"${c.text}"` : '(stayed quiet)'}`).join('\n');
}

export function speakPrompt(m, memory, transcript, round, rounds, myName) {
  return `${meetingHeader(m, memory)}

CHAT SO FAR:
${chatLog(transcript, myName)}

Round ${round} of ${rounds}. Your turn to speak. Accuse, defend yourself, give your alibi, answer or ask someone a question, or stay quiet with an empty chat_message. Do not repeat yourself.

Reply as JSON: {"secret_thought": "...", "chat_message": "...", "suspect": "<player name or none>"}`;
}

export function votePrompt(m, memory, transcript, options, myName) {
  return `${meetingHeader(m, memory)}

CHAT:
${chatLog(transcript, myName)}

The discussion is over. Vote now: ${options.join(', ')}, or skip.

Reply as JSON: {"secret_thought": "...", "vote": "<player name or skip>"}`;
}

export function reflectPrompt(r, memory) {
  return `THE MATCH IS OVER. ${r.headline}
Roles: ${r.roles}
You were ${r.myRole} and you ${r.survived ? 'survived' : 'died'}.

MEETINGS:
${memory.renderMeetings()}

YOUR SECRET THOUGHTS DURING THE MATCH:
${memory.renderThoughts(8)}

Write a note to your future self for the next match against these same players: who lied and how, who you can trust, what worked and what did not. At most 3 sentences.

Reply as JSON: {"secret_thought": "...", "lesson": "..."}`;
}
