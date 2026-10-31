using System;
using System.Collections.Generic;
using System.Text.Json;
using UnityEngine;

namespace AUBridge;

// Step "Actions": instant actions (kill, report, vote, chat, vent, sabotage) and the two occupations call_meeting and fix.
// Everything goes through the game's own commands and checks; nothing here teleports or reads other players' roles.
public static partial class Body
{
    static readonly ActArgs StayArgs = new ActArgs { Do = "stay" };
    static ActArgs _lastArgs;
    static float _lastChatAt;
    static IntPtr _votedMeeting;
    public static void ResetVote() { _votedMeeting = IntPtr.Zero; }

    static object Done(ActArgs a, Dictionary<string, object> extra)
    {
        extra["ok"] = true; extra["accepted"] = a.Do;
        Plugin.Logger.LogInfo("[AUB] act " + a.Do);
        return extra;
    }

    static void NeedLive(bool needAlive = true)
    {
        if (!Game.ShipUp || !Game.Started) throw new BridgeError("not in a running game");
        if (Game.InMeetingOrExile) throw new BridgeError("not during a meeting");
        if (needAlive && Me.Data.IsDead) throw new BridgeError("you are dead");
    }

    internal static float KillRange()
    {
        try { return GameManager.Instance.LogicOptions.GetKillDistance(); } catch { return 1.8f; }
    }

