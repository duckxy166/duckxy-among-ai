using System;
using System.Collections.Generic;
using System.Text.Json;
using UnityEngine;

namespace AUBridge;

// Arguments of `act`, parsed on the socket thread (the JsonDocument dies when the handler returns).
public sealed class ActArgs
{
    public string Do, Room, Target, Type, Text;
    public Vector2? Pos;
    public float Distance = 1.5f;
    public long? Id;
    public bool Next;
    public float? Duration;
    public bool? On;
    public bool? Enter;
    public string To;

    static string S(JsonElement r, string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static ActArgs Parse(JsonElement r)
    {
        var a = new ActArgs { Do = S(r, "do"), Room = S(r, "room"), Target = S(r, "target"), Type = S(r, "type"), Text = S(r, "text") };
        if (string.IsNullOrEmpty(a.Do)) throw new BridgeError("missing 'do'");
        if (r.TryGetProperty("pos", out var p) && p.ValueKind != JsonValueKind.Null)
        {
            if (p.ValueKind != JsonValueKind.Array || p.GetArrayLength() != 2) throw new BridgeError("bad pos (expected [x,y])");
            var e0 = p[0]; var e1 = p[1];
            if (e0.ValueKind != JsonValueKind.Number || e1.ValueKind != JsonValueKind.Number || !e0.TryGetSingle(out var x) || !e1.TryGetSingle(out var y)
                || float.IsNaN(x) || float.IsNaN(y) || float.IsInfinity(x) || float.IsInfinity(y) || Math.Abs(x) > 200 || Math.Abs(y) > 200) throw new BridgeError("bad pos");
            a.Pos = new Vector2(x, y);
        }
        if (r.TryGetProperty("distance", out var d) && d.ValueKind != JsonValueKind.Null)
        {
            if (d.ValueKind != JsonValueKind.Number || !d.TryGetSingle(out var dv) || float.IsNaN(dv) || dv < 0.3f || dv > 10f) throw new BridgeError("bad distance (0.3..10)");
            a.Distance = dv;
        }
        if (r.TryGetProperty("id", out var i) && i.ValueKind != JsonValueKind.Null)
        {
            if (i.ValueKind != JsonValueKind.Number || !i.TryGetInt64(out var iv)) throw new BridgeError("bad id");
            a.Id = iv;
        }
        if (r.TryGetProperty("next", out var n) && n.ValueKind != JsonValueKind.Null)
        {
            if (n.ValueKind != JsonValueKind.True && n.ValueKind != JsonValueKind.False) throw new BridgeError("bad next (bool)");
            a.Next = n.GetBoolean();
        }
        if (r.TryGetProperty("durationSec", out var du) && du.ValueKind != JsonValueKind.Null)
        {
            if (du.ValueKind != JsonValueKind.Number || !du.TryGetSingle(out var dd) || float.IsNaN(dd) || dd < 0f || dd > 30f) throw new BridgeError("bad durationSec (0..30)");
            a.Duration = dd;
        }
        if (r.TryGetProperty("enter", out var en) && en.ValueKind != JsonValueKind.Null)
        {
            if (en.ValueKind != JsonValueKind.True && en.ValueKind != JsonValueKind.False) throw new BridgeError("bad enter (bool)");
            a.Enter = en.GetBoolean();
        }
        if (r.TryGetProperty("to", out var to) && to.ValueKind != JsonValueKind.Null)
        {
            if (to.ValueKind == JsonValueKind.String) a.To = to.GetString();
            else if (to.ValueKind == JsonValueKind.Number && to.TryGetInt32(out var tov)) a.To = tov.ToString();
            else throw new BridgeError("bad to (string or number)");
            if (a.To.Length > 20) throw new BridgeError("bad to");
        }
        if (r.TryGetProperty("on", out var o) && o.ValueKind != JsonValueKind.Null)
        {
            if (o.ValueKind != JsonValueKind.True && o.ValueKind != JsonValueKind.False) throw new BridgeError("bad on (bool)");
            a.On = o.GetBoolean();
        }
        return a;
    }
}

// The bot's "body": one current occupation (stay / move_to / follow / wander / do_task) + optional autopilot.
// Everything runs on the main thread. Movement is injected as joystick input (no teleport, no noclip).
public static partial class Body
{
    public static Vector2 Desired;
    public static int Applied; public static double LastVel;
    public static bool Active; // true while the bot (not the keyboard) drives the local player

