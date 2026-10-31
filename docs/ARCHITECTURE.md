# How Among AI works

```
            ┌──────────── engine (src/engine) ─────────────┐
            │ ship map · movement · vision · tasks · kills │
            │ sabotage · meetings · votes · win check      │
            └──────┬───────────────────────────▲───────────┘
   obs lines for   │ view(id) + legal actions  │ act(id, "move:Electrical")
   ONE player only │                           │
            ┌──────▼─────────── agent (src/agents) ────────┴──┐
            │ EpisodicMemory (private) → prompt → provider    │
            │ ← JSON { secret_thought, action / chat / vote } │
            └──────┬──────────────────────────────────────────┘
                   │ every event
            ┌──────▼──────── runner (src/match) ───────────────┐
            │ matches/<id>/events.jsonl · prompts.jsonl ·      │
            │ live SSE → viewer (web/)                         │
            └──────────────────────────────────────────────────┘
```

## The engine is the body

`src/engine/game.js` runs the match in game seconds. Each `step()`:

1. counts down cooldowns, moves walkers along corridors, advances tasks and fixes;
2. works out what every living player can see (`canSee`) and compares it with the second before;
3. writes the differences as observation lines (`obs`) into that one player's log, e.g. *entered*,
   *left toward*, *passed in the corridor*, *found a body*, *saw a kill*, *saw a vent*;
4. checks the win conditions.

**Vision.** You see everyone in your room, everyone in the corridor you walk, and anyone within 1.5 s
of the door of the room you stand in. With the lights out a crewmate only sees anonymous shadows in their
own room (a kill in the dark is "a shadow killed X"). Impostors are not affected.

**Decision points.** Brains are not asked every second. A player is asked (`needs`) when the match
starts, when its current order is finished, after a meeting, and when something interrupts it: finding a
body, witnessing a kill or a vent, a sabotage, losing the player it follows, someone talking to it (see
below), or (impostor only) being alone with one crewmate with the kill ready. Orders are high level (`move:Admin`, `task:scan`,
`follow:GPT`, `kill:Kimi`, `vent:Navigation`, `sabotage:lights`, `fix`, `report`, `emergency`,
`wait:5`) and the engine carries them out over the next seconds.