    static PlayerControl PlayerById(byte id)
    {
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++) if (all[i] != null && all[i].PlayerId == id) return all[i];
        return null;
    }

    // ---------------- kill ----------------
    internal static void DoKill(PlayerControl me, Game.PInfo hit)
    {
        var tp = PlayerById(hit.Id);
        if (tp == null) throw new BridgeError("target not found");
        me.CmdCheckMurder(tp);
    }

    internal static Dictionary<string, object> ActKill(ActArgs a)
    {
        var me = Me;
        NeedLive();
        if (!Game.AmImpostor(me)) throw new BridgeError("only an impostor can kill");
        if (me.inVent) throw new BridgeError("cannot kill from a vent");
        if (string.IsNullOrEmpty(a.Target)) throw new BridgeError("kill needs target");
        if (me.killTimer > 0.05f) throw new BridgeError($"kill cooldown {me.killTimer:0.0}s left");
        var pos = me.GetTruePosition();
        Game.PInfo hit = null;
        foreach (var v in Game.Visible(me, pos, Game.LightRadius(me))) if (string.Equals(v.Name, a.Target, StringComparison.OrdinalIgnoreCase)) { hit = v; break; }
        if (hit == null) throw new BridgeError("target not visible");
        if (!hit.Alive) throw new BridgeError("target is already dead");
        if (Game.IsPartner(me, hit.Name)) throw new BridgeError("cannot kill your partner");
        float range = KillRange();
        if (hit.Dist > range) throw new BridgeError($"target out of kill range ({hit.Dist:0.0} > {range:0.0})");
        DoKill(me, hit);
        if (_kind == "follow" && string.Equals(_fTarget, hit.Name, StringComparison.OrdinalIgnoreCase)) { Stop(); _kind = "stay"; Active = true; }
        return new Dictionary<string, object> { ["target"] = hit.Name, ["distance"] = Math.Round(hit.Dist, 2) };
    }

    // ---------------- report ----------------
    internal static Dictionary<string, object> ReportBody(PlayerControl me, Game.BInfo b)
    {
        var info = GameData.Instance.GetPlayerById(b.Id);
        if (info == null) throw new BridgeError("body owner unknown");
        me.CmdReportDeadBody(info);
        return new Dictionary<string, object> { ["body"] = b.Name, ["distance"] = Math.Round(b.Dist, 2) };
    }

    internal static Dictionary<string, object> ActReport(ActArgs a)
    {
        var me = Me;
        NeedLive();
        if (me.inVent) throw new BridgeError("cannot report from a vent");
        var pos = me.GetTruePosition();
        Game.BInfo best = null;
        foreach (var b in Game.Bodies(me, pos, Game.LightRadius(me)))
        {
            if (a.Target != null && !string.Equals(b.Name, a.Target, StringComparison.OrdinalIgnoreCase)) continue;
            if (best == null || b.Dist < best.Dist) best = b;
        }
        if (best == null) throw new BridgeError(a.Target != null ? "that body is not visible" : "no body visible");
        if (best.Dist > me.MaxReportDistance) throw new BridgeError($"body too far ({best.Dist:0.0} > {me.MaxReportDistance:0.0})");
        return ReportBody(me, best);
    }

    // ---------------- vote ----------------
    internal static Dictionary<string, object> ActVote(ActArgs a)
    {
        var m = MeetingHud.Instance;
        if (m == null) throw new BridgeError("no meeting");
        var me = Me;
        if (me == null || me.Data == null) throw new BridgeError("not in game");
        if (me.Data.IsDead) throw new BridgeError("dead players cannot vote");
        if (_votedMeeting == m.Pointer) throw new BridgeError("already voted");
        switch (m.state)
        {
            case MeetingHud.MeetingStates.NotVoted: break;
            case MeetingHud.MeetingStates.Voted: throw new BridgeError("already voted");
            case MeetingHud.MeetingStates.Animating:
            case MeetingHud.MeetingStates.Discussion: throw new BridgeError("voting is not open yet");
            default: throw new BridgeError("voting is over");
        }
        if (string.IsNullOrEmpty(a.Target)) throw new BridgeError("vote needs target (name or 'skip')");
        byte suspect;
        string shown;
        if (string.Equals(a.Target, "skip", StringComparison.OrdinalIgnoreCase)) { suspect = PlayerVoteArea.SkippedVote; shown = "skip"; }
        else
        {
            int found = -1; shown = null;
            var ps = m.playerStates;
            for (int i = 0; ps != null && i < ps.Length; i++)
            {
                var s = ps[i]; if (s == null) continue;
                var nm = Game.NameOf(s.PlayerId);
                if (nm != null && string.Equals(nm, a.Target, StringComparison.OrdinalIgnoreCase)) { found = s.PlayerId; shown = nm; if (s.AmDead) throw new BridgeError("cannot vote for a dead player"); break; }
            }
            if (found < 0) throw new BridgeError("unknown player '" + a.Target + "'");
            suspect = (byte)found;
        }
        m.CmdCastVote(me.PlayerId, suspect);
        _votedMeeting = m.Pointer;
        return new Dictionary<string, object> { ["vote"] = shown };
    }

    // ---------------- chat ----------------
    internal static Dictionary<string, object> ActChat(ActArgs a)
    {
        var me = Me;
        if (me == null || me.Data == null) throw new BridgeError("not in game");
        string t = a.Text;
        if (string.IsNullOrWhiteSpace(t)) throw new BridgeError("chat needs text");
        t = t.Trim();
        if (t.Length > 100) throw new BridgeError("chat text too long (max 100)");
        foreach (var ch in t) if (char.IsControl(ch)) throw new BridgeError("chat text has control characters");
        bool lobby = AmongUsClient.Instance != null && AmongUsClient.Instance.GameState == InnerNet.InnerNetClient.GameStates.Joined;
        if (!lobby && MeetingHud.Instance == null) throw new BridgeError("chat is only available in meetings (after meeting_started) and in the lobby");
        float now = UnityEngine.Time.realtimeSinceStartup; // the game's own limit, in real time even while paused
        if (now - _lastChatAt < 1.0f) throw new BridgeError("chat too fast (1 message per second)");
        if (!me.RpcSendChat(t)) throw new BridgeError("chat was rejected by the game");
        _lastChatAt = now;
        return new Dictionary<string, object> { ["length"] = t.Length };
    }

    // ---------------- vent ----------------
    internal static Dictionary<string, object> ActVent(ActArgs a)
    {
        var me = Me;
        NeedLive();
        if (!Game.AmImpostor(me) || me.Data.Role == null || !me.Data.Role.CanVent) throw new BridgeError("you cannot use vents");
        bool enter = a.Enter ?? !me.inVent;
        if (a.To != null)
        {
            if (!me.inVent || global::Vent.currentVent == null) throw new BridgeError("'to' works only while inside a vent");
            var cur = global::Vent.currentVent;
            global::Vent other = null;
            switch (a.To.ToLowerInvariant())
            {
                case "left": other = cur.Left; break;
                case "right": other = cur.Right; break;
                case "center": case "centre": other = cur.Center; break;
                default:
                    if (int.TryParse(a.To, out var vid))
                    {
                        if (cur.Left != null && cur.Left.Id == vid) other = cur.Left;
                        else if (cur.Right != null && cur.Right.Id == vid) other = cur.Right;
                        else if (cur.Center != null && cur.Center.Id == vid) other = cur.Center;
                    }
                    break;
            }
            if (other == null) throw new BridgeError("no such neighbouring vent (left|right|center|id)");
            string err;
            if (!cur.TryMoveToVent(other, out err)) throw new BridgeError("vent move failed: " + err);
            return new Dictionary<string, object> { ["vent"] = other.Id };
        }
        if (!enter)
        {
            if (!me.inVent || global::Vent.currentVent == null) throw new BridgeError("not in a vent");
            var cv = global::Vent.currentVent;
            cv.Use();
            return new Dictionary<string, object> { ["exit"] = cv.Id };
        }
        if (me.inVent) throw new BridgeError("already in a vent");
        var vents = ShipStatus.Instance.AllVents;
        global::Vent best = null; float bd = 1e9f;
        for (int i = 0; vents != null && i < vents.Length; i++)
        {
            var v = vents[i]; if (v == null) continue;
            float d = v.CanUse(me.Data, out var can, out _);
            if (can && d < bd) { bd = d; best = v; }
        }
        if (best == null) throw new BridgeError("no usable vent in reach");
        best.Use();
        return new Dictionary<string, object> { ["enter"] = best.Id };
    }

    // Where a vent leads: its neighbours and their rooms (null in a corridor). The game shows these as
    // arrows inside the vent, and every impostor knows the map, so this reveals nothing about players.
    static List<object> VentExits(global::Vent v)
    {
        var res = new List<object>();
        foreach (var n in new[] { v.Left, v.Right, v.Center })
            if (n != null) res.Add(new Dictionary<string, object> { ["id"] = n.Id, ["room"] = Game.RoomAt(n.transform.position) });
        return res;
    }

    // vents the impostor can currently see (lit and in sight only)
    internal static List<object> VentsForState(PlayerControl me, Vector2 a, float radius)
    {
        var res = new List<object>();
        if (!Game.AmImpostor(me) || me.Data.IsDead) return res;
        var vents = ShipStatus.Instance.AllVents;
        for (int i = 0; vents != null && i < vents.Length; i++)
        {
            var v = vents[i]; if (v == null) continue;
            Vector2 p = v.transform.position;
            if (Vector2.Distance(a, p) > radius) continue;
            Vector2 q = p + (a - p).normalized * 0.35f; // vents sit in the wall line: test from just in front of them
            if (PhysicsHelpers.AnythingBetween(a, q, Constants.ShadowMask, false)) continue;
            res.Add(new Dictionary<string, object> { ["id"] = v.Id, ["pos"] = new[] { Math.Round(p.x, 2), Math.Round(p.y, 2) }, ["room"] = Game.RoomAt(p), ["distance"] = Math.Round(Vector2.Distance(a, p), 2), ["to"] = VentExits(v) });
        }
        if (me.inVent && global::Vent.currentVent != null)
        {
            var c = global::Vent.currentVent;
            res.Add(new Dictionary<string, object> { ["current"] = c.Id, ["left"] = c.Left != null ? c.Left.Id : (int?)null, ["right"] = c.Right != null ? c.Right.Id : (int?)null, ["center"] = c.Center != null ? c.Center.Id : (int?)null, ["to"] = VentExits(c) });
        }
        return res;
    }

    // ---------------- sabotage ----------------
    static SystemTypes SabSystem(string type)
    {
        switch ((type ?? "").ToLowerInvariant())
        {
            case "lights": return SystemTypes.Electrical;
            case "reactor": return SystemTypes.Reactor;
            case "o2": return SystemTypes.LifeSupp;
            case "comms": return SystemTypes.Comms;
            default: throw new BridgeError("bad type (lights|reactor|o2|comms)");
        }
    }

    internal static Dictionary<string, object> ActSabotage(ActArgs a)
    {
        var me = Me;
        NeedLive(false); // a dead impostor (ghost) may still sabotage, as in the game
        if (!Game.AmImpostor(me)) throw new BridgeError("only an impostor can sabotage");
        var sys = SabSystem(a.Type);
        var ship = ShipStatus.Instance;
        ISystemType st;
        if (ship.Systems.TryGetValue(SystemTypes.Sabotage, out st))
        {
            var sab = st.TryCast<SabotageSystemType>();
            if (sab != null)
            {
                if (sab.AnyActive) throw new BridgeError("a sabotage is already active");
                if (sab.Timer > 0.05f) throw new BridgeError($"sabotage cooldown {sab.Timer:0.0}s left");
            }
        }
        if (Game.Sabotage().type != null) throw new BridgeError("a sabotage is already active");
        ship.RpcUpdateSystem(SystemTypes.Sabotage, (byte)sys);
        return new Dictionary<string, object> { ["type"] = a.Type.ToLowerInvariant() };
    }

    // ---------------- call_meeting ----------------
    static float _cmArrivedAt;

    // The same rules the emergency-button screen enforces: no meetings left, crisis sabotage, round start / cooldown.
    static string ButtonBlocked(PlayerControl me)
    {
        if (me.Data.IsDead) return "you are dead";
        if (me.RemainingEmergencies <= 0) return "no emergency meetings left";
        var tl = me.myTasks;
        for (int i = 0; tl != null && i < tl.Count; i++)
        {
            bool crisis = false;
            try { crisis = tl[i] != null && PlayerTask.TaskIsEmergency(tl[i]); } catch { }
            if (crisis) return "emergency meetings cannot be called during a crisis";
        }
        var ship = ShipStatus.Instance;
        float wait = Math.Max(EmergencyMinigame.MinEmergencyTime - ship.Timer, ship.EmergencyCooldown);
        if (wait > 0f) return $"emergency button cooldown {wait:0.0}s left";
        return null;
    }

    static void StartCallMeeting()
    {
        var me = Me;
        if (me.inVent) throw new BridgeError("you are in a vent");
        var blocked = ButtonBlocked(me);
        if (blocked != null) throw new BridgeError(blocked);
        var btn = ShipStatus.Instance.EmergencyButton;
        if (btn == null) throw new BridgeError("no emergency button");
        Vector2 g = btn.transform.position;
        _auto = false; Stop(); _kind = "call_meeting"; _goal = g; _hasGoal = true; Active = true; _cmArrivedAt = 0;
        if (!Replan(me.GetTruePosition())) { Stop(); throw new BridgeError("no path to the button"); }
    }

    static void UpdateCallMeeting(PlayerControl me, Vector2 pos, float now)
    {
        var btn = ShipStatus.Instance.EmergencyButton;
        if (btn == null) { GiveUp(); return; }
        bool can = false;
        try { btn.CanUse(me.Data, out can, out _); } catch { }
        if (can || (_cmArrivedAt > 0 && now - _cmArrivedAt > 1f))
        {
            if (!can) Plugin.Logger.LogWarning("[AUB] button: CanUse false at arrival, pressing anyway");
            Desired = Vector2.zero;
            var blocked = ButtonBlocked(me); // things may have changed on the way (crisis sabotage, meeting used up)
            if (blocked != null || Vector2.Distance(pos, (Vector2)btn.transform.position) > 2.2f)
            {
                Plugin.Logger.LogWarning("[AUB] call_meeting refused at the button: " + (blocked ?? "too far"));
                Events.Add("button_refused", "reason", blocked ?? "too far from the button");
                _kind = "stay"; return;
            }
            try { me.CmdReportDeadBody(null); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] call_meeting failed: " + e.Message); }
            Events.Add("button_pressed", "room", Game.RoomAt(pos));
            _kind = "stay"; return;
        }
        int r = Drive(pos, now);
        if (r == 1) { if (_cmArrivedAt == 0) _cmArrivedAt = now; Desired = Vector2.zero; }
        else if (r == 2) GiveUp();
    }

    // ---------------- fix ----------------
    static string _fxType; static bool _fxActive, _fxHolding; static int _fxPhase; static float _fxUntil, _fxNextAt, _fxEndAt;
    static List<(Vector2 pos, int id)> _fxQueue = new(); static int _fxCurId; static int _fxOps;

    static TaskTypes SabTask(string type)
    {
        switch (type)
        {
            case "lights": return TaskTypes.FixLights;
            case "comms": return TaskTypes.FixComms;
            case "reactor": return TaskTypes.ResetReactor;
            default: return TaskTypes.RestoreOxy;
        }
    }

    static List<(Vector2 pos, int id)> SabConsoles(PlayerControl me, string type)
    {
        PlayerTask task = null;
        var tl = me.myTasks;
        for (int i = 0; tl != null && i < tl.Count; i++) if (tl[i] != null && tl[i].TaskType == SabTask(type)) { task = tl[i]; break; }
        var res = new List<(Vector2, int)>();
        var cons = ShipStatus.Instance.AllConsoles;
        if (task == null && Game.AmImpostor(me))
        {
            // impostors get no repair task: match consoles by the task type they serve (used for the fix_sabotage cover reflex)
            for (int i = 0; cons != null && i < cons.Length; i++)
            {
                var c = cons[i]; if (c == null || c.TaskTypes == null) continue;
                bool ok = false;
                for (int k = 0; k < c.TaskTypes.Length; k++) if (c.TaskTypes[k] == SabTask(type)) ok = true;
                if (ok) res.Add((c.transform.position, c.ConsoleId));
            }
            if (res.Count == 0) throw new BridgeError("no repair console found");
            return res;
        }
        if (task == null) throw new BridgeError("you have no repair task for this sabotage yet");
        for (int i = 0; cons != null && i < cons.Length; i++)
        {
            var c = cons[i]; if (c == null) continue;
            bool ok = false;
            try { ok = task.ValidConsole(c); } catch { }
            if (ok) res.Add((c.transform.position, c.ConsoleId));
        }
        if (res.Count == 0)
            try { var l = task.FindConsolesPos(); for (int i = 0; l != null && i < l.Count; i++) res.Add((l[i], i)); } catch { }
        if (res.Count == 0) throw new BridgeError("no repair console found");
        return res;
    }

    static void StartFix(ActArgs a)
    {
        var me = Me;
        if (Game.AmImpostor(me)) throw new BridgeError("impostors cannot repair sabotage");
        if (me.Data.IsDead) throw new BridgeError("you are dead");
        if (me.inVent) throw new BridgeError("you are in a vent");
        string type = (a.Type ?? "").ToLowerInvariant();
        SabSystem(type);
        if (Game.Sabotage().type != type) throw new BridgeError("no active " + type + " sabotage");
        var cons = SabConsoles(me, type);
        var pos = me.GetTruePosition();
        cons.Sort((x, y) => Vector2.Distance(pos, x.pos).CompareTo(Vector2.Distance(pos, y.pos)));
        if (a.Id.HasValue)
        {
            var pick = cons.FindAll(c => c.id == a.Id.Value);
            if (pick.Count == 0) throw new BridgeError("no console with that id");
            cons = pick;
        }
        else if (type != "o2") cons = new List<(Vector2, int)> { cons[0] };
        _auto = false; Stop();
        _kind = "fix"; _fxType = type; _fxActive = true; _fxHolding = false; _fxPhase = 0; _fxQueue = cons; _fxOps = 0; _fxEndAt = 0;
        _fxCurId = cons[0].id; _goal = cons[0].pos; _hasGoal = true; Active = true;
        if (!Replan(pos)) { Stop(); throw new BridgeError("no path to the console"); }
    }

    static void ReleaseFix()
    {
        if (_fxActive && _fxHolding && _fxType == "reactor")
        {
            try { ShipStatus.Instance.RpcUpdateSystem(SystemTypes.Reactor, (byte)(ReactorSystemType.RemoveUserOp | (byte)_fxCurId)); } catch { }
        }
        _fxHolding = false; _fxActive = false;
    }

    static void FinishFix(bool ok)
    {
        Events.Add("fix_finished", "type", _fxType, "ok", ok);
        ReleaseFix();
        if (_ovr == "r_fix") { _fxRetryAt = Events.Now + 3f; EndOverride(); return; } // reflex: hand the body back
        _kind = "stay"; Desired = Vector2.zero; _path = null; _hasGoal = false;
    }

    static void UpdateFix(PlayerControl me, Vector2 pos, float now)
    {
        if (Game.Sabotage().type != _fxType) { FinishFix(true); return; }
        if (_fxPhase == 0)
        {
            int r = Drive(pos, now);
            if (r == 1) { _fxPhase = 1; _fxUntil = now + 2.0f + (float)Rnd.NextDouble(); _fxNextAt = 0; Desired = Vector2.zero; }
            else if (r == 2)
            {
                ReleaseFix();
                if (_ovr == "r_fix") { _fxRetryAt = now + 3f; Events.Add("stuck", "room", Game.RoomAt(pos)); EndOverride(); }
                else GiveUp();
            }
            return;
        }
        Desired = Vector2.zero;
        if (now < _fxUntil) return;
        var ship = ShipStatus.Instance;
        switch (_fxType)
        {
            case "lights":
                {
                    ISystemType s; SwitchSystem sw = null;
                    if (ship.Systems.TryGetValue(SystemTypes.Electrical, out s)) sw = s.TryCast<SwitchSystem>();
                    if (sw == null) { FinishFix(false); return; }
                    int diff = sw.ExpectedSwitches ^ sw.ActualSwitches;
                    if (diff == 0) { if (_fxEndAt == 0) _fxEndAt = now + 2f; else if (now > _fxEndAt) FinishFix(false); return; }
                    if (now < _fxNextAt) return;
                    for (int i = 0; i < SwitchSystem.NumSwitches; i++)
                        if ((diff & (1 << i)) != 0) { ship.RpcUpdateSystem(SystemTypes.Electrical, (byte)i); _fxNextAt = now + 0.4f; _fxOps++; break; }
                    if (_fxOps > 40) FinishFix(false);
                    return;
                }
            case "comms":
                {
                    if (_fxOps == 0 || now >= _fxNextAt)
                    {
                        // first try is the usual one; later tries vary the code in case this map expects another
                        byte code = _fxOps == 0 ? (byte)0 : _fxOps == 1 ? (byte)16 : (byte)17;
                        ship.RpcUpdateSystem(SystemTypes.Comms, code); _fxOps++; _fxNextAt = now + 1.5f;
                        Plugin.Logger.LogInfo("[AUB] fix comms code " + code);
                        if (_fxOps > 3) FinishFix(false);
                    }
                    return;
                }
            case "o2":
                {
                    if (_fxQueue.Count > 0)
                    {
                        var c = _fxQueue[0];
                        ship.RpcUpdateSystem(SystemTypes.LifeSupp, (byte)(LifeSuppSystemType.AddUserOp | (byte)c.id));
                        _fxQueue.RemoveAt(0); _fxOps++;
                        if (_fxQueue.Count > 0)
                        {
                            _fxCurId = _fxQueue[0].id; _goal = _fxQueue[0].pos; _hasGoal = true; _fxPhase = 0; Replan(pos);
                        }
                        else _fxEndAt = now + 3f;
                    }
                    else if (now > _fxEndAt) FinishFix(false);
                    return;
                }
            case "reactor":
                {
                    if (!_fxHolding)
                    {
                        ship.RpcUpdateSystem(SystemTypes.Reactor, (byte)(ReactorSystemType.AddUserOp | (byte)_fxCurId));
                        _fxHolding = true; _fxEndAt = now + 60f;
                        Plugin.Logger.LogInfo("[AUB] reactor: holding console " + _fxCurId);
                    }
                    else if (now > _fxEndAt) FinishFix(false);
                    return;
                }
        }
    }
}
