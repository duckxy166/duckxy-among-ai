# Glossary

The words this project uses, in code, docs, issues and pull requests. Use them as written here.

| Term | Meaning |
|---|---|
| **Seat** | One player in a match: one model from one provider, set up in `arena.config.json` (`seats[]`). A seat has an `id` (also its memory file name) and a `name` (what the other players call it). |
| **Provider** | The code that sends a seat's request to a model: an API (`anthropic`, `openai`, `gemini`, ...), a signed-in CLI (`claude-code`, `codex`, `antigravity`) or the `mock` bot. In `src/providers/`. |
| **Subscription seat** | A seat on `claude-code`, `codex` or `antigravity`: it runs the user's own signed-in CLI instead of calling an API with a key. |
| **Brain** | The `Agent` that decides for one seat (`src/agents/agent.js`): its memory, its prompts and its provider. |
| **Body** | Whatever carries out a brain's orders: the simulator engine, or one game copy in the real game. |
| **Engine** | The simulator (`src/engine/`): the ship, movement, vision, tasks, kills, sabotage, meetings, votes and the win check, in game seconds. |
| **View** | What one seat is allowed to know right now: `game.view(id)` in the simulator, the seat's own copy's state in the real game. Never another seat's. |
| **Legal actions** | The orders a seat may give at this moment, each with an id such as `move:Admin` or `kill:Kimi`. |
| **Order** | A high-level action the body carries out over the next seconds (`move`, `task`, `follow`, `kill`, `vent`, `sabotage`, `fix`, `report`, `emergency`, `wait`). |
| **Decision point** | A moment a brain is asked: the match starts, its order is done, a meeting ends, or something interrupts it (a body, a kill, a sabotage, someone talking to it, a kill chance). Brains are not asked every second. |
| **Observation (`obs`)** | One line the engine writes into one player's memory about something it saw: entered, left toward, found a body, saw a kill. |
| **Memory (episodic)** | A seat's private, timestamped log of its own observations, notes, past thoughts and the public meeting record (`src/agents/memory.js`). |
| **Long-term memory** | The note each seat writes to its future self after a match (`lesson`), kept in `memory/<seat id>.md` and read in the next match. |
| **Secret thought** | The `secret_thought` field of every reply: the real plan. Players never see each other's; the log and the viewer keep it. |
| **Public part** | The rest of a reply: an action and `say` while roaming, `chat_message` and `suspect` in a meeting, `vote` when voting. |
| **Talk / earshot** | A line said out loud while roaming reaches only the living players who can see the speaker at that moment. |
| **Freeze** | Game time stands still while any brain is thinking, so a slow model loses no time. |
| **Match** | One game, with an id; its files are in `matches/<id>/`. |
| **Event log** | `matches/<id>/events.jsonl`: every event of a match, one JSON object per line. The viewer, replays and other tools read only this. |
| **Viewer** | The browser page in `web/` that shows a match live or replayed. |
| **Mock** | The rule-based bot provider (`--mock`): free, no keys, used by the tests. |
| **Real game** | Playing the real Among Us instead of the simulator (`node src/cli.js real`). |
| **Copy** | One running Among Us window in the real game; one copy per seat. |
| **AUBridge** | The BepInEx mod inside every copy that lets a program play it (`mod/AUBridge`, upstream by Tartaluga). |
| **Bridge** | This repository's side of AUBridge (`src/bridge/`): it turns a copy's state and events into a seat's view, memory and legal actions, and orders into commands. |
