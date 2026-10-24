// Library entry point, for projects that run Among AI matches from their own code.

export { runMatch } from './match/runner.js';
export { loadConfig } from './config.js';
export { createProvider, missingKeys, PRESETS } from './providers/index.js';
export { createHub, startServer, listMatches, readEvents } from './server/server.js';
export { Game, DEFAULT_RULES } from './engine/game.js';
export { ROOMS, EDGES, VENT_GROUPS, TASKS, COLORS, BOARD } from './engine/map.js';
export { Agent, FatalSeatError } from './agents/agent.js';
export { EpisodicMemory } from './agents/memory.js';
export { SCHEMAS } from './agents/prompts.js';
export { clock } from './i18n.js';
