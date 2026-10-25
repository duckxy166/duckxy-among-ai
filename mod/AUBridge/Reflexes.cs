using System;
using System.Collections.Generic;
using System.Text.Json;
using UnityEngine;

namespace AUBridge;

public sealed class ReflexDef
{
    public string Type, Target;
    public int MaxWitnesses;
    public float Distance = 4f;
    public int Min = 2;
    public float Eagerness = 0.6f; // fix_sabotage: 0 = reluctant (~20 s base delay), 1 = goes at once
    public float Caution = 0.5f;   // kill_if_alone: how long a witness who just left view still counts (2 + 6*caution s): people fake leaving to catch you
}

// Reflexes: checked ~10 times per second inside the mod; the agent only switches them on.
// A reflex that needs to move the body takes over the current occupation (an "override") and hands it back when done.
public static partial class Body
{
    static List<ReflexDef> _reflexes = new();
    static readonly string[] ReflexTypes = { "kill_if_alone", "report_on_body", "flee_on_kill_seen", "stick_to_group", "avoid", "self_report", "fix_sabotage" };

    // override (a reflex driving the body)
    static string _ovr; static int _ovrPri; static ActArgs _ovrSaved; static bool _ovrSavedAuto;
    static byte _ovrBodyId; static Vector2 _ovrPos; static float _ovrStart, _ovrRetarget, _ovrLastSeen; static string _ovrTarget;
    static float _rNext, _rKillAt, _belowSince;
    static float _fxRetryAt, _fxSeenAt; static string _fxSeenType;
    static float _selfReportAt; static byte _selfReportVictim;
    static readonly Dictionary<byte, float> _seenAt = new(); // kill_if_alone: when each other player was last in view
    static float _quietJitter = 1f, _quietJitterAt;
    static readonly System.Random _rng = new();