    static string _kind;        // null | stay | move_to | follow | wander | do_task
    static bool _auto;
    static readonly System.Random Rnd = new();

    // path driving
    static List<Vector2> _path; static int _pi; static Vector2 _goal; static bool _hasGoal;
    static HashSet<int> _blocked = new(); static float _blockedAt;
    static Vector2 _stkPos; static float _stkAt; static int _stuckN; static float _planAt;
    static float _speedMag;

    // move_to
    static string _goalRoom;
    // follow
    static string _fTarget; static float _fDist; static Vector2 _fLast; static float _fSeenAt; static bool _fLost, _fHold;
    // wander
    static string _wRoom; static float _wNextAt;
    // task
    static PlayerTask _task; static int _tPhase; /*0 walk,1 wait*/ static float _tWaitUntil, _tDuration; static Vector2 _tConsole; static bool _tFake; static float? _tDurOverride; static int _tStepsDone;
    static readonly HashSet<uint> _faked = new();

    static PlayerControl Me => PlayerControl.LocalPlayer;

    // ---------------- match lifecycle ----------------
    public static void OnMatchStart()
    {
        _faked.Clear(); Stop();
        try { Nav.Build(false); } catch (Exception e) { Nav.Status = "build error: " + e.Message; Plugin.Logger.LogError("[AUB] nav build: " + e); }
    }
    public static void OnMatchReset() { Stop(); ClearOverride(); _reflexes = new List<ReflexDef>(); _auto = false; Nav.Ready = false; Active = false; Desired = Vector2.zero; }

    static void Stop() { ReleaseFix(); StopCore(); }
    static void StopCore()
    {
        _kind = null; _path = null; _hasGoal = false; _blocked.Clear(); _stuckN = 0; _task = null; _fLost = false;
        Desired = Vector2.zero; Active = false;
    }

    // ---------------- info for state ----------------
    public static string Busy()
    {
        switch (_kind)
        {
            case "move_to": return "moving";
            case "follow": return "following";
            case "wander": return "wandering";
            case "do_task": return _tPhase == 1 ? "task" : "moving_to_task";
            case "call_meeting": return "moving_to_button";
            case "r_fix": case "fix": return _fxPhase == 0 ? "moving_to_fix" : "fixing";
            case "r_report": return "reporting";
            case "r_flee": return "fleeing";
            case "r_group": return "grouping";
            case "r_avoid": return "avoiding";
            default: return "idle";
        }
    }

    public static object Info()
    {
        return new Dictionary<string, object>
        {
            ["action"] = _kind ?? "none", ["autopilot"] = _auto, ["nav"] = Nav.Ready, ["navStatus"] = Nav.Status,
            ["stuck"] = _stuckN, ["desired"] = new[] { Math.Round(Desired.x, 2), Math.Round(Desired.y, 2) }, ["applied"] = Applied, ["vel"] = LastVel, ["pathLeft"] = _path != null ? Math.Max(0, _path.Count - _pi) : 0,
            ["goal"] = _hasGoal ? new[] { Math.Round(_goal.x, 2), Math.Round(_goal.y, 2) } : null,
            ["task"] = _task != null ? (object)_task.Id : null,
        };
    }

