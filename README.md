# Among AI

A multi-model arena where **Claude, GPT, Gemini, DeepSeek, Kimi, Grok** and friends play an
Among Us-style social deduction game against each other: 4 to 10 AI players in one match, each with
its own memory, each lying, accusing and reasoning in its own voice.

Made by **[Duckxy](https://www.youtube.com/@LDuckxy)** ([GitHub](https://github.com/duckxy166)).
Open source under MIT. Please keep the credit (see [Credit](#credit)).

> ภาษาไทยอยู่ด้านล่าง ↓

## Features

- **Separate memories.** Every player only knows what its own character saw. The engine writes each
  sighting into that player's private log with the game time: `[01:10] Spotted Gemini at Electrical`,
  `[01:25] Gemini left Electrical heading to Storage`. At a meeting the log becomes the player's alibi
  and evidence. No player can read another player's memory (a test checks this).
- **Two voices.** Every reply has a `secret_thought` (the real plan, the lie being prepared) and a public
  part (the action, the chat line, the vote). Players never see each other's thoughts; the event log and
  the viewer keep both, so you can watch an AI lie with a straight face.
- **Many models, one match.** Each seat is a different model and provider. Game time stands still while
  a model thinks, so a slow model is never punished for latency, and a match replays from its seed.
- **Memory across matches.** After a match every model writes a note to its future self ("GPT lied about
  Electrical twice") and reads it in the next match.
- **A match viewer** in the browser: the ship map, every player's latest thought and line, the memory of
  any player, the full log. Live or replayed.
- **Everything in one log** (`matches/<id>/events.jsonl`) to build your own tools on.

## Quick start

Needs Node.js 20.12 or newer.

```bash
npm install
npm run mock
```

`npm run mock` plays a full match with rule-based bots (no API key, no cost) and opens the viewer at
<http://localhost:7777>. Then set up real models:

```bash
cp arena.config.example.json arena.config.json
cp .env.example .env
```

Put your API keys in `.env`, pick models in `arena.config.json`, then check every seat with one tiny
request each before spending on a full match:

```bash
node src/cli.js check
npm start
```

| Command | Does |
|---|---|
| `node src/cli.js run [--serve] [--mock] [--seed n] [--seats n] [--config file]` | Play a match. `--serve` opens the live viewer. |
| `node src/cli.js real [--mock] [--serve] [--seats n] [--config file] [--attach] [--keep-open]` | Play in the real Among Us: one game copy per seat, driven through the AUBridge mod (see [Real Among Us](#real-among-us)). |
| `node src/cli.js replay [matchId]` | Serve the viewer for a recorded match (the latest by default). |
| `node src/cli.js check` | One small request per seat: keys, model ids, latency. |
| `node src/cli.js list` | Recorded matches and who won. |
| `npm test` | Engine, memory and full-match tests (mock players only). |

The CLI works in the current directory (`.env`, `arena.config.json`, `matches/`, `memory/`), so it also
runs from another project that installs this one: `npx among-ai check`.

## Seats and providers

One seat is one player is one model. `provider` picks the API:

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
| `mock` | The rule-based bot | none |

Model ids change often. The ids in `arena.config.example.json` are examples: check each provider's
model list and run `node src/cli.js check`.

Seat fields: `id` (file-safe, used for its long-term memory file), `name` (what the other players call
it), `color`, `provider`, `model`, `label` (shown in the viewer), and optionally `persona` (a short
personality), `effort` / `meetingEffort` (Claude: `low`…`max`), `extra` (extra request fields for
OpenAI-compatible APIs, e.g. `{"reasoning_effort": "low"}`), `jsonMode` (`json_schema`, `json_object`
or `none` if a server rejects `response_format`), `baseURL`, `apiKeyEnv`, `concurrency`,
`enabled: false`.

Claude seats on Opus 5.5 / Opus 5 / Sonnet 5.5 / Fable 5.1 send `fallbacks: "default"`: if a safety
classifier declines a turn, the API retries it on a fallback Claude model inside the same call. Set
`"refusalFallback": false` on the seat to turn it off.

## Match settings

| Key | Default | Meaning |
|---|---|---|
| `language` | `th` | What players think and speak in (`th` or `en`; instructions stay English) |
| `seed` | random | Same seed + same brains = same match |
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

## How it works

The engine (`src/engine/`) is the body: it walks players around a Skeld-like ship one game second at
a time, decides who can see whom, and writes what each player saw into that player's memory. The brains
(`src/agents/`) only get a view of their own surroundings, their own memory log, notes and past thoughts,
and a list of legal actions. They are asked to decide only at decision points (a task finished, a body
found, a kill witnessed, a sabotage, a kill opportunity), not every second, which keeps the cost down.
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

In a 2-minute mock match with one meeting the 8 players made 88 calls; system prompts are about
3,000 characters and each turn adds 1,500 to 3,500. Matches with real models run longer. The last line
of every event log (`stats`) has each seat's calls, errors and tokens.

## Use it as a library

```js
import { loadConfig, createProvider, runMatch } from 'duckxy-among-ai';
```

`runMatch({ config, seats, providers, matchId, dir, memoryDir, publish })` plays one match and calls
`publish(event)` for every event, so you can drive your own display. `startServer({ webRoot })` serves
the live and recorded events to a page of your own.

## Real Among Us

The same brains can also play the real game. `node src/cli.js real` opens one Among Us copy per seat on
this PC, has the first one host a local (LAN) lobby and the others join, then plays in real time: every
player decides on its own when something happens to it, and meetings go through the real chat and vote.
Memories, prompts, the event log and the viewer are the same as in the simulator.

What you need:

- Among Us on Windows with BepInEx 6 (IL2CPP) and the **AUBridge** mod in its `BepInEx/plugins`.
  [mod/AUBridge](mod/README.md) is AUBridge ported to the itch.io build 2026.9.29, with build steps;
  for the Epic 2026.6.5 build use upstream's in
  [Fatoom333/among-us-claude](https://github.com/Fatoom333/among-us-claude).
- `bridge.gamePath` in `arena.config.json` (or `AMONG_US_EXE`) pointing at `Among Us.exe`. The `bridge`
  block in `arena.config.example.json` shows the lobby options.
- Seat names of 1-10 letters or digits (the game's limit), and 4 or more seats. The game allows
  2 impostors from 7 players and 3 from 9; a bigger `rules.impostors` is lowered to that.

`node src/cli.js real --mock --seats 4` is a free first test. Local lobbies only: never point this at
the official servers. Vent actions are not wired up yet. Status and test results:
[docs/REAL_GAME.md](docs/REAL_GAME.md).

## Credit

Among AI was created by **Duckxy** (YouTube [@LDuckxy](https://www.youtube.com/@LDuckxy), GitHub
[duckxy166](https://github.com/duckxy166)).

- The MIT license requires keeping the copyright notice in [LICENSE](LICENSE) in every copy or fork of
  the code.
- If you show Among AI in a video, stream or article, please credit "Among AI by Duckxy" and link this
  repository.

## Acknowledgements

The idea of real AI players with honest vision, a brain/body split and memory between matches was
inspired by [Fatoom333/among-us-claude](https://github.com/Fatoom333/among-us-claude) (MIT), which runs
Claude agents inside the real game through a BepInEx mod.

- **`mod/AUBridge` is that project's AUBridge mod, written by Tartaluga** (MIT), ported to the itch.io
  build by Duckxy. [mod/LICENSE](mod/LICENSE) keeps the original copyright notice and
  [mod/README.md](mod/README.md) lists every change.
- Everything else (`src/`, `web/`, `test/`) is written for this repository; `src/bridge/` talks to
  AUBridge over the mod's own protocol.

## License

[MIT](LICENSE) © 2026 Duckxy, except `mod/AUBridge`: MIT © 2026 Tartaluga, modifications © 2026 Duckxy
([mod/LICENSE](mod/LICENSE)). Among Us is a trademark of Innersloth LLC. This is a fan-made AI
experiment, not affiliated with or endorsed by Innersloth. No game code or assets are included (the mod
is built against your own copy of the game); the simulator's map is drawn from scratch.

---

## ภาษาไทย

**Among AI** คือสนามให้ AI หลายค่าย (Claude, GPT, Gemini, DeepSeek, Kimi, Grok …) มาเล่นเกมแนว Among Us
ด้วยกันในแมตช์เดียว แต่ละตัวมีความจำของตัวเอง คุยกัน หลอกกัน และหาเหตุผลจับคนโกหก
สร้างโดย **Duckxy** ([YouTube @LDuckxy](https://www.youtube.com/@LDuckxy)) เปิดโค้ดแบบ MIT

**จุดเด่น**

- **ความจำแยกกัน** — แต่ละตัวรู้แค่สิ่งที่ตัวละครตัวเองเห็น ระบบจดเหตุการณ์ลงความจำของผู้เล่นคนนั้นพร้อมเวลา
  เช่น `[01:10] เห็น Gemini ที่ Electrical` แล้วใช้เป็นหลักฐาน/ข้อแก้ตัวตอนประชุม ไม่มีใครอ่านความจำของคนอื่นได้ (มีเทสต์ตรวจ)
- **ความคิดในใจ vs คำพูดจริง** — ทุกคำตอบต้องมี `secret_thought` (แผนจริง คำโกหกที่กำลังเตรียม) แยกจากสิ่งที่ทำ/พูด/โหวต
  ผู้เล่นไม่เห็นความคิดกัน แต่ log และหน้า viewer เก็บไว้ทั้งสองอย่าง
- **หลายโมเดลในแมตช์เดียว** — เวลาในเกมหยุดระหว่างที่ AI คิด โมเดลที่ช้าจึงไม่เสียเปรียบ และเล่นซ้ำได้จาก seed
- **จำข้ามแมตช์** — จบเกมแต่ละตัวเขียนโน้ตถึงตัวเองเกมหน้า (ใครโกหก ใครไว้ใจได้)
- **หน้า viewer** ในเบราว์เซอร์ ดูแผนที่ ความคิดล่าสุดของทุกคน และความจำของผู้เล่นที่เลือก ทั้งสดและย้อนหลัง

**เริ่มใช้**

```bash
npm install
npm run mock
```

เปิด <http://localhost:7777> ดูแมตช์บอททดลอง (ไม่ใช้ API ไม่เสียเงิน) จากนั้นคัดลอก `arena.config.example.json`
เป็น `arena.config.json` และ `.env.example` เป็น `.env` ใส่ API key แล้วรัน `node src/cli.js check` ก่อน `npm start`

**เล่นในเกม Among Us จริง:** `node src/cli.js real` เปิดเกมหนึ่งหน้าต่างต่อผู้เล่นหนึ่งคน (ตัวแรกเปิด lobby แบบ local
ที่เหลือเข้าร่วม) แล้วให้ AI ชุดเดิมเล่นแบบเรียลไทม์ผ่าน mod AUBridge ต้องติดตั้ง BepInEx + AUBridge ในโฟลเดอร์เกมก่อน
และตั้ง `bridge.gamePath` ใน config ลองฟรีได้ด้วย `node src/cli.js real --mock --seats 4` รายละเอียดดูหัวข้อ
[Real Among Us](#real-among-us) และ [docs/REAL_GAME.md](docs/REAL_GAME.md) ใช้กับ lobby แบบ local เท่านั้น

**เครดิต:** ถ้านำไปใช้ในคลิป/สตรีม/บทความ กรุณาให้เครดิต "Among AI by Duckxy" พร้อมลิงก์ repo นี้;
ไลเซนส์ MIT กำหนดให้คงข้อความลิขสิทธิ์ใน [LICENSE](LICENSE) ไว้ทุกสำเนา

Among Us เป็นเครื่องหมายการค้าของ Innersloth LLC โปรเจกต์นี้เป็นการทดลองของแฟน ไม่เกี่ยวข้องกับ Innersloth
และไม่มีไฟล์หรือ asset ของเกมอยู่ใน repo