    // ---------------- parse / set ----------------
    public static List<ReflexDef> ParseReflexes(JsonElement set)
    {
        if (set.ValueKind != JsonValueKind.Array) throw new BridgeError("'set' must be an array");
        if (set.GetArrayLength() > 12) throw new BridgeError("too many reflexes (max 12)");
        var res = new List<ReflexDef>();
        foreach (var e in set.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object) throw new BridgeError("reflex must be an object");
            var d = new ReflexDef();
            if (!e.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) throw new BridgeError("reflex needs 'type'");
            d.Type = t.GetString();
            if (Array.IndexOf(ReflexTypes, d.Type) < 0) throw new BridgeError("unknown reflex type '" + (d.Type.Length > 30 ? d.Type.Substring(0, 30) : d.Type) + "' (" + string.Join("|", ReflexTypes) + ")");
            if (e.TryGetProperty("target", out var tg) && tg.ValueKind != JsonValueKind.Null)
            {
                if (tg.ValueKind != JsonValueKind.String || tg.GetString().Length > 30) throw new BridgeError("bad target");
                d.Target = tg.GetString();
            }
            if (e.TryGetProperty("maxWitnesses", out var mw) && mw.ValueKind != JsonValueKind.Null)
            {
                if (mw.ValueKind != JsonValueKind.Number || !mw.TryGetInt32(out var mwv) || mwv < 0 || mwv > 10) throw new BridgeError("bad maxWitnesses (0..10)");
                d.MaxWitnesses = mwv;
            }
            if (e.TryGetProperty("distance", out var di) && di.ValueKind != JsonValueKind.Null)
            {
                if (di.ValueKind != JsonValueKind.Number || !di.TryGetSingle(out var dv) || float.IsNaN(dv) || dv < 1f || dv > 15f) throw new BridgeError("bad distance (1..15)");
                d.Distance = dv;
            }
            if (e.TryGetProperty("min", out var mn) && mn.ValueKind != JsonValueKind.Null)
            {
                if (mn.ValueKind != JsonValueKind.Number || !mn.TryGetInt32(out var mnv) || mnv < 1 || mnv > 9) throw new BridgeError("bad min (1..9)");
                d.Min = mnv;
            }
            if (e.TryGetProperty("eagerness", out var eg) && eg.ValueKind != JsonValueKind.Null)
            {
                if (eg.ValueKind != JsonValueKind.Number || !eg.TryGetSingle(out var egv) || float.IsNaN(egv) || egv < 0f || egv > 1f) throw new BridgeError("bad eagerness (0..1)");
                d.Eagerness = egv;
            }
            if (e.TryGetProperty("caution", out var ca) && ca.ValueKind != JsonValueKind.Null)
            {
                if (ca.ValueKind != JsonValueKind.Number || !ca.TryGetSingle(out var cav) || float.IsNaN(cav) || cav < 0f || cav > 1f) throw new BridgeError("bad caution (0..1)");
                d.Caution = cav;
            }
            // legacy 'max' for fix_sabotage is ignored on purpose
            if (d.Type == "avoid" && string.IsNullOrEmpty(d.Target)) throw new BridgeError("avoid needs target");
            foreach (var o in res) if (o.Type == d.Type && (d.Type != "avoid" || string.Equals(o.Target, d.Target, StringComparison.OrdinalIgnoreCase))) throw new BridgeError("duplicate reflex " + d.Type);
            res.Add(d);
        }
        return res;
    }

    static bool PlayerNameExists(string name)
    {
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++)
            if (all[i] != null && all[i].Data != null && string.Equals(all[i].Data.PlayerName, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    public static object SetReflexes(List<ReflexDef> defs)
    {
        if (defs.Count > 0)
        {
            if (!Game.ShipUp || !Game.Started) throw new BridgeError("not in a running game");
            var me = Me;
            foreach (var d in defs)
            {
                if ((d.Type == "kill_if_alone" || d.Type == "self_report") && !Game.AmImpostor(me)) throw new BridgeError(d.Type + " is only for impostors");
                if (d.Type == "fix_sabotage")
                {
                    if (me.Data == null || me.Data.IsDead) throw new BridgeError("fix_sabotage is only for living players");
                }
                if (!string.IsNullOrEmpty(d.Target) && !string.Equals(d.Target, "any", StringComparison.OrdinalIgnoreCase) && !PlayerNameExists(d.Target)) throw new BridgeError("unknown player '" + d.Target + "'");
            }
        }
        _reflexes = defs;
        if (_ovr != null && !HasReflexFor(_ovr)) EndOverride();
        _belowSince = 0;
        Plugin.Logger.LogInfo("[AUB] reflexes set: " + defs.Count);
        return null;
    }

    static bool HasReflexFor(string ovr)
    {
        string t = ovr == "r_report" ? "report_on_body" : ovr == "r_flee" ? "flee_on_kill_seen" : ovr == "r_group" ? "stick_to_group" : ovr == "r_fix" ? "fix_sabotage" : "avoid";
        foreach (var d in _reflexes) if (d.Type == t) return true;
        return false;
    }

    static ReflexDef Find(string type) { foreach (var d in _reflexes) if (d.Type == type) return d; return null; }

    public static List<object> ReflexInfo()
    {
        var res = new List<object>();
        foreach (var d in _reflexes)
        {
            var o = new Dictionary<string, object> { ["type"] = d.Type };
            if (d.Type == "kill_if_alone") { o["target"] = d.Target ?? "any"; o["maxWitnesses"] = d.MaxWitnesses; o["caution"] = d.Caution; }
            if (d.Type == "avoid") { o["target"] = d.Target; o["distance"] = d.Distance; }
            if (d.Type == "stick_to_group") o["min"] = d.Min;
            if (d.Type == "fix_sabotage") o["eagerness"] = d.Eagerness;
            res.Add(o);
        }
        return res;
    }

    static void Fire(string type, string detail)
    {
        Events.Add("reflex_fired", "reflex", type, "detail", detail);
    }

    // ---------------- override machinery ----------------
    static void ClearOverride() { _ovr = null; _ovrSaved = null; _ovrPri = 0; }

    static bool BeginOverride(string kind, int pri)
    {
        if (_ovr != null)
        {
            if (_ovr != kind && _ovrPri >= pri) return false;
            if (_ovr == kind) return true;
            StopCore(); ReleaseFix();
            _kind = kind; _ovr = kind; _ovrPri = pri; Active = true; _ovrStart = Events.Now;
            return true;
        }
        _ovrSavedAuto = _auto;
        _ovrSaved = (_kind == null || _kind.StartsWith("r_")) ? null : _lastArgs;
        if (_kind == "stay" && _lastArgs == null) _ovrSaved = StayArgs;
        Stop(); _auto = false;
        _kind = kind; _ovr = kind; _ovrPri = pri; Active = true; _ovrStart = Events.Now;
        return true;
    }

    static void EndOverride()
    {
        var sv = _ovrSaved; var sa = _ovrSavedAuto;
        ClearOverride();
        Stop();
        if (sv != null)
        {
            try { Act(sv); }
            catch (BridgeError) { _kind = "stay"; Active = true; }
        }
        else if (sa) { _auto = true; Active = true; _kind = null; }
        else { _kind = "stay"; Active = true; }
        Desired = Vector2.zero;
    }

    static bool SetGoal(Vector2 pos, Vector2 g)
    {
        _goal = g; _hasGoal = true;
        return Replan(pos);
    }

    // ---------------- hooks from Game ----------------
    static readonly HashSet<byte> _myVictims = new();
    public static void ResetVictims() { _myVictims.Clear(); }
    public static void OnKilled(PlayerControl victim)
    {
        _myVictims.Add(victim.PlayerId);
        if (Find("self_report") != null) { _selfReportAt = Events.Now + 0.3f; _selfReportVictim = victim.PlayerId; }
    }

    public static void OnSawKill(string killer, string victim)
    {
        var d = Find("flee_on_kill_seen");
        var me = Me;
        if (d == null || me == null || me.Data == null || me.Data.IsDead || !Game.ShipUp || !Nav.Ready || Game.InMeetingOrExile) return;
        var pos = me.GetTruePosition();
        var others = new List<Game.PInfo>();
        foreach (var v in Game.Visible(me, pos, Game.LightRadius(me)))
            if (v.Alive && !string.Equals(v.Name, killer, StringComparison.OrdinalIgnoreCase) && !string.Equals(v.Name, victim, StringComparison.OrdinalIgnoreCase)) others.Add(v);
        Vector2 goal; string where;
        if (others.Count >= 2)
        {
            others.Sort((x, y) => x.Dist.CompareTo(y.Dist));
            goal = others[0].Pos; where = "group near " + others[0].Name;
        }
        else if (Nav.RoomGoal("Cafeteria", out goal)) where = "Cafeteria";
        else return;
        if (!BeginOverride("r_flee", 4)) return;
        if (!SetGoal(pos, goal)) { EndOverride(); return; }
        Fire("flee_on_kill_seen", $"saw {killer} kill {victim}, running to {where}");
    }

    // ---------------- per-frame (decisions at 10 Hz) ----------------
    static void ReflexUpdate(PlayerControl me, float now)
    {
        if (_reflexes.Count == 0 && _ovr == null && _selfReportAt == 0) return;
        if (me.Data == null || me.Data.IsDead) { if (_ovr != null) { ClearOverride(); StopCore(); _kind = "stay"; Active = true; } _selfReportAt = 0; return; }
        if (now < _rNext) return;
        _rNext = now + 0.1f;
        var pos = me.GetTruePosition();
        float rad = Game.LightRadius(me);
        bool imp = Game.AmImpostor(me);
        string partner = imp ? Game.Partner(me) : null;
        var vis = new List<Game.PInfo>();
        foreach (var v in Game.Visible(me, pos, rad)) if (v.Alive) vis.Add(v);
        var bodies = Game.Bodies(me, pos, rad);
        var reportable = new List<Game.BInfo>();
        foreach (var b in bodies) if (!_myVictims.Contains(b.Id)) reportable.Add(b); // report_on_body never fires on our own kills (that is self_report)

        // self_report: our own victim, right after the kill
        if (_selfReportAt > 0 && now >= _selfReportAt)
        {
            Game.BInfo mine = null;
            foreach (var b in bodies) if (b.Id == _selfReportVictim) { mine = b; break; }
            if (mine != null && mine.Dist <= me.MaxReportDistance * 0.95f)
            {
                _selfReportAt = 0;
                try { ReportBody(me, mine); Fire("self_report", "reported own victim " + mine.Name); } catch (BridgeError e) { Plugin.Logger.LogWarning("[AUB] self_report: " + e.Message); }
            }
            else if (now > _selfReportAt + 3f) _selfReportAt = 0;
        }

        // kill_if_alone
        var kd = Find("kill_if_alone");
        if (imp) foreach (var v in vis) _seenAt[v.Id] = now;
        if (kd != null && imp && !me.inVent && me.killTimer <= 0.05f && now >= _rKillAt)
        {
            float range = KillRange();
            Game.PInfo pick = null; int pw = 0;
            foreach (var c in vis)
            {
                if (c.Dist > range || string.Equals(c.Name, partner, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(kd.Target) && !string.Equals(kd.Target, "any", StringComparison.OrdinalIgnoreCase) && !string.Equals(kd.Target, c.Name, StringComparison.OrdinalIgnoreCase)) continue;
                int w = 0;
                foreach (var o in vis) if (o.Id != c.Id && !string.Equals(o.Name, partner, StringComparison.OrdinalIgnoreCase)) w++;
                if (w <= kd.MaxWitnesses && (pick == null || c.Dist < pick.Dist)) { pick = c; pw = w; }
            }
            if (pick != null)
            {
                // Someone who stepped out of view a moment ago may be faking it and come right back:
                // count them as a witness for 2 + 6*caution seconds (x0.8..1.4, re-rolled every 20 s so it is not clockwork).
                if (now >= _quietJitterAt) { _quietJitter = 0.8f + (float)_rng.NextDouble() * 0.6f; _quietJitterAt = now + 20f; }
                float quiet = (2f + 6f * kd.Caution) * _quietJitter;
                int recent = 0;
                foreach (var kv in _seenAt)
                {
                    if (kv.Key == pick.Id || now - kv.Value > quiet) continue;
                    bool inView = false, isPartner = false;
                    foreach (var o in vis) if (o.Id == kv.Key) { inView = true; break; }
                    if (inView) continue; // already counted above
                    var pc = GameData.Instance != null ? GameData.Instance.GetPlayerById(kv.Key) : null;
                    if (pc == null || pc.IsDead || pc.Disconnected) continue;
                    if (partner != null && string.Equals(pc.PlayerName, partner, StringComparison.OrdinalIgnoreCase)) isPartner = true;
                    if (!isPartner) recent++;
                }
                if (pw + recent > kd.MaxWitnesses) pick = null;
            }
            if (pick != null)
            {
                try { DoKill(me, pick); _rKillAt = now + 1.5f; Fire("kill_if_alone", $"kill {pick.Name}, witnesses {pw}"); }
                catch (BridgeError e) { Plugin.Logger.LogWarning("[AUB] kill_if_alone: " + e.Message); }
            }
        }

        // report_on_body
        if (Find("report_on_body") != null && !me.inVent && reportable.Count > 0)
        {
            Game.BInfo nb = null;
            foreach (var b in reportable) if (nb == null || b.Dist < nb.Dist) nb = b;
            if (nb.Dist <= me.MaxReportDistance * 0.9f)
            {
                try { ReportBody(me, nb); Fire("report_on_body", "reported " + nb.Name); } catch (BridgeError e) { Plugin.Logger.LogWarning("[AUB] report_on_body: " + e.Message); }
                return;
            }
            if (_ovr != "r_report" && BeginOverride("r_report", 3))
            {
                _ovrBodyId = nb.Id; _ovrPos = nb.Pos;
                if (SetGoal(pos, nb.Pos)) Fire("report_on_body", $"walking to the body of {nb.Name} in {nb.Room ?? "hallway"}");
                else EndOverride();
            }
        }

        // fix_sabotage
        if (Find("fix_sabotage") != null) FixSabotageReflex(me, pos, now, vis);

        // avoid
        foreach (var d in _reflexes)
        {
            if (d.Type != "avoid") continue;
            Game.PInfo t = null;
            foreach (var v in vis) if (string.Equals(v.Name, d.Target, StringComparison.OrdinalIgnoreCase)) { t = v; break; }
            if (_ovr == "r_avoid" && string.Equals(_ovrTarget, d.Target, StringComparison.OrdinalIgnoreCase))
            {
                if (t != null) _ovrLastSeen = now;
                if ((t == null && now - _ovrLastSeen > 1.0f) || (t != null && t.Dist >= d.Distance + 1.5f)) { EndOverride(); continue; }
                if (t != null && now >= _ovrRetarget) { _ovrRetarget = now + 0.6f; AvoidGoal(pos, t.Pos); }
            }
            else if (t != null && t.Dist < d.Distance && _ovr == null || (t != null && t.Dist < d.Distance && _ovr != null && _ovrPri < 2))
            {
                if (BeginOverride("r_avoid", 2))
                {
                    _ovrTarget = d.Target; _ovrLastSeen = now; _ovrRetarget = now + 0.6f;
                    if (AvoidGoal(pos, t.Pos)) Fire("avoid", $"{t.Name} is {t.Dist:0.0} away, backing off");
                    else EndOverride();
                }
            }
        }

        // stick_to_group
        var gd = Find("stick_to_group");
        if (gd != null)
        {
            if (vis.Count < gd.Min)
            {
                if (_belowSince == 0) _belowSince = now;
                if (now - _belowSince >= 1.0f)
                {
                    bool atTask = !(_kind == null || _kind == "stay" || _kind == "wander" || _kind == "r_group"); // only idle/wander may be pulled to a group: never walking to a task console, doing one, moving to a goal or fixing
                    if (!atTask && (_ovr == null || _ovr == "r_group" || _ovrPri < 1))
                    {
                        bool fresh = _ovr != "r_group";
                        if (fresh || now >= _ovrRetarget)
                        {
                            Game.PInfo near = null;
                            foreach (var v in vis) if (near == null || v.Dist < near.Dist) near = v;
                            Vector2 g; string where;
                            if (near != null) { g = near.Pos; where = near.Name; }
                            else if (Nav.RoomGoal("Cafeteria", out g)) where = "Cafeteria";
                            else g = pos + Vector2.zero;
                            where = near != null ? near.Name : "Cafeteria";
                            if (!BeginOverride("r_group", 1)) { /* a stronger reflex is driving */ }
                            else
                            {
                                _ovrRetarget = now + 0.6f;
                                if (SetGoal(pos, g)) { if (fresh) Fire("stick_to_group", $"only {vis.Count} in sight, joining {where}"); }
                                else if (fresh) EndOverride();
                            }
                        }
                    }
                }
            }
            else
            {
                _belowSince = 0;
                if (_ovr == "r_group" && now - _ovrStart >= 1.5f) EndOverride();
            }
        }
        else if (_ovr == "r_group") EndOverride();
    }

    // go and repair an active sabotage on our own, when our personal delay has run out (impostors too: it is cover).
    // delay = base(eagerness) * distFactor * urgency(age) * (emergency ? 0.3 : 1) [+ short courtesy delay if someone already works the panel]
    //   base = 20 s * (1 - eagerness); distFactor = 0.5 (panel within 5) .. 1.5 (30+ away); urgency = max(0, 1 - age/27 s)
    // so everybody goes by ~27 s after the sabotage began, whatever their eagerness. age counts from the start of the sabotage, not from a meeting's end.
    static void FixSabotageReflex(PlayerControl me, Vector2 pos, float now, List<Game.PInfo> vis)
    {
        var sab = Game.Sabotage().type;
        if (sab != _fxSeenType) { _fxSeenType = sab; _fxSeenAt = now; }
        if (sab == null || _ovr == "r_fix" || _kind == "fix" || me.inVent || now < _fxRetryAt) return;
        if (_ovr != null && _ovrPri >= 2) return; // report/flee/avoid are driving
        List<(Vector2 pos, int id)> cons;
        try { cons = SabConsoles(me, sab); } catch (BridgeError) { return; } // repair task not delivered yet: try next tick
        var d = Find("fix_sabotage");
        bool emergency = sab == "reactor" || sab == "o2";
        float age = now - _fxSeenAt;
        float urgency = Mathf.Max(0f, 1f - age / 27f);
        string note;
        float nearest = float.MaxValue;
        foreach (var c in cons) nearest = Mathf.Min(nearest, Vector2.Distance(pos, c.pos));
        float distFactor = 0.5f + Mathf.Clamp01((nearest - 5f) / 25f);
        float delay = 20f * (1f - d.Eagerness) * distFactor * (emergency ? 0.3f : 1f);
        string why = $"base {delay:0.0}s";
        if (sab == "reactor")
        {
            // the console (id 0/1) with fewer visible repairers, then the closer one
            (Vector2 pos, int id) best = cons[0]; int bf = int.MaxValue; float bd = float.MaxValue;
            foreach (var c in cons)
            {
                int f = 0; foreach (var v in vis) if (Vector2.Distance(v.Pos, c.pos) < 2.5f) f++;
                float dist = Vector2.Distance(pos, c.pos);
                if (f < bf || (f == bf && dist < bd)) { best = c; bf = f; bd = dist; }
            }
            cons = new List<(Vector2, int)> { best }; note = $"console {best.id}, {bf} already there";
        }
        else
        {
            cons.Sort((x, y) => Vector2.Distance(pos, x.pos).CompareTo(Vector2.Distance(pos, y.pos)));
            if (sab == "o2") note = "both O2 panels";
            else
            {
                var c0 = cons[0]; int atPanel = 0;
                foreach (var v in vis) if (v.Alive && Vector2.Distance(v.Pos, c0.pos) < 2.5f) atPanel++;
                if (atPanel > 0) { delay += 5f; why += ", +5s: someone already at the panel"; }
                cons = new List<(Vector2, int)> { c0 }; note = $"{atPanel} at the panel";
            }
        }
        float need = delay * urgency;
        if (age < need) return; // not yet: urgency keeps shrinking the wait, at ~27 s it is zero for everybody
        if (!BeginOverride("r_fix", 2)) return;
        _fxType = sab; _fxActive = true; _fxHolding = false; _fxPhase = 0; _fxQueue = cons; _fxOps = 0; _fxEndAt = 0;
        _fxCurId = cons[0].id;
        if (!SetGoal(pos, cons[0].pos)) { _fxActive = false; _fxRetryAt = now + 3f; EndOverride(); return; }
        Fire("fix_sabotage", $"{sab}: going to fix after {age:0.0}s ({why}, dist {nearest:0}, urgency {urgency:0.00}), {note}");
    }

    // a point away from the threat that we can reach on foot
    static bool AvoidGoal(Vector2 pos, Vector2 threat)
    {
        Vector2 best = pos; float bd = Vector2.Distance(pos, threat) + 0.01f; bool found = false;
        for (int k = 0; k < 16; k++)
        {
            float ang = k * Mathf.PI / 8f;
            var dir = new Vector2(Mathf.Cos(ang), Mathf.Sin(ang));
            for (float r = 6f; r >= 2.5f; r -= 1.5f)
            {
                var p = pos + dir * r;
                if (!Nav.WalkAt(p) || !Nav.Los(pos, p)) continue;
                float d = Vector2.Distance(p, threat);
                if (d > bd) { bd = d; best = p; found = true; }
                break;
            }
        }
        if (!found) return false;
        return SetGoal(pos, best);
    }

    // drives the body while an override is active
    static void OvrUpdate(PlayerControl me, Vector2 pos, float now)
    {
        switch (_ovr)
        {
            case "r_report":
                {
                    if (now - _ovrStart > 40f) { EndOverride(); return; }
                    if (Vector2.Distance(pos, _ovrPos) <= me.MaxReportDistance * 0.8f)
                    {
                        Game.BInfo hit = null;
                        foreach (var b in Game.Bodies(me, pos, Game.LightRadius(me))) if (b.Id == _ovrBodyId) { hit = b; break; }
                        if (hit != null && hit.Dist <= me.MaxReportDistance * 0.95f)
                        {
                            try { ReportBody(me, hit); Fire("report_on_body", "reported " + hit.Name); } catch (BridgeError e) { Plugin.Logger.LogWarning("[AUB] report: " + e.Message); }
                        }
                        EndOverride();
                        return;
                    }
                    int r = Drive(pos, now);
                    if (r != 0) EndOverride();
                    return;
                }
            case "r_flee":
                {
                    if (now - _ovrStart > 15f) { EndOverride(); return; }
                    int r = Drive(pos, now);
                    if (r != 0) EndOverride();
                    return;
                }
            case "r_fix": UpdateFix(me, pos, now); return;
            case "r_group":
            case "r_avoid":
                {
                    int r = Drive(pos, now);
                    if (r == 1) { Desired = Vector2.zero; }
                    else if (r == 2) { _stuckN = 0; _path = null; Desired = Vector2.zero; }
                    return;
                }
        }
    }
}
