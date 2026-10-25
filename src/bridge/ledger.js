// The facts a real-game match pieces together from every copy (CONTEXT.md: MatchLedger): who is
// alive, who is publicly known dead, where each body fell, who witnessed a kill, the active sabotage
// and which reactor panel each fixing seat holds. No sockets and no clock, so it is tested with
// plain calls. A seat may read only public facts, its own liveness and its own panel from it;
// witnesses, body rooms and other seats' liveness go only to the event log.

export class MatchLedger {
  // seats: [{ id, name }]. emit(event) writes the event log. inView(seatId) is the Set of names that
  // seat's own copy shows it right now: sightings stay in the seat, the ledger only asks.
  constructor({ seats, emit, inView }) {
    this.seats = seats.map(({ id, name }) => ({ id, name }));
    this.emit = emit;
    this.inView = inView;
    this.dead = new Set();
    this.known = new Set(); // announced at a meeting or ejected, in that order
    this.bodies = new Map(); // victim name -> room
    this.sabotage = null;
    this.panels = new Map(); // seat id -> reactor panel 0 or 1
  }

  byName(name) { return this.seats.find((s) => s.name === name) ?? null; }

  alive(id) { return !this.dead.has(id); }

  // Death is one-way, and any copy may report it first: the victim's own, the killer's, or the vote.
  died(id) { this.dead.add(id); }

  // From the killer's own copy. The victim's copy may have reported the death already.
  killed(killerId, victimName, room) {
    this.bodies.set(victimName, room);
    const victim = this.byName(victimName);
    if (!victim) return;
    this.died(victim.id);
    const killer = this.seats.find((s) => s.id === killerId);
    const witnesses = this.seats
      .filter((s) => s.id !== killerId && this.alive(s.id) && this.inView(s.id).has(killer.name))
      .map((s) => s.id);
    this.emit({ type: 'kill', killer: killerId, victim: victim.id, room, witnesses });
  }

  bodyRoom(name) { return this.bodies.get(name) ?? null; }

  // A meeting tells everyone who died since the last one.
  announceDead() {
    const fresh = this.seats.filter((s) => this.dead.has(s.id) && !this.known.has(s.id)).map((s) => s.id);
    for (const id of fresh) this.known.add(id);
    return fresh;
  }

  ejected(id) {
    this.died(id);
    this.known.add(id);
  }

  knownDead() { return [...this.known].map((id) => this.seats.find((s) => s.id === id).name); }

  // Only from the impostor's own `sabotage` act: the copies' sabotage events do not say who.
  sabotaged(by, kind) {
    this.sabotage = kind;
    this.panels.clear();
    this.emit({ type: 'sabotage', kind, by, deadline: null });
  }

  // Every copy reports the fix; the first report closes it.
  fixed(kind) {
    if (this.sabotage !== kind) return;
    this.sabotage = null;
    this.panels.clear();
    this.emit({ type: 'sabotage_fixed', kind, by: [] });
  }

  // The reactor needs both panels held at once, and `fix` without a console id walks to the nearest
  // one, so crewmates starting from the same side all held one panel (live run 3). Give the panel
  // that fewer living others hold. On a tie a seat asking again keeps its own (walking across wastes
  // the countdown), anyone else gets 0. Other sabotages get undefined: the mod's own choice.
  reactorPanel(id, kind) {
    if (kind !== 'reactor') return undefined;
    const mine = this.panels.get(id);
    this.panels.delete(id);
    const held = [0, 0];
    for (const [other, panel] of this.panels) if (this.alive(other)) held[panel]++;
    const panel = held[0] === held[1] ? mine ?? 0 : held[1] < held[0] ? 1 : 0;
    this.panels.set(id, panel);
    return panel;
  }

  releasePanel(id) { this.panels.delete(id); }
}