    // ---------------- commands (main thread) ----------------
    static string RoomName(string want)
    {
        var ship = ShipStatus.Instance;
        var names = new List<string>();
        for (int i = 0; i < ship.AllRooms.Length; i++)
        {
            var r = ship.AllRooms[i];
            if (r == null || r.RoomId == SystemTypes.Hallway || r.roomArea == null) continue;
            var n = r.RoomId.ToString();
            if (!names.Contains(n)) names.Add(n);
        }
        foreach (var n in names) if (string.Equals(n, want, StringComparison.OrdinalIgnoreCase)) return n;
        throw new BridgeError("unknown room '" + want + "' (" + string.Join(",", names) + ")");
    }

    static void NeedGame()
    {
        if (!Game.ShipUp || !Game.Started) throw new BridgeError("not in a running game");
        if (!Nav.Ready) { try { Nav.Build(false); } catch (Exception e) { Nav.Status = "build error: " + e.Message; } }
        if (!Nav.Ready) throw new BridgeError("navigation not ready: " + Nav.Status);
    }

    public static object Act(ActArgs a)
    {
        var me = Me;
        switch (a.Do)
        {
            case "stay":
            case "idle":
                NeedGame(); _auto = false; Stop(); _kind = "stay"; Active = true; break;
            case "move_to":
                {
                    NeedGame();
                    Vector2 goal; string room = null;
                    if (a.Room != null) { room = RoomName(a.Room); if (!Nav.RoomGoal(room, out goal)) throw new BridgeError("room has no walkable floor: " + room); }
                    else if (a.Pos.HasValue) { goal = a.Pos.Value; if (Nav.Nearest(goal, 8) < 0) throw new BridgeError("pos is not reachable floor"); }
                    else throw new BridgeError("move_to needs room or pos");
                    _auto = false; Stop(); _kind = "move_to"; _goal = goal; _hasGoal = true; _goalRoom = room; Active = true;
                    if (!Replan(me.GetTruePosition())) { Stop(); throw new BridgeError("no path"); }
                    break;
                }
            case "follow":
                {
                    NeedGame();
                    if (string.IsNullOrEmpty(a.Target)) throw new BridgeError("follow needs target");
                    var pos = me.GetTruePosition();
                    Game.PInfo hit = null;
                    foreach (var v in Game.Visible(me, pos, Game.LightRadius(me))) if (string.Equals(v.Name, a.Target, StringComparison.OrdinalIgnoreCase)) { hit = v; break; }
                    if (hit == null) throw new BridgeError("target not visible");
                    _auto = false; Stop(); _kind = "follow"; _fTarget = hit.Name; _fDist = a.Distance; _fLast = hit.Pos; _fSeenAt = Events.Now; _fLost = false; _fHold = false; Active = true;
                    break;
                }
            case "wander":
                {
                    NeedGame();
                    string wr = null;
                    if (a.Room != null) wr = a.Room.Equals("here", StringComparison.OrdinalIgnoreCase) || a.Room.Equals("current", StringComparison.OrdinalIgnoreCase) ? "here" : RoomName(a.Room);
                    _auto = false; Stop(); _kind = "wander"; _wRoom = wr; _wNextAt = 0; Active = true;
                    break;
                }
            case "do_task":
                {
                    NeedGame();
                    var t = PickTask(me, a);
                    _auto = false; Stop(); StartTask(t, a.Duration); Active = true;
                    break;
                }
            case "call_meeting": NeedGame(); StartCallMeeting(); break;
            case "fix": NeedGame(); StartFix(a); break;
            case "kill": return Done(a, ActKill(a));
            case "report": return Done(a, ActReport(a));
            case "vote": return Done(a, ActVote(a));
            case "chat": return Done(a, ActChat(a));
            case "vent": return Done(a, ActVent(a));
            case "sabotage": return Done(a, ActSabotage(a));
            default:
                throw new BridgeError("unknown action: " + a.Do);
        }
        if (a.Do == "stay" || a.Do == "idle") _lastArgs = StayArgs; else _lastArgs = a;
        ClearOverride();
        Plugin.Logger.LogInfo("[AUB] act " + a.Do);
        return new Dictionary<string, object> { ["ok"] = true, ["accepted"] = a.Do };
    }

