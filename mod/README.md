# AUBridge, ported to the itch.io build

AUBridge is a BepInEx 6 (IL2CPP) plugin that runs inside every Among Us copy and lets a program play it:
newline JSON over TCP on `127.0.0.1:47000+id`, with high-level actions (walk to a room, do a task, kill,
report, chat, vote) and events that only report what that copy's screen shows. `src/bridge/` in this
repository plays through it (`node src/cli.js real`).

## Credit

**AUBridge is written by Tartaluga** and comes from
[Fatoom333/among-us-claude](https://github.com/Fatoom333/among-us-claude) (`mod/AUBridge`, upstream
commit `f54703c`), under the MIT license. [LICENSE](LICENSE) here keeps their copyright notice; the
changes below are by Duckxy under the same license. Upstream's protocol specs (`mod/SPEC-bridge.md`,
`mod/SPEC-body.md`) and notes are in the upstream repository.

## Changes from upstream

| Where | Change | Why |
|---|---|---|
| `Game.cs`, `Actions.cs` | `MeetingHud.VoteStates` → `MeetingStates`, `PlayerVoteArea.TargetPlayerId` → `PlayerId` (`InnerNet.PlayerId`), `NormalGameOptionsV10` → `V12` | renamed in game version 2026.9.29 |
| `Game.cs` `Start()` | after `BeginGame()`, call `ReallyBegin(false)` when `GameSizePopup` is up | with 4 players the game asks "5 or more players is recommended" and waits for a click |
| `GamePatches.cs` `PCastVote` | the postfix takes `InnerNet.PlayerId` instead of `byte` | with `byte` Harmony emits invalid IL, `CastVote` breaks and no vote counts |
| `Events.cs`, `Nav.cs`, `Body.cs` | match log and nav cache go to `<game>/BepInEx/AUBridge/games/` | upstream wrote to `D:\AmongUs-tools\games`, a folder on its author's PC |

Details and test results: [docs/REAL_GAME.md](../docs/REAL_GAME.md).

## Tested with

Among Us **2026.9.29 itch.io** (32-bit, Unity 2022.3.44f1), BepInEx **6.0.0-be.788** IL2CPP win-x86 and
Reactor **2.5.1**, up to 4 copies on one PC. Upstream targets the Epic 2026.6.5 (v17.4e) 64-bit build;
other builds may need other renames.

## Build and install

1. Put BepInEx 6.0.0-be.788 IL2CPP ([builds.bepinex.dev](https://builds.bepinex.dev), x86 for the itch
   build) in the game folder and start the game once, so BepInEx writes `BepInEx/interop`.
2. Make `mod/refs/` from your own game folder: `BepInEx/core/*.dll` → `mod/refs/core/`,
   `BepInEx/interop/*.dll` → `mod/refs/interop/`, and Reactor 2.5.1's `Reactor.dll` → `mod/refs/`. These
   files come from the game and BepInEx, so they stay out of git (`.gitignore`).
3. In `mod/AUBridge`: `dotnet build -c Release` (.NET SDK 6 or newer).
4. Copy `bin/Release/net6.0/AUBridge.dll` and `Reactor.dll` into the game's `BepInEx/plugins/`.

## Running

`node src/cli.js real` starts the copies itself. By hand, each copy needs:

```text
"Among Us.exe" --aub-id=1 --aub-mode=host --aub-name=Red --aub-color=0 --aub-token=<16+ characters> --aub-mute=1
```

`--aub-mode=join` for the others, with their own id, name and colour. The bridge opens only with a token of
16 or more characters, every request must carry it, and it listens on `127.0.0.1` only. Main commands:
`state`, `act` (`move_to`, `do_task`, `follow`, `kill`, `report`, `call_meeting`, `fix`, `sabotage`,
`vent`, `chat`, `vote`, `stay`), `wait_event` (long poll), and on the host `configure` and `start`.

Use it in local (LAN) lobbies only, never on the official servers or with other people's games.
