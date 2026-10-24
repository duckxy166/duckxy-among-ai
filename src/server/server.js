// Local web server for the match viewer: static files from web/ (or another `webRoot`), live
// events over SSE, and past matches for replay. Listens on 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// The live match publishes here; every viewer tab gets the backlog first, then the stream.
export function createHub() {
  const events = [];
  const clients = new Set();
  return {
    events,
    clients,
    publish(ev) {
      events.push(ev);
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const res of clients) res.write(line);
    },
  };
}

export function listMatches(matchesDir) {
  if (!fs.existsSync(matchesDir)) return [];
  return fs.readdirSync(matchesDir)
    .filter((id) => fs.existsSync(path.join(matchesDir, id, 'events.jsonl')))
    .sort()
    .reverse();
}

export function readEvents(matchesDir, id) {
  const file = path.join(matchesDir, id, 'events.jsonl');
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function startServer({ port = 7777, matchesDir, hub = null, webRoot = WEB }) {
  const root = path.resolve(webRoot);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': TYPES['.json'] });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/events') {
      if (!hub) return json(404, { error: 'no live match' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const ev of hub.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      hub.clients.add(res);
      req.on('close', () => hub.clients.delete(res));
      return;
    }
    if (url.pathname === '/api/status') return json(200, { live: !!hub });
    if (url.pathname === '/api/matches') return json(200, listMatches(matchesDir));
    const m = url.pathname.match(/^\/api\/matches\/([\w-]+)\/events$/);
    if (m) {
      const events = readEvents(matchesDir, m[1]);
      return events ? json(200, events) : json(404, { error: 'no such match' });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return json(404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
