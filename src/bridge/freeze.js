// Game time stands still while any brain is thinking (bridge.freeze, on by default): every copy is paused
// (`pause {on}`, Time.timeScale 0 in the mod) from the moment one seat starts a model call until the last
// one running returns, so a slow model loses no game time. Seats still think on their own and at once.
// While paused, the runner says so again every few seconds; a copy that stops hearing it resumes by itself.
export function createFreezer(clients, { enabled = true, keepAliveMs = 5000, warn = () => {} } = {}) {
  let busy = 0;
  let stopped = false;
  let on = false;
  let since = 0;
  let pausedMs = 0;
  let keepAlive = null;
  let chain = Promise.resolve();

  // Sends go one after another, each with the state at the time it goes out, so an "off" never lands
  // before the "on" it follows.
  const send = () => {
    chain = chain.then(() => Promise.all(clients.map((c) => c.request('pause', { on }).then((r) => {
      if (!r.ok) warn(`pause on copy ${c.id}: ${r.error}`);
    }).catch((e) => warn(`pause on copy ${c.id}: ${e.message}`)))));
    return chain;
  };

  const set = (want) => {
    if (want === on) return;
    on = want;
    if (on) {
      since = Date.now();
      keepAlive = setInterval(send, keepAliveMs);
      keepAlive.unref?.();
    } else {
      pausedMs += Date.now() - since;
      clearInterval(keepAlive);
    }
    send();
  };

  return {
    // Runs one model call with the game paused around it.
    async think(fn) {
      if (!enabled || stopped) return fn();
      busy++;
      set(true);
      try { return await fn(); } finally { if (--busy === 0 && !stopped) set(false); }
    },
    get paused() { return on; },
    // Real milliseconds the game has stood still so far.
    pausedMs: () => pausedMs + (on ? Date.now() - since : 0),
    // The match is over: resume every copy, and pause no more.
    async stop() { stopped = true; set(false); await chain; },
  };
}
