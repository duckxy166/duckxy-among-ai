// Claude seats, through the official Anthropic SDK. Structured outputs guarantee the reply is
// JSON with exactly our fields; `effort` sets how hard the model thinks (low is plenty for moves).

// Models that accept the server-side refusal fallback: if a safety classifier declines a turn,
// the API re-runs it on a fallback Claude model inside the same call instead of returning nothing.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export async function createAnthropic(seat, preset) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const apiKey = preset.keyEnv ? process.env[preset.keyEnv] : undefined;
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 3, timeout: 180_000 });
  const fallback = seat.refusalFallback !== false && FALLBACK_MODELS.has(seat.model);

  return {
    async complete({ system, user, schema, effort }) {
      const params = {
        model: seat.model,
        max_tokens: seat.maxTokens ?? 16000,
        // The system prompt is fixed for the whole match, so cache it.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema } },
      };
      const res = fallback
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(params);
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return {
        text,
        refused: res.stop_reason === 'refusal',
        model: res.model,
        usage: {
          input: res.usage?.input_tokens ?? 0,
          output: res.usage?.output_tokens ?? 0,
          cacheRead: res.usage?.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
