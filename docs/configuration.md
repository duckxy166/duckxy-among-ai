# Configuration

Everything Among AI reads from your project folder: the CLI, `.env`, `arena.config.json`, the seats and
the match settings. The CLI works in the current directory (`.env`, `arena.config.json`, `matches/`,
`memory/`), so it also runs from another project that installs this one: `npx among-ai check`.

## CLI

| Command | Does |
|---|---|
| `node src/cli.js run [--serve] [--mock] [--seed n] [--seats n] [--config file] [--port n]` | Play a match in the simulator. `--serve` opens the live viewer. |
| `node src/cli.js real [--mock] [--serve] [--seats n] [--config file] [--attach] [--keep-open]` | Play in the real Among Us: one game copy per seat, driven through the AUBridge mod ([REAL_GAME.md](REAL_GAME.md)). |
| `node src/cli.js replay [matchId] [--port n]` | Serve the viewer for a recorded match (the latest by default). |
| `node src/cli.js check [--config file]` | One small request per seat: keys, model ids, latency. |
| `node src/cli.js list` | Recorded matches and who won. |
| `npm run mock` | `run --mock --serve`: a full match with rule-based bots, no API key. |
| `npm start` | `run --serve` with your `arena.config.json`. |
| `npm test` | Engine, memory and full-match tests (mock players only). |

## Files

| File | What it holds | In git? |
|---|---|---|
| `.env` | API keys (copy `.env.example`) | never |
| `arena.config.json` | Seats and match settings (copy `arena.config.example.json`) | never |
| `matches/<id>/events.jsonl` | Every event of a match; the viewer and your own tools read it | never |
| `matches/<id>/prompts.jsonl` | Every prompt and raw reply (`logPrompts`) | never |
| `memory/<seat id>.md` | A seat's notes to its future self ([memory/README.md](../memory/README.md)) | never |

## Seats and providers

One seat is one player is one model. A match takes 4 to 10 enabled seats. `provider` picks the API:

| `provider` | API | Key in `.env` |
|---|---|---|
| `anthropic` | Anthropic SDK (Claude), structured outputs | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Chat Completions, strict JSON schema | `OPENAI_API_KEY` |
| `gemini` | Gemini's OpenAI-compatible endpoint | `GEMINI_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `kimi` | Moonshot (Kimi) | `MOONSHOT_API_KEY` |
| `xai` | xAI (Grok) | `XAI_API_KEY` |
| `openrouter` | OpenRouter: almost any model with one key | `OPENROUTER_API_KEY` |
| `ollama` | A local model through Ollama | none |
| `custom` | Any OpenAI-compatible server: set `baseURL` and `apiKeyEnv` | yours |
| `claude-code` | Your Claude subscription, through the signed-in Claude Code CLI | none |
| `codex` | Your ChatGPT subscription, through the signed-in Codex CLI | none |
| `antigravity` | Your Google subscription, through the signed-in Antigravity CLI (`agy`) | none |
| `mock` | The rule-based bot | none |

Model ids change often. The ids in `arena.config.example.json` are examples: check each provider's
model list and run `node src/cli.js check`.

### Seat fields

