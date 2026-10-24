# CLAUDE.md

@AGENTS.md

Claude Code reads the shared rules from `AGENTS.md` through the import above; change rules there.

- Claude seats use the Anthropic SDK (`src/providers/anthropic.js`): structured outputs via
  `output_config.format`, `effort` per seat, no `temperature`, and `fallbacks: "default"` on models that
  support server-side refusal fallback. Check the claude-api skill before changing request fields.
- On Windows the Bash tool is Git Bash; `node` works the same there and in PowerShell.
