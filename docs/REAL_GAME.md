# Plan: the same brains in the real Among Us

Status: **not started**. Everything in this repository runs on its own simulator. This page is the plan
for a second body: real game clients driven through a mod, with the brain layer unchanged.

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

- **Our copy is the itch.io build** (`AmongUsItch/Itch`, from `among-us-windows.zip`, files dated
  2026-09-29): Unity IL2CPP, **32-bit** (`Plugins/x86`, `UnityCrashHandler32.exe`). AUBridge targets the
  **Epic v17.4e 64-bit** build with BepInEx 6.0.0-be.788 IL2CPP x64 and Reactor 2.5.1. The game version
  of the itch build is not checked yet.
- **Real time does not stop.** Brains will need fast models and engine-side reflexes (report a body,
  flee a kill, kill when alone) like AUBridge has, with the model choosing plans and reflexes rather
  than every step.
- **6 to 8 game copies on one PC.** AUBridge needed Sandboxie for extra copies on one Epic account;
  whether the itch build runs several copies without it is unknown.

## Steps

1. Read the game version of the itch build and check whether BepInEx 6 IL2CPP (x86) and Reactor run on
   it. If not, decide between the Epic build (as upstream) or porting.
2. Build AUBridge from upstream against this build's interop assemblies; re-check every game class name
   against the decompiled `Assembly-CSharp` (never guess them).
3. Bring up 3 copies in one local lobby; script `move_to → do_task → kill → report → vote` through the
   bridge (upstream's own acceptance test).
4. Write `src/bridge/` here: one client per seat, events → `obs`, `view()`, `legalActions()`, `act()`,
   and a real-time runner loop with reflexes.
5. Run 8 copies with mock brains, then with real models.

Rules that do not change: local lobbies only (never official servers), no paid cosmetics unlocked, no
game files in this repository.
