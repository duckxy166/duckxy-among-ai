// Every seat talks to one provider. Claude goes through the Anthropic SDK; the rest speak the
// OpenAI-compatible Chat Completions API, so one client covers GPT, Gemini, DeepSeek, Kimi,
// Grok, OpenRouter and local Ollama. `claude-code`, `codex` and `antigravity` play on the user's
// subscription through that signed-in CLI instead of an API key (cli.js). `mock` is a rule-based bot
// for free dry runs and tests.

export const PRESETS = {
  anthropic: { kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { kind: 'openai', keyEnv: 'OPENAI_API_KEY', jsonMode: 'json_schema' },
  gemini: { kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyEnv: 'GEMINI_API_KEY', jsonMode: 'json_object' },
  deepseek: { kind: 'openai', baseURL: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', jsonMode: 'json_object' },
  kimi: { kind: 'openai', baseURL: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY', jsonMode: 'json_object' },
  xai: { kind: 'openai', baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', jsonMode: 'json_object' },
  openrouter: { kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', jsonMode: 'json_object' },
  ollama: { kind: 'openai', baseURL: 'http://localhost:11434/v1', keyEnv: null, jsonMode: 'json_object' },
  custom: { kind: 'openai', keyEnv: null, jsonMode: 'json_object' },
  'claude-code': { kind: 'cli', cli: 'claude', keyEnv: null },
  codex: { kind: 'cli', cli: 'codex', keyEnv: null },
  antigravity: { kind: 'cli', cli: 'agy', keyEnv: null },
  mock: { kind: 'mock', keyEnv: null },
};

export function resolvePreset(seat) {
  const base = PRESETS[seat.provider];
  if (!base) throw new Error(`Seat ${seat.name}: unknown provider "${seat.provider}" (use one of ${Object.keys(PRESETS).join(', ')})`);
  return {
    ...base,
    baseURL: seat.baseURL ?? base.baseURL,
    keyEnv: seat.apiKeyEnv ?? base.keyEnv,
    jsonMode: seat.jsonMode ?? base.jsonMode,
  };
}

// Seats whose API key is missing. The Anthropic SDK can also sign in through `ant auth login`,
// so a missing ANTHROPIC_API_KEY is only a warning.
export function missingKeys(seats) {
  const errors = [];
  const warnings = [];
  for (const seat of seats) {
    const p = resolvePreset(seat);
    if (!p.keyEnv || process.env[p.keyEnv]) continue;
    (p.kind === 'anthropic' ? warnings : errors).push(`${seat.name}: ${p.keyEnv} is not set`);
  }
  return { errors, warnings };
}

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const limits = new Map();

export async function createProvider(seat, { seed = 0 } = {}) {
  const preset = resolvePreset(seat);
  let provider;
  if (preset.kind === 'anthropic') provider = (await import('./anthropic.js')).createAnthropic(seat, preset);
  else if (preset.kind === 'openai') provider = (await import('./openai-compat.js')).createOpenAICompat(seat, preset);
  else if (preset.kind === 'cli') provider = (await import('./cli.js')).createCli(seat, preset);
  else provider = (await import('./mock.js')).createMock(seat, seed);
  provider = await provider;

  // At most `concurrency` requests in flight per provider (shared by its seats).
  const key = `${seat.provider}:${preset.baseURL ?? ''}`;
  if (!limits.has(key)) limits.set(key, limiter(seat.concurrency ?? 4));
  const run = limits.get(key);
  return { ...provider, complete: (req) => run(() => provider.complete(req)) };
}
