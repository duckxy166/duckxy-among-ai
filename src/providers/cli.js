// Seats that play on a subscription instead of an API key: each call runs the user's signed-in
// agent CLI headless (Claude Code, Codex, Antigravity), with no tools and nothing from this project
// loaded. Starting a CLI takes 1-10 seconds, so every seat keeps one started process waiting on
// stdin and the next call only pays for the model. We take the answer as soon as it streams out and
// kill the process, which also skips the extra summary request Claude Code makes after each turn.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// An empty folder, so no CLAUDE.md, AGENTS.md or git repository reaches the players.
const WORKDIR = path.join(os.tmpdir(), 'among-ai-cli');

// The agent stops a seat on 401/403/404, so sign-in and model errors get those statuses.
const statusOf = (message) => (/not supported|model_not_found|unknown model|invalid model/i.test(message) ? 404
  : /401|unauthori[sz]ed|log ?in|sign(ed)? ?in|authenticat/i.test(message) ? 401 : undefined);

const REFUSAL = /safeguards flagged|usage policy|\/legal\/aup/i;

const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const DIALECTS = {
  claude: {
    command: 'claude',
    // An API key in the environment would be billed instead of the subscription.
    stripEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    ownSystemPrompt: true,
    args: ({ model, effort, systemFile }) => [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', model, '--system-prompt-file', systemFile, '--tools', '',
      '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
      ...(effort ? ['--effort', effort] : []),
    ],
    input: userLine,
    read(m, seat) {
      if (m.type === 'rate_limit_event') return { limit: m.rate_limit_info };
      if (m.type === 'assistant') {
        const text = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        // A safety classifier that declines a turn is a refusal, like the API's stop_reason.
        if (m.error && REFUSAL.test(text)) return { text: '', refused: true, model: m.message?.model ?? seat.model, usage: {} };
        if (m.error) return { error: text || m.error, status: m.error === 'authentication_failed' ? 401 : statusOf(text) };
        if (!text) return null;
        const u = m.message.usage ?? {};
        return {
          text, refused: m.message.stop_reason === 'refusal', model: m.message.model ?? seat.model,
          usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 },
        };
      }
      if (m.type === 'result' && m.is_error && REFUSAL.test(m.result ?? '')) return { text: '', refused: true, model: seat.model, usage: {} };
      if (m.type === 'result' && m.is_error) return { error: m.result || m.subtype, status: statusOf(m.result ?? '') };
      return null;
    },
  },
  codex: {
    command: 'codex',
    stripEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    args: ({ model, effort }) => [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-m', model,
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-',
    ],
    input: (text) => text,
    read(m, seat, state) {
      if (m.type === 'item.completed' && m.item?.type === 'agent_message') state.text = m.item.text;
      if (m.type === 'turn.completed' && state.text !== undefined) {
        const u = m.usage ?? {};
        return { text: state.text, model: seat.model, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cached_input_tokens ?? 0 } };
      }
      if (m.type === 'turn.failed' || m.type === 'error') {
        const error = m.error?.message ?? m.message ?? 'codex failed';
        return { error, status: statusOf(error) };
      }
      return null;
    },
  },
  agy: {
    command: 'agy',
    stripEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    // agy's model ids carry the effort ("gemini-3.8-flash-low"), so effort is not passed.
    args: ({ model }) => ['--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'],
    input: (text) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: text } })}\n`,
    read(m, seat, state) {
      if (m.event === 'init') state.model = m.init?.model;
      if (m.event !== 'result') return null;
      const r = m.result ?? {};
      if (r.status !== 'SUCCESS') return { error: r.error || r.status || 'agy failed', status: statusOf(r.error ?? '') };
      const u = r.usage ?? {};
      return { text: r.response ?? '', model: state.model ?? seat.model, usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_tokens ?? 0 } };
    },
  },
};

const live = new Set();
let cleanup = false;
function track(proc) {
  live.add(proc);
  proc.on('exit', () => live.delete(proc));
  if (!cleanup) {
    cleanup = true;
    process.on('exit', () => { for (const p of live) p.kill(); });
  }
}

function systemFile(system) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  const file = path.join(WORKDIR, `system-${createHash('sha256').update(system).digest('hex').slice(0, 16)}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, system);
  return file;
}