    public static object Autopilot(ActArgs a)
    {
        bool on = a.On ?? true;
        ClearOverride(); _lastArgs = null;
        if (on) { NeedGame(); if (_kind == null || _kind == "stay") { Stop(); } _auto = true; Active = true; }
        else { _auto = false; Stop(); }
        Plugin.Logger.LogInfo("[AUB] autopilot " + on);
        return new Dictionary<string, object> { ["ok"] = true, ["autopilot"] = on };
    }

    public static object NavCmd(JsonElement r)
    {
        if (r.TryGetProperty("mask", out var m) && m.ValueKind == JsonValueKind.String)
        {
            // strict: the mask name ends up in a cache file name (no path characters may get through)
            var s = m.GetString();
            bool num(string p) => s.Length > p.Length && s.Length <= p.Length + 10 && s.StartsWith(p, StringComparison.Ordinal) && int.TryParse(s.Substring(p.Length), System.Globalization.NumberStyles.None, null, out _);
            if (s != "ship" && s != "shipobj" && s != "shipall" && s != "phys" && s != "shadow" && !num("nt") && !num("bits")) throw new BridgeError("mask: ship|shipobj|shipall|shadow|phys|nt<N>|bits<N>");
            Nav.MaskName = s;
        }
        if (r.TryGetProperty("clearance", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetSingle(out var cv) && cv >= 0 && cv <= 0.4f) Nav.Clearance = cv;
        bool rebuild = r.TryGetProperty("rebuild", out var rb) && rb.ValueKind == JsonValueKind.True;
        if (rebuild) { if (!Game.ShipUp) throw new BridgeError("no ship"); Stop(); Nav.Build(true); }
        string dumped = null;
        if (r.TryGetProperty("dump", out var d) && d.ValueKind == JsonValueKind.True && Nav.Ready)
        {
            var marks = new List<Vector2>();
            var cons = ShipStatus.Instance.AllConsoles;
            for (int i = 0; i < cons.Length; i++) if (cons[i] != null) marks.Add(cons[i].transform.position);
            var txt = Nav.Dump(marks);
            dumped = System.IO.Path.Combine(Nav.CacheDir, $"dump_p{Plugin.Cfg.Id}.txt");
            System.IO.Directory.CreateDirectory(Nav.CacheDir);
            System.IO.File.WriteAllText(dumped, txt);
        }
        List<object> probe = null;
        if (r.TryGetProperty("probe", out var pr) && pr.ValueKind == JsonValueKind.Array && pr.GetArrayLength() == 2)
        {
            if (pr[0].ValueKind != JsonValueKind.Number || pr[1].ValueKind != JsonValueKind.Number) throw new BridgeError("bad probe");
            var pc = new Vector2(pr[0].GetSingle(), pr[1].GetSingle());
            float rad = r.TryGetProperty("r", out var rr) && rr.ValueKind == JsonValueKind.Number ? rr.GetSingle() : 0.3f;
            if (float.IsNaN(rad) || rad < 0.05f || rad > 1f) throw new BridgeError("bad r (0.05..1)");
            probe = new List<object>();
            var hits = Physics2D.OverlapCircleAll(pc, rad);
            for (int i = 0; i < hits.Length && i < 40; i++)
            {
                var h = hits[i]; if (h == null) continue;
                // static geometry only: a probe must never become a wall-hack for players or bodies
                if (h.GetComponentInParent<PlayerControl>() != null || h.GetComponentInParent<DeadBody>() != null) continue;
                var bd = h.bounds;
                probe.Add($"{h.gameObject.name} layer={h.gameObject.layer} trig={h.isTrigger} type={h.GetIl2CppType().Name} bounds=({bd.min.x:0.0},{bd.min.y:0.0})-({bd.max.x:0.0},{bd.max.y:0.0})");
            }
        }
        List<object> vl = null;
        if (r.TryGetProperty("vents", out var vv) && vv.ValueKind == JsonValueKind.True && Game.ShipUp)
        {
            vl = new List<object>();
            var av = ShipStatus.Instance.AllVents;
            for (int i = 0; av != null && i < av.Length; i++) if (av[i] != null) { Vector2 vp = av[i].transform.position; vl.Add(FormattableString.Invariant($"id={av[i].Id} pos=({vp.x:0.00},{vp.y:0.00}) room={Game.RoomAt(vp)}")); }
        }
        return new Dictionary<string, object> { ["ok"] = true, ["vents"] = vl, ["probe"] = probe, ["nav"] = Nav.Ready, ["status"] = Nav.Status, ["mask"] = Nav.MaskName, ["clearance"] = Nav.Clearance, ["dump"] = dumped };
    }

