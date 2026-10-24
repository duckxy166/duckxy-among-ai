# Plan: the same brains in the real Among Us

Status: **feasibility checked 2026-10-25 (step 1 done), no bridge code yet.** Everything in this
repository runs on its own simulator. This page is the plan for a second body: real game clients driven
through a mod, with the brain layer unchanged.

## What already lines up

[Fatoom333/among-us-claude](https://github.com/Fatoom333/among-us-claude) (MIT) shows it can be done:
a BepInEx 6 IL2CPP mod (AUBridge, with Reactor) runs inside every game copy, joins a local (LAN) lobby
and answers newline-JSON commands on `127.0.0.1:47000+N`. Its body spec (`mod/SPEC-body.md` there)
gives high-level actions and honest, on-screen-only events. Our simulator was built to match:

| Among AI action | AUBridge `act` |
|---|---|
| `move:<Room>` | `move_to {room}` |
| `follow:<Name>` | `follow {target}` |
| `wait:N` | `stay` |
| `task:<id>` / `fake:<id>` | `do_task {id}` / `move_to` + `stay` |
| `report` / `emergency` | `report` / `call_meeting` |
| `kill:<Name>` / `vent:<Room>` / `sabotage:<kind>` / `fix` | `kill` / `vent` / `sabotage` / `fix` |
| meeting `chat_message` / `vote` | `chat {text}` (100 characters max) / `vote {target}` |

| AUBridge event | Among AI memory kind |
|---|---|
| `saw_player` / `lost_player` | `saw_player` / `lost_player` |
| `saw_body` / `saw_kill` / `saw_vent` | same names |
| `arrived`, `task_done`, `sabotage`, `sabotage_fixed` | same names |
| `meeting_started`, `chat`, `meeting_ended` | `meeting`, transcript, `meeting_result` |

So a bridge adapter only has to turn those events into `obs` lines and expose `view()` and
`legalActions()`; `EpisodicMemory`, prompts, providers and the viewer stay as they are.

## What is different here

- **Our copy is the itch.io build**, game version **2026.9.29**: Unity 2022.3.44f1 IL2CPP (metadata
  v31), **32-bit** (x86 PE headers on the exe, `GameAssembly.dll` and `UnityPlayer.dll`). AUBridge
  targets the **Epic 2026.6.5 (v17.4e) 64-bit** build with BepInEx 6.0.0-be.788 IL2CPP x64 and
  Reactor 2.5.1. Same Unity version, different bitness and game version.
- **Real time does not stop.** Brains will need fast models and engine-side reflexes (report a body,
  flee a kill, kill when alone) like AUBridge has, with the model choosing plans and reflexes rather
  than every step.
- **6 to 8 game copies on one PC.** AUBridge needed Sandboxie for extra copies on one Epic account.
  The itch build has no launcher login, and two modded copies ran side by side from one folder (below).

## Feasibility check (2026-10-25, itch build 2026.9.29)

| Check | Result |
|---|---|
| Vanilla game starts and reaches the main menu | yes |
| BepInEx `6.0.0-be.788` IL2CPP **win-x86** (builds.bepinex.dev) loads | yes: process 32-bit, Unity base libraries downloaded, Cpp2IL + interop generated in ~30 s on first start, `Chainloader startup complete`, game still reaches the main menu. One warning: `Class::Init signatures have been exhausted, using a substitute` (class injection still works, next row) |
| A test plugin: Harmony postfix on `MainMenuManager.Start`, injected `MonoBehaviour` with `Update()` | yes: the patch runs, the injected component ticks every frame on the main thread, `AmongUsClient.Instance.NetworkMode` reads `LocalGame` |
| Reactor 2.5.1 (officially "Among Us 16.0.5 up to 17.4") | loads without errors, reports `Among Us 2026.9.29 itch.io`, finds all its coroutine hooks |
| Two modded copies at once from the same folder | yes: both reach the main menu, BepInEx writes `LogOutput.log` and `LogOutput.1.log`. **Not yet tested:** one copy hosting a local lobby and the other joining it |
| Upstream AUBridge compiled against this build's interop (+ Reactor 2.5.1) | 19 errors, all in three places: `MeetingHud.VoteStates` and `PlayerVoteArea.TargetPlayerId` (meeting voting; `PlayerVoteArea` now exposes `TargetPlayer`) and `NormalGameOptionsV10` → `NormalGameOptionsV12` (lobby options). Movement, tasks, kills, vents, sabotage, chat, events, reflexes and the TCP bridge compile unchanged |

Conclusion: modding the itch build works. Porting AUBridge is a small, local change (voting and lobby
options); the open risks are running a local lobby with 6 to 8 copies on one PC and real-time play.

## Steps

1. ~~Read the game version of the itch build and check whether BepInEx 6 IL2CPP (x86) and Reactor run
   on it.~~ Done 2026-10-25, see the table above.
2. Build AUBridge from upstream against this build's interop assemblies: fix the 19 errors (voting,
   lobby options), re-checking every replacement against the decompiled `Assembly-CSharp` (never guess
   names), then test one copy hosting and another joining a local lobby.
3. Bring up 3 copies in one local lobby; script `move_to → do_task → kill → report → vote` through the
   bridge (upstream's own acceptance test).
4. Write `src/bridge/` here: one client per seat, events → `obs`, `view()`, `legalActions()`, `act()`,
   and a real-time runner loop with reflexes.
5. Run 8 copies with mock brains, then with real models.

Rules that do not change: local lobbies only (never official servers), no paid cosmetics unlocked, no
game files in this repository.
