# Contributing

Thanks for helping out! Bug reports, match stories, ideas and pull requests are all welcome. Issues and
pull requests can be in English or Thai.

## Reporting a bug

Open an [issue](https://github.com/duckxy166/duckxy-among-ai/issues) with:

- the command you ran and what happened instead of what you expected,
- your Node.js version (`node -v`), your OS, and the release or commit you are on,
- the seats involved (`provider` and `model`; **never paste API keys** or your `.env`),
- the relevant lines from `matches/<id>/events.jsonl` (and `prompts.jsonl` if a model answered strangely).
  A simulator match replays from its seed, so the seed alone often lets us see the same thing.

For the real game, also say which Among Us build you have and attach the BepInEx log
(`BepInEx/LogOutput.log`) of the copy that misbehaved.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make the change. Keep it focused, and match the style of the code around it.
3. Run `npm test` (and a mock match if you touched the game or the viewer, see below).
4. Update the docs the change touches ([Keep the docs in step](#keep-the-docs-in-step)).
5. Describe what you changed and how you tested it. For the real game, say what you ran it against.

## Checks

```bash
npm install
npm test                            # node --test: engine, memory, full mock matches, bridge vs a fake AUBridge
node src/cli.js run --mock --serve  # a full match without API keys, viewer at http://localhost:7777
node src/cli.js replay              # the viewer for the latest recorded match
```

`npm test` runs on every pull request (GitHub Actions, Node 20 and 22). Tests use mock brains only and
never call an API, so they need no keys and cost nothing. A new rule in the engine or a new kind of turn
gets a test.

`mod/AUBridge` is C# (BepInEx 6 IL2CPP plugin, net6.0) and is not covered by `npm test` or CI: it builds
against assemblies from your own copy of the game (`mod/refs/`). After changing the mod, build it as
[mod/README.md](mod/README.md) describes, put the DLL in the game and play a match with
`node src/cli.js real --mock --seats 4`.

## Don't break

- **Memory isolation.** A brain gets `game.view(its id)`, its own `EpisodicMemory` and the public meeting
  record, nothing else. Never pass another player's memory, thoughts or the engine state into a prompt.
  The isolation test in `test/match.test.js` must keep passing. This is the whole game: a player that
  can peek is not playing.
- **Event names and fields** in `events.jsonl` (table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#event-log))
  and the exports in `src/index.js`: other tools and old recorded matches read them. Add fields, types
  and exports; don't rename or remove them.
- **Determinism.** The engine uses only the seeded RNG from `src/rng.js` (never `Math.random`) and does
  not read the clock, so a seed replays a match.
- **The bridge is honest too.** In `src/bridge/` a seat's view, legal actions and memory come only from
  its own game copy. `test/fake-bridge.js` stands in for the mod in tests: when you change what the bridge
  expects from AUBridge, change the fake the same way.
- **Credit.** Keep the copyright line in `LICENSE`, the Credit section of both READMEs and the credit in
  the viewer footer. `mod/AUBridge` is upstream code (MIT, © Tartaluga): keep `mod/LICENSE`, the credit
  in `mod/README.md` and the READMEs' acknowledgements, and add every change you make to the mod to the
  "Changes from upstream" table in `mod/README.md`.
- **No game files, no secrets.** No game files, assets or code from Among Us; no API keys, `.env`,
  `arena.config.json`, `matches/` or `memory/*.md` in git. Never commit `mod/refs/`, `bin/` or `obj/`.
- **Local lobbies only.** The real-game runner must never connect to the official servers.

## Style

- Plain JavaScript ES modules on Node 20.12+, no build step, no framework in `web/`.
- Two runtime dependencies (`@anthropic-ai/sdk`, `openai`), imported lazily so mock runs work without
  them. Open an issue before adding a third.
- Comments explain why, not what.
- Instructions to the models stay in English. Text players read in their memory comes from `src/i18n.js`
  (Thai and English); add both when you add a line.
- A new provider goes in `src/providers/` and in the providers table of
  [docs/configuration.md](docs/configuration.md#seats-and-providers).

## Keep the docs in step

A pull request that changes behaviour updates its page in the same pull request:

| Change | Update |
|---|---|
| A CLI command or flag, a seat field, a provider, a match setting | [docs/configuration.md](docs/configuration.md) |
| An event or an event field | The event table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#event-log) |
| How the engine, brains or bridge work | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| The real game or the AUBridge mod | [docs/REAL_GAME.md](docs/REAL_GAME.md), [mod/README.md](mod/README.md) |
| A new term | [CONTEXT.md](CONTEXT.md) |

The READMEs (`README.md` in Thai, `README.en.md` in English) stay a short landing page without reference
tables. They are twins with the same sections; write the Thai as natural Thai, not word for word.

## Releases

Versions follow [semver](https://semver.org) in `package.json`. A release is a tag `vX.Y.Z` on `main` with
notes on the GitHub [Releases](https://github.com/duckxy166/duckxy-among-ai/releases) page: what players
of the game would notice first, then changes for people building on the event log or the exports.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
