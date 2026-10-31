// GPT, Gemini, DeepSeek, Kimi, Grok, OpenRouter, Ollama: all through the OpenAI SDK pointed at the
// provider's Chat Completions endpoint. `jsonMode` per seat: json_schema (strict, OpenAI),
// json_object (most others) or none (prompt-only, for servers that reject response_format).

export async function createOpenAICompat(seat, preset) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: (preset.keyEnv && process.env[preset.keyEnv]) || 'not-needed',
    baseURL: preset.baseURL,
    maxRetries: 3,
    timeout: 180_000,
  });

  return {
    async complete({ system, user, schema, schemaName }) {
      // The schema goes at the end of the user turn so the system prompt stays byte-identical
      // across calls and providers with automatic prefix caching can reuse it.
      const content = `${user}\n\nAnswer with one JSON object that matches this JSON Schema and nothing else:\n${JSON.stringify(schema)}`;
      const body = {
        model: seat.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
        ...(seat.extra ?? {}),
      };
      if (preset.jsonMode === 'json_schema') {
        // Strict json_schema enforces `enum`, so on a roam turn the per-turn action enum (built in
        // agent.js) is honored and the model cannot return an off-list action. json_object and none
        // do not enforce it, but still receive the schema (with the enum) in the prompt text above;
        // agent.js's matchAction is the fallback for those. We forward the schema unchanged.
        body.response_format = { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } };
      } else if (preset.jsonMode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
      const res = await client.chat.completions.create(body);
      const msg = res.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? '',
        refused: !!msg.refusal,
        model: res.model ?? seat.model,
        usage: {
          input: res.usage?.prompt_tokens ?? 0,
          output: res.usage?.completion_tokens ?? 0,
          cacheRead: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    },
  };
}
