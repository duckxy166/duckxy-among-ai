# Long-term memory

After each match (with `persistentMemory: true`) every player writes a short note to its future self,
stored here as `<seat id>.md`, newest first, last 8 matches. The next match puts that note in the
player's own system prompt and nowhere else, so each model remembers who lied to it.

Mock matches write to `memory/mock/` instead. These files are git-ignored. Delete a file to give a
player a fresh start.