**Talking on the ship.** A free-roam reply has a `say` field. `Game.speak()` gives the line to every
living player who can see the speaker right now (`canSee`; a crewmate in the dark gets "a voice in the
dark" without the name) as a `heard` memory line, and gives the speaker a `you_said` line with who heard
it and which named players were out of earshot (not for a crewmate in the dark, who cannot tell). A
listener is woken (reason `heard`) when the line names it, when it is the answer of someone it spoke to
in the last `replySeconds`, or during a sabotage; at most once per `talkWakeSeconds`, and only on the
next second, so its own order from the same round does not swallow the wake-up. To talk to someone
out of sight a player walks to where its log last saw them, or follows them. A player told to do the job
it is already doing carries on instead of starting it over.

**Frozen time.** The runner asks every pending brain in parallel and waits for all of them before the
next game second. A model that takes 20 s to answer loses no game time, and a match is reproducible
from its seed with the same brains.

## The agent is the brain

`src/agents/agent.js`. One `Agent` per player, holding:

- **`EpisodicMemory`** (`memory.js`): the timestamped observation log the engine wrote for this player,
  the player's own notes to self (`note` field), its own past `secret_thought`s, and the public record of
  every meeting. Recent lines are sent verbatim; older routine lines collapse into a route
  (`[00:00–01:40] route: Cafeteria → Admin → Storage`); evidence (bodies, kills, vents, visual tasks,
  meeting results) is never dropped.
- **A fixed system prompt** (`prompts.js`): role, partner (impostors), rules, the "two voices" contract,
  language, optional persona and the note from past matches. It stays byte-identical for the match so
  providers can cache it.

Every request asks for JSON with a `secret_thought` plus the public part:

| Moment | Public fields |
|---|---|
| Free roam | `action` (an id from the list), `say` (out loud, or empty) and `note` |
| Meeting, speaking | `chat_message` and `suspect` |
| Meeting, voting | `vote` |
| After the match | `lesson` (saved to `memory/<seat>.md`) |

Claude seats get the schema enforced with structured outputs; OpenAI gets a strict JSON schema; other
OpenAI-compatible providers get JSON mode plus the schema in the prompt, and so do the subscription CLIs
(`claude-code`, `codex`, `antigravity`, one headless CLI run per call). Bad JSON is retried once, an
unknown action becomes `wait:5`, and either counts as `invalid` in the seat's stats.

**Isolation.** A brain gets `view(id)` (its own surroundings), its own memory and the public meeting
record. It never gets another player's memory or thoughts. `test/match.test.js` plays a match with mock
brains that tag their thoughts and fails if any prompt contains another player's tag.

## Meetings

Called by a report or the emergency button. Everyone alive is moved to Cafeteria and learns who is
dead. Then `discussionRounds` rounds: the caller speaks first, then seat order; each speaker sees the
chat so far. Votes are collected in parallel and shown together. A strict plurality over every other
option (including skip) ejects; ties eject nobody. The meeting's public record (lines, votes, result)
goes into every player's memory.

## The real game (src/bridge)

`node src/cli.js real` swaps the body: every seat plays one Among Us copy through the AUBridge mod
(newline JSON on `127.0.0.1:47000+n`, details in [REAL_GAME.md](REAL_GAME.md)). The brain does not change.

- **Seat** (`seat.js`): long-polls its copy's events and writes them into that seat's memory with the
  simulator's kinds and wording (`saw_player`, `saw_body`, `saw_kill`, `task_done`, `arrived`...).
  `view()` and `legalActions()` are built from the copy's `state` in the simulator's shapes, and an
  action becomes an `act` (`move:O2` → `move_to {room: "LifeSupp"}`). Room names are mapped both ways
  (`skeld.js`), so prompts and the viewer use the same names as the simulator.
- **Real time** (`runner.js`): nothing waits for a model. A seat decides when something wakes it (start,
  arrived, task done, saw a body or a kill, lost sight, a timer, the meeting ended); its body keeps doing
  the last action meanwhile. A plan that ends while a new decision is under way wakes nobody.
- **Meetings**: the seats speak in turns through the game chat (100 characters, cut at a word), then each
  waits until its own copy opens voting and votes. The game decides the result; the runner writes the
  same `vote_result` and public meeting record as the simulator.
- **Talking**: the game has no chat outside meetings, so the runner relays a `say` line itself to every
  seat whose copy shows the speaker (`saw_player` / `lost_player`), with the simulator's memory lines and
  wake-up rules. It shows up in memories, the event log and the viewer, not on the game screen.
- **Ghosts**: a dead crewmate's copy keeps doing tasks on AUBridge's autopilot. A dead impostor still
  sabotages; its brain is asked only when a sabotage is ready.
- **Tests** use `test/fake-bridge.js`, a small fake of the mod with the same protocol and events.

## Game rules in short

- 4 to 10 players; 1 impostor up to 6 players, 2 above (configurable).
- Crewmates win by finishing all tasks (ghosts keep doing theirs) or ejecting every impostor.
- Impostors win at parity or when a reactor meltdown is not fixed by two players within 40 s.
- Visual tasks (Submit Scan, Clear Asteroids, Empty Garbage, Prime Shields) show an animation to
  watchers; an impostor faking one shows none.
- Kill cooldown 25 s (12 s at the start), sabotage cooldown 30 s, one emergency meeting per player.

## Event log

`matches/<id>/events.jsonl`, one JSON object per line with `seq`, `t` (game seconds) and `type`. The
viewer is built only from this file, so a match can be replayed forever, and so can anything else you
build on top (stats, highlight finders, your own overlay).

| type | fields |
|---|---|
| `match_start` | players (with roles and models), map, rules, seed, language |
| `thinking` | players being asked right now |
| `decision` | p, reason, thought, action, raw, say, note, error, ms, model |
| `say` | p, text, room, heard (ids), anon (heard only a voice), missed (named but out of earshot) |
| `intent` | p, action (accepted by the engine) |
| `move` / `arrive` | p, from/to/dur · p, room |
| `task_start` / `task_done` / `taskbar` | p, task, room, visual · done, total |
| `kill` / `vent` | killer, victim, room, witnesses · p, from, to |
| `sabotage` / `sabotage_fixed` | kind, by, deadline · kind, by |
| `memory` | p, kind, text: one line of one player's memory |
| `meeting_start` / `chat` / `vote` / `vote_result` / `meeting_end` | n, caller, body · p, round, text, thought, suspect · p, target, thought · ejected, tally, wasImpostor |
| `game_over` / `reflection` / `match_error` | winner, reason, roles · p, lesson · error |
| `stats` (always last) | seats: per seat calls, errors, invalid, refusals, ms, input/output/cached tokens |

## Files

| Path | What |
|---|---|
| `src/engine/map.js` | Rooms, corridors, vents, tasks, colours, path finding |
| `src/engine/game.js` | The match state machine (`DEFAULT_RULES` at the top) |
| `src/i18n.js` | Memory-log sentences in Thai and English |
| `src/agents/` | Agent, memory, prompts and output schemas |
| `src/providers/` | Anthropic, OpenAI-compatible, subscription CLI (`cli.js`) and mock brains |
| `src/match/runner.js` | Runs a match and writes the event log |
| `src/bridge/` | The real game through AUBridge: client, seat, real-time runner, launcher, Skeld names |
| `src/server/server.js` | Viewer server: static files, live SSE, saved matches (`webRoot` swaps the page) |
| `src/index.js` | Library entry point (`import { runMatch } from 'duckxy-among-ai'`) |
| `web/` | The viewer (plain HTML/CSS/JS, no build step) |