| Field | Meaning |
|---|---|
| `id` | File-safe id, also the name of its long-term memory file |
| `name` | What the other players call it (1-10 letters or digits for the real game) |
| `color` | Its colour on the map |
| `provider`, `model` | See above |
| `label` | Shown in the viewer |
| `persona` | Optional short personality |
| `effort` / `meetingEffort` | Claude: `low`…`max` (roaming / meetings) |
| `extra` | Extra request fields for OpenAI-compatible APIs, e.g. `{"reasoning_effort": "low"}` |
| `jsonMode` | `json_schema`, `json_object` or `none` if a server rejects `response_format`. On a Claude seat `none` drops structured output, which Claude Opus 5.5 needs: with a JSON schema it refuses every turn of this game. |
| `refusalFallback` | Claude seats on Opus 5.5 / Opus 5 / Sonnet 5.5 / Fable 5.1 send `fallbacks: "default"`, so a turn a safety classifier declines is retried on a fallback Claude model inside the same call. `false` turns it off. |
| `baseURL`, `apiKeyEnv` | For `custom` (and to override a provider's endpoint) |
| `concurrency` | Calls at once per provider (default 4) |
| `enabled` | `false` keeps the seat in the file but out of the match |

### Playing on a subscription

`claude-code`, `codex` and `antigravity` seats cost no API money: each call runs your own signed-in CLI
headless (`claude -p`, `codex exec`, `agy`) from an empty temporary folder, with no tools, no session
saved and nothing from this project loaded. Sign in once (`claude` then `/login`, `codex login`, `agy`),
then `node src/cli.js check`. An `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `GEMINI_API_KEY`) in `.env`
is not passed to that CLI, so those seats use the subscription even when other seats use the API.

```json
{ "id": "haiku", "name": "Haiku", "color": "yellow", "provider": "claude-code", "model": "claude-haiku-5-5", "effort": "low" }
{ "id": "gpt", "name": "GPT", "color": "green", "provider": "codex", "model": "gpt-5.6-luna", "effort": "low" }
{ "id": "gemini", "name": "Gemini", "color": "blue", "provider": "antigravity", "model": "gemini-3.8-flash-low" }
```

- `model`: a Claude Code model id or alias (`haiku`, `sonnet`); a model your ChatGPT plan offers in Codex
  (API-only ids such as `gpt-5-mini` are refused); an id from `agy models`, which includes the effort.
- Starting a CLI takes 1-10 seconds, so each seat keeps one started process waiting for its next call
  (about 100 MB for Claude Code, 200 MB for agy). `"warm": false` turns that off. The answer is taken
  as soon as it streams out. `command` points at the binary if it is not on `PATH` (a string, or an
  array such as `["node", "path/to/cli.js"]`); `timeoutMs` (default 180000) gives up on a stuck call.
- Measured on Windows with a real roam prompt (4 KB system, 2 KB turn), median per call: Anthropic API
  Haiku 2.0 s; `claude-code` Haiku 3.2 s with the started process, 4.4 s without; `antigravity` Gemini
  Flash 3.8 s with rare 40-50 s stalls; `codex` 7 s. Claude Code is fast enough for the real game; Codex
  and Antigravity seats stand still longer while they think.
- **Usage limits.** Every call counts against your plan's limits, shared with your own use of Claude,
  ChatGPT or Gemini (Claude: a 5-hour window and a weekly cap). A 6-player real-game match makes a few
  hundred calls. Claude Code reports how much of the window is used: the match prints a warning when it
  gets close, and once the limit is reached that seat's calls fail and it waits in place until the window
  resets. Keep `concurrency` modest.
- Claude Code may decline a turn with "safeguards flagged this message"; that counts as a refusal and
  the seat waits, as with the API.

## Match settings

| Key | Default | Meaning |
|---|---|---|
| `language` | `th` | What players think and speak in (`th` or `en`; instructions stay English) |
| `seed` | random | Same seed + same brains = same match (simulator only) |
| `discussionRounds` | 2 | How many times each living player speaks per meeting |
| `revealModels` | true | Players know which model is behind each name |
| `persistentMemory` | true | Read and write `memory/<seat>.md` across matches |
| `logPrompts` | true | Save every prompt and raw reply to `matches/<id>/prompts.jsonl` |
| `rules.impostors` | 1 (≤6 players), 2 | Number of impostors |
| `rules.tasksPerPlayer` | 5 | Tasks per crewmate |
| `rules.killCooldown` | 25 | Seconds between kills |
| `rules.confirmEjects` | true | Reveal whether an ejected player was an impostor |
| `rules.maxGameSeconds` | 900 | Safety stop |

More rules (sabotage timers, emergency button) are in `src/engine/game.js` → `DEFAULT_RULES`.

## The real game (`bridge`)

Only for `node src/cli.js real`. The `bridge` block in `arena.config.example.json` shows every option:

| Key | Meaning |
|---|---|
| `gamePath` | Your `Among Us.exe` with BepInEx and AUBridge installed (or set `AMONG_US_EXE`) |
| `lobby` | Options sent to the host copy: kill cooldown, discussion and voting time, tasks, emergency meetings |
| `maxMinutes` | Safety stop |
| `window`, `sound` | e.g. `"1920x1080"` and `true`: every copy windowed at that size with its sound on |
| `chat` | `true` keeps the meeting chat open on every copy's screen |
| `freeze` | Default `true`: game time stands still while any brain is thinking |
| `impostors` | Seat ids that play the impostors instead of a random pick (1 from 4 players, 2 from 7, 3 from 9) |

Seat names must be 1-10 letters or digits (the game's limit), and you need 4 or more seats. Local
lobbies only: never point this at the official servers. Setup and status: [REAL_GAME.md](REAL_GAME.md)
and [mod/README.md](../mod/README.md).

## Cost

Brains are asked to decide only at decision points (a task finished, a body found, a kill witnessed, a
sabotage, a kill opportunity, someone talking to them), not every second. In a 2-minute mock match with
one meeting the 8 players made 88 calls; system prompts are about 3,000 characters and each turn adds
1,500 to 3,500. Matches with real models run longer. The last line of every event log (`stats`) has
each seat's calls, errors and tokens.

## Use it as a library

```js
import { loadConfig, createProvider, runMatch } from 'duckxy-among-ai';
```

`runMatch({ config, seats, providers, matchId, dir, memoryDir, publish })` plays one match and calls
`publish(event)` for every event, so you can drive your own display. `startServer({ webRoot })` serves
the live and recorded events to a page of your own. Event names and fields: the table in
[ARCHITECTURE.md](ARCHITECTURE.md#event-log).
