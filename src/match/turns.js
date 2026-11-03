// Who speaks next at a meeting. Each round goes around the table from the caller, but a player who has
// just been accused out loud answers right away instead of waiting for their seat: once per round each,
// so two players cannot ping-pong the whole meeting. Used by both runners.

const plain = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

// True when `text` names `name` ("Haiku 3" also matches "haiku3").
export function names(text, name) {
  return Boolean(name) && plain(text).includes(plain(name));
}

export function meetingTurns(order, rounds) {
  let round = 1;
  let queue = order.map((seat) => ({ seat }));
  let answered = new Set();
  return {
    // The next { seat, round, replyTo } or null when the discussion is over. replyTo: the accuser.
    next() {
      while (!queue.length) {
        if (++round > rounds) return null;
        queue = order.map((seat) => ({ seat }));
        answered = new Set();
      }
      const turn = queue.shift();
      return { seat: turn.seat, round, replyTo: turn.replyTo ?? null };
    },
    // `speaker` said `text` and suspects `accused` (a seat, or null): an accused player named in the text
    // answers next, if they have not answered in this round and are not up next anyway.
    heard(speaker, text, accused) {
      if (!accused || accused === speaker || answered.has(accused) || !names(text, accused.name)) return false;
      const at = queue.findIndex((t) => t.seat === accused);
      if (at === 0) return false;
      answered.add(accused);
      if (at > 0) queue.splice(at, 1); // their turn this round moves up
      queue.unshift({ seat: accused, replyTo: speaker });
      return true;
    },
  };
}
