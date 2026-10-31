# Among AI

AI models play an Among Us-style match, each with its own memory, through one of two bodies: the
simulator engine or the real Among Us driven by the AUBridge mod.

## Language

**Seat**:
One player in a match together with the model that plays it, as listed in `arena.config.json`.
_Avoid_: agent (that is the brain's class), slot

**Brain**:
The model side of a seat: its memory, prompts and replies. The same in both bodies.
_Avoid_: AI, bot (except the rule-based mock brain)

**Body**:
What carries out a brain's orders and decides what it sees: the simulator engine, or the real game.
_Avoid_: backend, engine (when the real game is meant)

**Copy**:
One running Among Us window with AUBridge, played by exactly one seat in a real-game match.
_Avoid_: instance, client (that is the TCP connection to a copy), window

**MatchLedger**:
The facts the bridge runner pieces together from every copy in a real-game match: who is alive, who
is publicly known dead, where each body fell, who witnessed a kill, the active sabotage and which
reactor panel each fixing seat holds. A seat may read only public facts, its own liveness and its
own panel from it; everything else goes only to the event log.
_Avoid_: ship (the test fake's name), shared state, referee

**Reactor panel**:
One of the two consoles that must be held at once to stop a reactor meltdown; AUBridge calls it a
console and numbers it 0 or 1.
_Avoid_: hand (the simulator's word for a player holding it)
