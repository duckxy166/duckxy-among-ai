// Stands in for the Claude Code, Codex and Antigravity CLIs in tests:
//   node test/fake-cli.js <claude|codex|agy> ...the real CLI's arguments
// It speaks each CLI's stream format and answers with one JSON object for the schema in the prompt.
// The model id picks the behaviour: "ok", "auth" (not signed in), "refuse", "crash", "hang", "limit".
// With FAKE_CLI_LOG set, it appends what it saw (arguments, env, prompt) as one JSON line.

import fs from 'node:fs';

const [dialect, ...args] = process.argv.slice(2);
// `node --test` runs every file in test/, this one included: without a dialect there is nothing to fake.
if (!dialect) process.exit(0);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const model = flag('--model') ?? flag('-m');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const startedAt = Date.now();

if (dialect === 'claude') out({ type: 'system', subtype: 'init', model });
if (dialect === 'agy') out({ event: 'init', init: { model } });

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (dialect !== 'codex' && input.includes('\n')) reply(); });
process.stdin.on('end', () => reply());

let replied = false;
function reply() {
  if (replied) return;
  replied = true;
  const prompt = dialect === 'codex' ? input : JSON.parse(input.split('\n')[0]).message.content;
  const systemFile = flag('--system-prompt-file');
  const system = systemFile ? fs.readFileSync(systemFile, 'utf8') : prompt.split('\n\n---\n\n')[0];
  if (process.env.FAKE_CLI_LOG) {
    fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({
      pid: process.pid, dialect, args, cwd: process.cwd(), waitedMs: Date.now() - startedAt,
      hasAnthropicKey: 'ANTHROPIC_API_KEY' in process.env, hasOpenAIKey: 'OPENAI_API_KEY' in process.env, system, prompt,
    })}\n`);
  }
  if (model === 'hang') return setInterval(() => {}, 1000);
  if (model === 'crash') { process.stderr.write('fake crash: something broke\n'); process.exit(3); }
  if (model === 'auth') {
    if (dialect === 'claude') out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    if (dialect === 'codex') out({ type: 'turn.failed', error: { message: '401 Unauthorized: please log in' } });
    if (dialect === 'agy') out({ event: 'result', result: { status: 'ERROR', error: 'not signed in' } });
    return setTimeout(() => process.exit(1), 50);
  }
  if (model === 'refuse' && dialect === 'claude') {
    out({ type: 'assistant', error: 'invalid_request', message: { model, content: [{ type: 'text', text: "API Error: Sonnet 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)." }] } });
    return setTimeout(() => process.exit(1), 50);
  }
  const schema = JSON.parse(prompt.slice(prompt.lastIndexOf('nothing else:\n') + 'nothing else:\n'.length));
  const answer = Object.fromEntries(Object.keys(schema.properties).map((k) => [k, `fake ${k}`]));
  answer.secret_thought = `system: ${system.split('\n')[0]}`;
  const text = JSON.stringify(answer);
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 };
  if (dialect === 'claude') {
    if (model === 'limit') out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.91 } } } });
    out({ type: 'assistant', message: { model: `fake-${model}`, content: [{ type: 'text', text }], stop_reason: null, usage } });
    // The real CLI makes a summary request after the answer: a caller that waits for exit is slow.
    setTimeout(() => { out({ type: 'result', subtype: 'success', is_error: false, result: text }); process.exit(0); }, 3000);
  } else if (dialect === 'codex') {
    out({ type: 'thread.started' });
    out({ type: 'item.completed', item: { type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } });
  } else {
    out({ event: 'result', result: { status: 'SUCCESS', response: `${text}\n`, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } } });
  }
}
