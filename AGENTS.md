# Agent instructions

For coding agents working on Among AI (Claude Code, Codex, Antigravity, Jules and the like).
How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This repository is the game and its AI players only. Video production around it (OBS overlays,
recording, editing summaries, channel personas) lives in a separate private project that installs this
package and reads its event log. Nothing here may depend on that: no OBS, recording or YouTube concerns
in this repository. When production needs something, add an event field, an export or an option here.

## Checks

```bash
npm test                            # node --test: engine, memory, full mock matches
node src/cli.js run --mock          # a full match without API keys
node src/cli.js replay              # then open http://localhost:7777 to look at the viewer
```

`npm test` must pass before you hand work back. Tests use mock brains only and never call an API.

## Don't break

- **Memory isolation.** A brain gets `game.view(its id)`, its own `EpisodicMemory` and the public meeting
  record, nothing else. Never pass another player's memory, thoughts or the engine state into a prompt.
  The isolation test in `test/match.test.js` must keep passing.
- **Event names and fields** in `events.jsonl` (table in `docs/ARCHITECTURE.md`) and the exports in
  `src/index.js`: other tools and old recorded matches read them. Add fields, types and exports; don't
  rename or remove them.
- **Determinism.** The engine uses only the seeded RNG from `src/rng.js` (never `Math.random`) and does
  not read the clock, so a seed replays a match.
- **Observation kinds** match the event names of the AUBridge mod on purpose (docs/REAL_GAME.md).
- **Credit.** Keep the copyright line in `LICENSE`, the Credit section of the README and the credit in
  the viewer footer.
- No game files, assets or code from Among Us; no API keys, `.env`, `arena.config.json`, `matches/` or
  `memory/*.md` in git.

## Style

Plain JavaScript ES modules on Node 20.12+, no build step, no framework in `web/`. Two runtime
dependencies (`@anthropic-ai/sdk`, `openai`), imported lazily so mock runs work without them; ask before
adding a third. Comments explain why, not what. Instructions to the models stay in English; text players
read in their memory comes from `src/i18n.js` (Thai and English).