export function createCli(seat, preset) {
  const dialect = DIALECTS[preset.cli];
  const [command, ...prefix] = [].concat(seat.command ?? dialect.command);
  const env = { ...process.env };
  for (const k of dialect.stripEnv) delete env[k];
  const timeoutMs = seat.timeoutMs ?? 180_000;
  let spare = null;
  let warned = false;

  function start(key, system, effort) {
    const args = dialect.args({ model: seat.model, effort, systemFile: dialect.ownSystemPrompt ? systemFile(system) : null });
    fs.mkdirSync(WORKDIR, { recursive: true });
    const proc = spawn(command, [...prefix, ...args], { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    track(proc);
    const lines = [];
    let stderr = '';
    let failed = null;
    let closed = false;
    let wake = () => {};
    proc.on('error', (e) => { failed = e; wake(); });
    // 'close' comes after the last stdout line, so an answer printed just before exiting is not lost.
    proc.on('close', () => { closed = true; wake(); });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (l) => { lines.push(l); wake(); });
    // A spare must not keep Node alive at the end of a match.
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s.unref?.();
    proc.unref();
    return { key, proc, lines, stderr: () => stderr, failed: () => failed, closed: () => closed, onChange: (fn) => { wake = fn; } };
  }

  function answer(run, input) {
    const { proc } = run;
    proc.ref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s.ref?.();
    proc.stdin.end(input);
    const state = {};
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ error: `no answer after ${timeoutMs / 1000}s` }), timeoutMs);
      const finish = (out) => {
        clearTimeout(timer);
        run.onChange(() => {});
        proc.kill();
        if (out.error === undefined) return resolve(out);
        const err = new Error(`${dialect.command}: ${String(out.error).trim().slice(0, 300)}`);
        if (out.status) err.status = out.status;
        reject(err);
      };
      const check = () => {
        while (run.lines.length) {
          let m;
          try { m = JSON.parse(run.lines.shift()); } catch { continue; }
          const out = dialect.read(m, seat, state);
          if (out?.limit) { limitWarning(out.limit); continue; }
          if (out) return finish(out);
        }
        const e = run.failed();
        if (e) {
          return finish(e.code === 'ENOENT'
            ? { error: `"${command}" was not found. Install it and sign in, or set "command" on the seat.`, status: 404 }
            : { error: e.message });
        }
        if (run.closed()) {
          finish({ error: `exited (${proc.exitCode ?? proc.signalCode}) without an answer. ${run.stderr().trim().split('\n').slice(-3).join(' ')}` });
        }
      };
      run.onChange(check);
      check();
    });
  }

  function limitWarning(info) {
    if (!info || info.status === 'allowed' || warned) return;
    warned = info.status !== 'rejected';
    const windows = Object.entries(info.unifiedWindows ?? {}).map(([k, w]) => `${k} ${Math.round((w.utilization ?? 0) * 100)}%`).join(', ');
    console.warn(`warning: ${seat.name}: subscription usage ${info.status}${windows ? ` (${windows})` : ''}`);
  }

  return {
    async complete({ system, user, schema, effort }) {
      // As in the OpenAI-compatible provider, the schema goes in the prompt: a --json-schema flag
      // would cost an extra turn and pin each started process to one kind of question.
      let text = `${user}\n\nAnswer with one JSON object that matches this JSON Schema and nothing else:\n${JSON.stringify(schema)}`;
      if (!dialect.ownSystemPrompt) text = `${system}\n\n---\n\n${text}`;
      const key = `${effort ?? ''}\n${dialect.ownSystemPrompt ? system : ''}`;
      let run = spare?.key === key && !spare.closed() && !spare.failed() ? spare : null;
      if (spare && !run) spare.proc.kill();
      run ??= start(key, system, effort);
      spare = seat.warm === false ? null : start(key, system, effort);
      const out = await answer(run, dialect.input(text));
      return { text: out.text, refused: !!out.refused, model: out.model, usage: out.usage };
    },
  };
}