    // ---------------- tasks ----------------
    static PlayerTask PickTask(PlayerControl me, ActArgs a)
    {
        var tasks = me.myTasks;
        bool imp = Game.AmImpostor(me);
        PlayerTask best = null; float bd = 1e9f;
        var pos = me.GetTruePosition();
        for (int i = 0; i < tasks.Count; i++)
        {
            var t = tasks[i];
            if (t == null || Game.IsSabTask(t.TaskType) || t.TryCast<NormalPlayerTask>() == null) continue;
            if (a.Id.HasValue)
            {
                if (t.Id != (uint)a.Id.Value) continue;
                if (t.IsComplete) throw new BridgeError("task already done");
                return t;
            }
            if (t.IsComplete || (imp && _faked.Contains(t.Id))) continue;
            var tp = TaskPos(t, pos);
            float d = tp.HasValue ? Vector2.Distance(pos, tp.Value) : 1e8f;
            if (d < bd) { bd = d; best = t; }
        }
        if (a.Id.HasValue) throw new BridgeError("no such task id");
        if (best == null) throw new BridgeError("no tasks left");
        return best;
    }

    static Vector2? TaskPos(PlayerTask t, Vector2 from)
    {
        Vector2? best = null; float bd = 1e9f;
        void Try(Il2CppSystem.Collections.Generic.List<Vector2> l)
        {
            if (l == null) return;
            for (int i = 0; i < l.Count; i++) { float d = Vector2.Distance(from, l[i]); if (d < bd) { bd = d; best = l[i]; } }
        }
        try { Try(t.Locations); } catch { }
        if (!best.HasValue) { try { Try(t.FindConsolesPos()); } catch { } }
        return best;
    }

    static void StartTask(PlayerTask t, float? dur)
    {
        _kind = "do_task"; _task = t; _tPhase = 0; _tFake = Game.AmImpostor(Me); _tDurOverride = dur; _tStepsDone = 0;
        var tp = TaskPos(t, Me.GetTruePosition());
        if (!tp.HasValue) { Stop(); throw new BridgeError("task has no console position"); }
        _tConsole = tp.Value; _goal = tp.Value; _hasGoal = true;
        if (!Replan(Me.GetTruePosition())) { Stop(); throw new BridgeError("no path to task"); }
    }

    static float StepDuration(PlayerTask t)
    {
        if (_tDurOverride.HasValue) return _tDurOverride.Value;
        var n = t.TryCast<NormalPlayerTask>();
        float basis = 3f;
        if (n != null) basis = n.Length == NormalPlayerTask.TaskLength.Long ? 5f : n.Length == NormalPlayerTask.TaskLength.Common ? 4f : 3f;
        return basis + (float)Rnd.NextDouble() * 1.5f;
    }

    // ---------------- per-frame ----------------
    public static void Update(float now)
    {
        Desired = Vector2.zero;
        var me = Me;
        if (me != null && Game.ShipUp && Game.Started && Nav.Ready && !Game.InMeetingOrExile) { try { ReflexUpdate(me, now); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] reflex: " + e.Message); } }
        if (!Active && !_auto) return;
        if (me == null || !Game.ShipUp || !Game.Started || !Nav.Ready) { return; }
        if (Game.InMeetingOrExile)
        {
            if (_kind != null && _kind != "stay") { _kind = null; _path = null; _task = null; ReleaseFix(); } // a meeting cancels the occupation
            ClearOverride();
            return;
        }
        if (!me.CanMove) return;
        var pos = me.GetTruePosition();
        if (_ovr != null && (_kind == null || !_kind.StartsWith("r_"))) ClearOverride();
        if (now - _blockedAt > 8f && _blocked.Count > 0) _blocked.Clear();

        if (_kind == null && _auto) AutoPick(me, pos, now);
        if (_kind == null) { Active = _auto; return; }
        Active = true;

        switch (_kind)
        {
            case "stay": break;
            case "move_to":
                {
                    int r = Drive(pos, now);
                    if (r == 1) { Events.Add("arrived", "room", Game.RoomAt(pos), "pos", new[] { Math.Round(pos.x, 2), Math.Round(pos.y, 2) }); _kind = "stay"; Desired = Vector2.zero; }
                    else if (r == 2) GiveUp();
                    break;
                }
            case "follow": UpdateFollow(me, pos, now); break;
            case "wander": UpdateWander(pos, now); break;
            case "do_task": UpdateTask(me, pos, now); break;
            case "call_meeting": UpdateCallMeeting(me, pos, now); break;
            case "fix": UpdateFix(me, pos, now); break;
            case "r_report": case "r_flee": case "r_group": case "r_avoid": case "r_fix": OvrUpdate(me, pos, now); break;
        }
    }

    static void GiveUp()
    {
        Events.Add("stuck", "room", Game.RoomAt(Me.GetTruePosition()));
        Plugin.Logger.LogWarning("[AUB] stuck, action dropped: " + _kind);
        _kind = _auto ? null : "stay"; _path = null; _task = null; Desired = Vector2.zero; _stuckN = 0; _blocked.Clear();
    }

    // ---------------- autopilot ----------------
    static float _autoWaitUntil;
    static void AutoPick(PlayerControl me, Vector2 pos, float now)
    {
        if (now < _autoWaitUntil) return;
        try
        {
            var t = PickTask(me, new ActArgs { Do = "do_task" });
            StartTask(t, null);
            return;
        }
        catch (BridgeError) { }
        // nothing to do: roam between random rooms
        _kind = "wander"; _wRoom = null; _wNextAt = 0;
        _autoWaitUntil = now + 0.5f;
    }

    // ---------------- path driving ----------------
    static bool Replan(Vector2 pos)
    {
        var p = Nav.Path(pos, _goal, _blocked, out _);
        _planAt = Events.Now;
        if (p == null) { _path = null; return false; }
        _path = p; _pi = 0; _stkPos = pos; _stkAt = Events.Now;
        return true;
    }

    // 0 = moving, 1 = arrived, 2 = failed (stuck / no path)
    static int Drive(Vector2 pos, float now)
    {
        if (_path == null && !Replan(pos)) return 2;
        int n = _path.Count;
        while (_pi < n - 1 && (Vector2.Distance(pos, _path[_pi]) < 0.2f || Nav.Los(pos, _path[_pi + 1]))) _pi++;
        var wp = _path[_pi];
        float dist = Vector2.Distance(pos, wp);
        bool last = _pi >= n - 1;
        if (last && dist < 0.22f) { Desired = Vector2.zero; _stuckN = 0; return 1; }
        float mag = last ? Mathf.Clamp01(dist / 0.45f) : 1f;
        mag = Math.Max(mag, 0.25f);
        Desired = (wp - pos).normalized * mag;
        _speedMag = mag;

        // anti-stuck: no progress for 2 s while pushing
        if (now - _stkAt >= 2f)
        {
            float moved = Vector2.Distance(pos, _stkPos);
            _stkPos = pos; _stkAt = now;
            if (moved < 0.15f)
            {
                _stuckN++;
                if (_stuckN >= 3) return 2;
                // detour: forbid the cells right ahead and plan again
                int ahead = Nav.CellOf(pos + Desired.normalized * 0.4f);
                if (ahead >= 0) { _blocked.Add(ahead); _blockedAt = now; }
                int here = Nav.CellOf(pos);
                if (_stuckN == 2 && here >= 0) { _blocked.Add(here); }
                if (!Replan(pos)) return 2;
            }
            else if (moved > 0.6f) _stuckN = 0;
        }
        return 0;
    }

    // ---------------- follow ----------------
    static void UpdateFollow(PlayerControl me, Vector2 pos, float now)
    {
        Game.PInfo hit = null;
        foreach (var v in Game.Visible(me, pos, Game.LightRadius(me))) if (string.Equals(v.Name, _fTarget, StringComparison.OrdinalIgnoreCase)) { hit = v; break; }
        if (hit != null)
        {
            _fLast = hit.Pos; _fSeenAt = now; _fLost = false;
            float d = Vector2.Distance(pos, hit.Pos);
            bool los = Nav.Los(pos, hit.Pos);
            if (_fHold) { if (d > _fDist + 0.5f || !los) _fHold = false; }
            else if (d <= _fDist && los) _fHold = true;
            if (_fHold) { Desired = Vector2.zero; return; }
            if (los)
            {
                // clear straight line over walkable cells: steer at the target directly, no planning delay
                _path = null; _goal = hit.Pos; _hasGoal = true;
                float m = Mathf.Clamp01((d - _fDist) / 0.6f + 0.3f);
                Desired = (hit.Pos - pos).normalized * m;
                if (now - _stkAt >= 2f)
                {
                    if (Vector2.Distance(pos, _stkPos) < 0.15f && d > _fDist + 1f) { if (++_stuckN >= 3) GiveUp(); }
                    else _stuckN = 0;
                    _stkPos = pos; _stkAt = now;
                }
                return;
            }
            _goal = hit.Pos; _hasGoal = true;
            if (_path == null || now - _planAt > 0.25f) if (!Replan(pos)) { Desired = Vector2.zero; return; }
            int r = Drive(pos, now);
            if (r == 2) GiveUp();
            return;
        }
        if (!_fLost && now - _fSeenAt > 0.5f)
        {
            _fLost = true;
            Events.Add("lost_sight", "name", _fTarget);
            _goal = _fLast; _hasGoal = true; Replan(pos);
        }
        if (!_fLost) { Desired = Vector2.zero; return; } // flicker: wait in place
        int rr = Drive(pos, now);
        if (rr == 1) { Events.Add("arrived", "room", Game.RoomAt(pos), "reason", "last_seen"); _kind = "stay"; Desired = Vector2.zero; }
        else if (rr == 2) GiveUp();
    }

    // ---------------- wander ----------------
    static void UpdateWander(Vector2 pos, float now)
    {
        if (now < _wNextAt) { Desired = Vector2.zero; return; }
        if (_path == null)
        {
            string room = _wRoom;
            if (room == "here") room = Game.RoomAt(pos);
            if (room == null)
            {
                var ship = ShipStatus.Instance; var names = new List<string>();
                for (int i = 0; i < ship.AllRooms.Length; i++) { var r = ship.AllRooms[i]; if (r != null && r.RoomId != SystemTypes.Hallway && r.roomArea != null && !names.Contains(r.RoomId.ToString())) names.Add(r.RoomId.ToString()); }
                if (names.Count == 0) return;
                room = names[Rnd.Next(names.Count)];
            }
            if (!Nav.RandomInRoom(room, Rnd, out var g)) { _wNextAt = now + 1f; return; }
            _goal = g; _hasGoal = true;
            if (!Replan(pos)) { _wNextAt = now + 1f; return; }
        }
        int res = Drive(pos, now);
        if (res == 1) { _path = null; _wNextAt = now + 1f + (float)Rnd.NextDouble() * 2f; Desired = Vector2.zero; }
        else if (res == 2) { _path = null; _stuckN = 0; _blocked.Clear(); _wNextAt = now + 1f; Desired = Vector2.zero; }
    }

    // ---------------- do_task ----------------
    static void UpdateTask(PlayerControl me, Vector2 pos, float now)
    {
        var t = _task;
        if (t == null) { _kind = null; return; }
        if (!_tFake && t.IsComplete) { FinishTask(false); return; }
        if (_tPhase == 0)
        {
            int r = Drive(pos, now);
            if (r == 1)
            {
                _tPhase = 1; _tDuration = StepDuration(t); _tWaitUntil = now + _tDuration; Desired = Vector2.zero;
                string use = "?";
                try
                {
                    var cons = ShipStatus.Instance.AllConsoles;
                    for (int i = 0; i < cons.Length; i++)
                    {
                        var c = cons[i]; if (c == null || Vector2.Distance(c.transform.position, _tConsole) > 0.3f) continue;
                        float d = c.CanUse(me.Data, out var can, out var could);
                        use = $"console#{c.ConsoleId} dist={d:0.00} canUse={can} usable={c.UsableDistance:0.00}"; break;
                    }
                }
                catch (Exception e) { use = "check failed " + e.Message; }
                Plugin.Logger.LogInfo($"[AUB] task {t.Id} {t.TaskType} at console, wait {_tDuration:0.0}s, {use}");
            }
            else if (r == 2) GiveUp();
            return;
        }
        // phase 1: stand at the console
        Desired = Vector2.zero;
        if (now < _tWaitUntil) return;
        if (_tFake) { _faked.Add(t.Id); Events.Add("task_faked", "id", t.Id, "name", t.TaskType.ToString()); FinishTask(true); return; }
        var n = t.TryCast<NormalPlayerTask>();
        int before = n != null ? n.taskStep : 0;
        try { n.NextStep(); }
        catch (Exception e) { Plugin.Logger.LogWarning("[AUB] NextStep failed: " + e.Message); }
        _tStepsDone++;
        if (!t.IsComplete && n != null && n.taskStep == before)
        {
            Plugin.Logger.LogWarning("[AUB] NextStep changed nothing, using Complete()");
            try { t.Complete(); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] Complete failed: " + e.Message); }
            if (!t.IsComplete) try { me.RpcCompleteTask(t.Id); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] RpcCompleteTask failed: " + e.Message); }
        }
        if (t.IsComplete) { FinishTask(false); return; }
        // next step has a new console
        var tp = TaskPos(t, pos);
        if (!tp.HasValue || _tStepsDone > 8) { FinishTask(false); return; }
        _tConsole = tp.Value; _goal = tp.Value; _hasGoal = true; _tPhase = 0;
        if (!Replan(pos)) GiveUp();
    }

    static void FinishTask(bool fake)
    {
        _task = null; _path = null; _hasGoal = false;
        _kind = _auto ? null : "stay";
        Desired = Vector2.zero;
        _autoWaitUntil = Events.Now + 0.3f;
    }

    // ---------------- called from Harmony ----------------
    public static void ApplyVelocity(PlayerPhysics pp)
    {
        if (!Active) return;
        var me = Me;
        if (me == null || pp.myPlayer == null || pp.myPlayer.Pointer != me.Pointer) return;
        if (!me.CanMove) return;
        pp.body.velocity = Desired * pp.TrueSpeed;
        Applied++; LastVel = Math.Round(pp.TrueSpeed, 2);
    }
}
