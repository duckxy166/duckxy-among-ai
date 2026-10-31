using System;
using System.Collections.Generic;
using System.Text.Json;
using AmongUs.GameOptions;
using InnerNet;
using UnityEngine;

namespace AUBridge;

public class BridgeError : Exception { public BridgeError(string m) : base(m) { } }

// In-match logic: honest state (only what the local player can see), event generation, host commands.
// Everything here runs on the main thread (Runner.Update / Harmony postfixes / Runner.Invoke).
public static class Game
{
    static AmongUsClient Client => AmongUsClient.Instance;
    internal static PlayerControl Me => PlayerControl.LocalPlayer;
    internal static bool ShipUp => Client != null && Client.GameState == InnerNetClient.GameStates.Started
                          && ShipStatus.Instance != null && Me != null && Me.Data != null;

    static double R(float v) => Math.Round(v, 2);
    static double[] P(Vector2 v) => new[] { R(v.x), R(v.y) };

    // ---------------- match flags ----------------
    static bool _started, _ended;
    internal static bool Started => _started && !_ended;
    internal static bool InMeetingOrExile => MeetingHud.Instance != null || ExileController.Instance != null;
    static int _round;
    static string _label; // set by the orchestrator before the match, used once
    static float _shipSeenAt, _next, _nextTick1s, _closeLogAt;
    static string _gameId = "";
    static string _warnLast; static float _warnAt;

    // honest visibility
    internal sealed class PInfo { public byte Id; public string Name; public int Color; public Vector2 Pos; public string Room; public bool Alive; public float Dist; public bool InVent; }
    static readonly HashSet<byte> _stable = new();
    static readonly Dictionary<byte, float> _lastRaw = new();
    static readonly Dictionary<byte, PInfo> _lastInfo = new();
    static readonly HashSet<byte> _seenBodies = new();

    // diff state
    static readonly Dictionary<uint, bool> _taskDone = new();
    static bool _allDoneSent, _wasDead, _deathSent;
    static string _room, _roomCand, _sabType;
    static float _roomCandAt;

    // meeting
    static bool _inMeeting, _votingAnnounced, _pend; static string _pendCaller, _pendBody; static float _resultsAt, _proceedAt;
    static float _noMeetingSince;
    static readonly HashSet<byte> _voted = new();
    static readonly List<Dictionary<string, object>> _chat = new();
    static string _meetCaller, _meetBody, _exiledName; static bool _exiledImp, _tie, _exiledSet, _exiledMe;
    static object _results;

    static void Warn(string m)
    {
        if (m == _warnLast && Events.Now - _warnAt < 10f) return;
        _warnLast = m; _warnAt = Events.Now; Plugin.Logger.LogWarning("[AUB] " + m);
    }

    // ---------------- geometry / visibility ----------------
    internal static string RoomAt(Vector2 p)
    {
        var ship = ShipStatus.Instance;
        var rooms = ship != null ? ship.AllRooms : null;
        if (rooms == null) return null;
        for (int i = 0; i < rooms.Length; i++)
        {
            var r = rooms[i];
            if (r != null && r.roomArea != null && r.roomArea.OverlapPoint(p))
                return r.RoomId == SystemTypes.Hallway ? null : r.RoomId.ToString();
        }
        return null;
    }

    internal static float LightRadius(PlayerControl me)
    {
        try { return ShipStatus.Instance.CalculateLightRadius(me.Data); } catch { return 3f; }
    }

    // What the light would show: inside radius and no wall between.
    static bool Lit(Vector2 a, float radius, Vector2 b) =>
        Vector2.Distance(a, b) <= radius && !PhysicsHelpers.AnythingBetween(a, b, Constants.ShadowMask, false);

    // A ghost has no shadows and no light limit, but still only sees its own screen (16:9, orthographic size 3),
    // not the whole map: otherwise a dead agent would watch every kill and vent on the ship.
    const float GhostHalfW = 5.4f, GhostHalfH = 3.1f;
    static bool OnScreen(Vector2 a, Vector2 b) => Mathf.Abs(b.x - a.x) <= GhostHalfW && Mathf.Abs(b.y - a.y) <= GhostHalfH;
    internal static bool Sees(PlayerControl me, Vector2 a, float radius, Vector2 b) => me.Data.IsDead ? OnScreen(a, b) : Lit(a, radius, b);

    static PInfo Mk(PlayerControl p, Vector2 a)
    {
        var pos = p.GetTruePosition();
        return new PInfo
        {
            Id = p.PlayerId, Name = p.Data.PlayerName, Pos = pos, Room = RoomAt(pos), Alive = !p.Data.IsDead,
            Color = p.Data.DefaultOutfit != null ? p.Data.DefaultOutfit.ColorId : -1,
            Dist = Vector2.Distance(a, pos), InVent = p.inVent,
        };
    }

    internal static List<PInfo> Visible(PlayerControl me, Vector2 a, float radius)
    {
        var res = new List<PInfo>();
        bool ghost = me.Data.IsDead;
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++)
        {
            var p = all[i];
            if (p == null || p.Data == null || p.PlayerId == me.PlayerId || p.Data.Disconnected || p.inVent) continue;
            if (p.Data.IsDead && !ghost) continue; // corpses are DeadBody objects
            var info = Mk(p, a);
            if (ghost ? OnScreen(a, info.Pos) : Lit(a, radius, info.Pos)) res.Add(info);
        }
        return res;
    }

    internal sealed class BInfo { public byte Id; public string Name; public int Color; public Vector2 Pos; public string Room; public float Dist; }
    internal static List<BInfo> Bodies(PlayerControl me, Vector2 a, float radius)
    {
        var res = new List<BInfo>();
        bool anyDead = false;
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++) if (all[i] != null && all[i].Data != null && all[i].Data.IsDead) { anyDead = true; break; }
        if (!anyDead) return res;
        bool ghost = me.Data.IsDead;
        foreach (var b in UnityEngine.Object.FindObjectsOfType<DeadBody>())
        {
            if (b == null || b.Reported) continue;
            var pos = b.TruePosition;
            if (ghost ? !OnScreen(a, pos) : !Lit(a, radius, pos)) continue;
            var d = GameData.Instance.GetPlayerById(b.ParentId);
            res.Add(new BInfo
            {
                Id = b.ParentId, Name = d != null ? d.PlayerName : "?", Pos = pos, Room = RoomAt(pos), Dist = Vector2.Distance(a, pos),
                Color = d != null && d.DefaultOutfit != null ? d.DefaultOutfit.ColorId : -1,
            });
        }
        return res;
    }

    // ---------------- role / tasks / sabotage ----------------
    static string RoleName(NetworkedPlayerInfo d)
    {
        switch (d.RoleType)
        {
            case RoleTypes.Crewmate: return "crewmate";
            case RoleTypes.Impostor: return "impostor";
            case RoleTypes.CrewmateGhost: return "ghost_crew";
            case RoleTypes.ImpostorGhost: return "ghost_imp";
            default: return d.RoleType.ToString().ToLowerInvariant();
        }
    }
    internal static bool AmImpostor(PlayerControl me) => me.Data.Role != null && me.Data.Role.IsImpostor;

    // Partners are only ever looked up when the local player is an impostor (the game shows teammates to impostors anyway).
    // Every other impostor: one in a 2-impostor game, two in a 3-impostor game.
    internal static List<string> Partners(PlayerControl me)
    {
        var res = new List<string>();
        if (!AmImpostor(me)) return res;
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++)
        {
            var p = all[i];
            if (p == null || p.Data == null || p.PlayerId == me.PlayerId || p.Data.Disconnected) continue;
            if (p.Data.Role != null && p.Data.Role.IsImpostor) res.Add(p.Data.PlayerName);
        }
        return res;
    }

    // The first partner, kept as `partner` for readers that know only one.
    internal static string Partner(PlayerControl me) { var ps = Partners(me); return ps.Count > 0 ? ps[0] : null; }

    internal static bool IsPartner(PlayerControl me, string name)
    {
        foreach (var n in Partners(me)) if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    internal static bool IsSabTask(TaskTypes t) =>
        t == TaskTypes.ResetReactor || t == TaskTypes.FixLights || t == TaskTypes.FixComms || t == TaskTypes.RestoreOxy ||
        t == TaskTypes.ResetSeismic || t == TaskTypes.MushroomMixupSabotage || t == TaskTypes.None;

    static List<Dictionary<string, object>> Tasks(PlayerControl me)
    {
        var res = new List<Dictionary<string, object>>();
        var tasks = me.myTasks;
        if (tasks == null) return res;
        bool fake = AmImpostor(me);
        for (int i = 0; i < tasks.Count; i++)
        {
            var t = tasks[i];
            if (t == null || IsSabTask(t.TaskType)) continue;
            var n = t.TryCast<NormalPlayerTask>();
            if (n == null) continue;
            Vector2? pos = null;
            try
            {
                if (t.Locations != null && t.Locations.Count > 0) pos = t.Locations[0];
                else { var lp = t.FindConsolesPos(); if (lp != null && lp.Count > 0) pos = lp[0]; }
            }
            catch (Exception) { }
            string room = pos.HasValue ? RoomAt(pos.Value) : null;
            if (room == null && t.StartAt != SystemTypes.Hallway) room = t.StartAt.ToString();
            var d = new Dictionary<string, object>
            {
                ["id"] = t.Id, ["name"] = t.TaskType.ToString(), ["room"] = room, ["done"] = t.IsComplete,
                ["pos"] = pos.HasValue ? P(pos.Value) : null, ["step"] = n.taskStep, ["steps"] = n.MaxStep,
            };
            if (fake) d["fake"] = true;
            res.Add(d);
        }
        return res;
    }

    internal static (string type, double timer) Sabotage()
    {
        var sys = ShipStatus.Instance.Systems;
        ISystemType s;
        if (sys.TryGetValue(SystemTypes.Reactor, out s)) { var r = s.TryCast<ReactorSystemType>(); if (r != null && r.IsActive) return ("reactor", R(r.Countdown)); }
        if (sys.TryGetValue(SystemTypes.Laboratory, out s)) { var r = s.TryCast<ReactorSystemType>(); if (r != null && r.IsActive) return ("reactor", R(r.Countdown)); }
        if (sys.TryGetValue(SystemTypes.LifeSupp, out s)) { var o = s.TryCast<LifeSuppSystemType>(); if (o != null && o.IsActive) return ("o2", R(o.Countdown)); }
        if (sys.TryGetValue(SystemTypes.Electrical, out s)) { var l = s.TryCast<SwitchSystem>(); if (l != null && l.IsActive) return ("lights", 0); }
        if (sys.TryGetValue(SystemTypes.Comms, out s)) { var c = s.TryCast<HudOverrideSystemType>(); if (c != null && c.IsActive) return ("comms", 0); }
        return (null, 0);
    }

    static double SabotageCooldown()
    {
        try { ISystemType s; if (ShipStatus.Instance.Systems.TryGetValue(SystemTypes.Sabotage, out s)) { var x = s.TryCast<SabotageSystemType>(); if (x != null) return R(x.Timer); } } catch { }
        return 0;
    }

    static string PhaseName()
    {
        if (_ended) return "ended";
        var m = MeetingHud.Instance;
        if (m != null)
        {
            switch (m.state)
            {
                case MeetingHud.MeetingStates.Animating:
                case MeetingHud.MeetingStates.Discussion: return "meeting";
                case MeetingHud.MeetingStates.NotVoted:
                case MeetingHud.MeetingStates.Voted: return "voting";
                default: return "voting_result";
            }
        }
        if (ExileController.Instance != null) return "voting_result";
        return "tasks";
    }

    internal static string NameOf(byte id)
    {
        var d = GameData.Instance != null ? GameData.Instance.GetPlayerById(id) : null;
        return d != null ? d.PlayerName : null;
    }

    static int OptInt(Int32OptionNames n)
    {
        try { return GameManager.Instance.LogicOptions.currentGameOptions.GetInt(n); } catch { return 0; }
    }

    // Voted or skipped. When time runs out the game marks everyone left as voted too, with MissedVote.
    static bool Voted(PlayerVoteArea s) => s.DidVote && s.VotedForId != PlayerVoteArea.MissedVote;

    static Dictionary<string, object> MeetingState()
    {
        var m = MeetingHud.Instance;
        if (m == null) return null;
        var voted = new List<string>();
        var players = new List<object>();
        var ps = m.playerStates;
        if (ps != null)
            for (int i = 0; i < ps.Length; i++)
            {
                var s = ps[i];
                if (s == null) continue;
                var nm = NameOf(s.PlayerId);
                if (nm == null) continue;
                bool dead = s.AmDead;
                if (!dead && Voted(s)) voted.Add(nm);
                players.Add(new Dictionary<string, object> { ["name"] = nm, ["alive"] = !dead });
            }
        double left = 0;
        try
        {
            int disc = OptInt(Int32OptionNames.DiscussionTime), vote = OptInt(Int32OptionNames.VotingTime);
            bool voting = m.state == MeetingHud.MeetingStates.NotVoted || m.state == MeetingHud.MeetingStates.Voted;
            left = Math.Max(0, (voting || m.state >= MeetingHud.MeetingStates.Results ? disc + vote : disc) - m.discussionTimer);
            if (m.state >= MeetingHud.MeetingStates.Results) left = 0;
        }
        catch { }
        return new Dictionary<string, object>
        {
            ["caller"] = _meetCaller ?? NameOf(m.reporterId), ["reportedBody"] = _meetBody,
            ["voted"] = voted, ["votes"] = _results, ["players"] = players,
            ["chat"] = new List<Dictionary<string, object>>(_chat), ["timeLeft"] = R((float)left),
        };
    }

    // ---------------- state for the `state` command ----------------
    public static object GameState()
    {
        var c = Client;
        if (c == null) return null;
        if (!ShipUp) return _ended ? new Dictionary<string, object> { ["phase"] = "ended", ["gameId"] = _gameId } : null;
        var me = Me; var d = me.Data;
        // Roles/tasks arrive a moment after the ship appears; until game_started the role would be a misleading default.
        if (!_started) return new Dictionary<string, object> { ["phase"] = "intro", ["gameId"] = _gameId, ["intro"] = true, ["canMove"] = false };
        var a = me.GetTruePosition();
        float radius = LightRadius(me);
        float lightView = -1; try { lightView = me.lightSource.ViewDistance; } catch { }
        var vis = new List<object>();
        foreach (var v in Visible(me, a, radius))
            vis.Add(new Dictionary<string, object> { ["name"] = v.Name, ["color"] = v.Color, ["pos"] = P(v.Pos), ["room"] = v.Room, ["alive"] = v.Alive, ["distance"] = R(v.Dist), ["inVent"] = v.InVent });
        var bodies = new List<object>();
        foreach (var b in Bodies(me, a, radius))
            bodies.Add(new Dictionary<string, object> { ["name"] = b.Name, ["color"] = b.Color, ["pos"] = P(b.Pos), ["room"] = b.Room, ["distance"] = R(b.Dist) });

        bool imp = AmImpostor(me);
        double? taskBar = null;
        try
        {
            var mode = GameManager.Instance.LogicOptions.GetTaskBarMode();
            bool show = mode == TaskBarMode.Normal || (mode == TaskBarMode.MeetingOnly && MeetingHud.Instance != null);
            var gd = GameData.Instance;
            if (show && gd != null && gd.TotalTasks > 0 && Sabotage().type != "comms") taskBar = R((float)gd.CompletedTasks / gd.TotalTasks);
        }
        catch { }
        var sab = Sabotage();
        bool intro = false; try { intro = HudManager.Instance != null && HudManager.Instance.IsIntroDisplayed; } catch { }

        return new Dictionary<string, object>
        {
            ["phase"] = PhaseName(), ["gameId"] = _gameId, ["intro"] = intro, ["canMove"] = me.CanMove,
            ["lightRadius"] = R(radius), ["lightView"] = R(lightView),
            ["me"] = new Dictionary<string, object>
            {
                ["name"] = d.PlayerName, ["color"] = d.DefaultOutfit != null ? d.DefaultOutfit.ColorId : -1, ["alive"] = !d.IsDead,
                ["role"] = RoleName(d), ["pos"] = P(a), ["room"] = RoomAt(a),
                ["killCooldown"] = imp ? R(Math.Max(0, me.killTimer)) : 0.0, ["killRange"] = imp ? R(Body.KillRange()) : 0.0,
                ["canVent"] = d.Role != null && d.Role.CanVent, ["inVent"] = me.inVent, ["partner"] = Partner(me), ["partners"] = Partners(me),
            },
            ["tasks"] = Tasks(me), ["taskBar"] = taskBar, ["visible"] = vis, ["bodies"] = bodies,
            ["sabotage"] = new Dictionary<string, object> { ["active"] = sab.type, ["timer"] = sab.timer, ["cooldown"] = imp ? SabotageCooldown() : 0.0 },
            ["meeting"] = MeetingState(), ["busy"] = Body.Busy(), ["body"] = Body.Info(), ["reflexes"] = Body.ReflexInfo(), ["vents"] = Body.VentsForState(me, a, radius),
        };
    }

    // ---------------- observer (≈10 Hz) ----------------
    public static void Update(float now)
    {
        if (now < _next) return;
        _next = now + 0.1f;
        if (_closeLogAt > 0 && now > _closeLogAt) { _closeLogAt = 0; GameLog.Close(); }
        try { Observe(now); }
        catch (Exception e) { Warn("observe: " + e.Message); }
    }

    static void ResetMatch()
    {
        _pend = false; _started = false; _ended = false; _inMeeting = false; _votingAnnounced = false; _allDoneSent = false; _wasDead = false; _deathSent = false;
        Body.OnMatchReset();
        _stable.Clear(); _lastRaw.Clear(); _lastInfo.Clear(); _seenBodies.Clear(); _taskDone.Clear(); _voted.Clear(); _chat.Clear();
        _room = _roomCand = _sabType = null; _shipSeenAt = 0; _exiledSet = false; _results = null; _meetCaller = _meetBody = null;
    }

    static void Observe(float now)
    {
        var c = Client;
        if (c == null) return;
        if (c.GameState != InnerNetClient.GameStates.Started)
        {
            if (c.GameState == InnerNetClient.GameStates.Joined || c.GameState == InnerNetClient.GameStates.NotJoined)
                if (_started || _ended) ResetMatch();
            return;
        }
        if (!ShipUp) { _shipSeenAt = 0; return; }
        var me = Me;
        if (_ended) return;
        if (_shipSeenAt == 0) _shipSeenAt = now;

        if (!_started)
        {
            bool ready = me.roleAssigned && me.myTasks != null && me.myTasks.Count > 0;
            if (!ready && now - _shipSeenAt < 8f) return;
            StartMatch(me, now);
        }

        var a = me.GetTruePosition();
        float radius = LightRadius(me);
        bool meeting = MeetingHud.Instance != null;
        ObserveMeeting(me, now);

        if (!meeting)
        {
            // sightings with 0.5 s hysteresis on loss
            var raw = new HashSet<byte>();
            foreach (var v in Visible(me, a, radius))
            {
                raw.Add(v.Id); _lastRaw[v.Id] = now; _lastInfo[v.Id] = v;
                if (_stable.Add(v.Id)) Events.Add("saw_player", "name", v.Name, "room", v.Room);
            }
            foreach (var id in new List<byte>(_stable))
                if (!raw.Contains(id) && now - _lastRaw[id] >= 0.5f)
                {
                    _stable.Remove(id);
                    var li = _lastInfo[id];
                    Events.Add("lost_player", "name", li.Name, "room", li.Room);
                }
            foreach (var b in Bodies(me, a, radius))
                if (_seenBodies.Add(b.Id)) Events.Add("saw_body", "name", b.Name, "room", b.Room);

            // room_changed (0.3 s debounce against corridor flicker)
            var room = RoomAt(a);
            if (room != _roomCand) { _roomCand = room; _roomCandAt = now; }
            else if (room != _room && now - _roomCandAt >= 0.3f) { _room = room; Events.Add("room_changed", "room", room); }
        }

        // tasks
        var tl = me.myTasks;
        if (tl != null)
        {
            bool all = true; int count = 0;
            for (int i = 0; i < tl.Count; i++)
            {
                var t = tl[i];
                if (t == null || IsSabTask(t.TaskType) || t.TryCast<NormalPlayerTask>() == null) continue;
                count++;
                bool done = t.IsComplete;
                if (!done) all = false;
                bool was;
                if (_taskDone.TryGetValue(t.Id, out was) && !was && done) Events.Add("task_done", "id", t.Id, "name", t.TaskType.ToString());
                _taskDone[t.Id] = done;
            }
            if (count > 0 && all && !_allDoneSent && !AmImpostor(me)) { _allDoneSent = true; Events.Add("tasks_all_done"); }
        }

        // sabotage
        var sab = Sabotage();
        if (sab.type != _sabType)
        {
            if (_sabType != null) Events.Add("sabotage_fixed", "type", _sabType);
            if (sab.type != null) Events.Add("sabotage", "type", sab.type);
            _sabType = sab.type;
        }

        // death not caused by a visible murder (ejected etc.)
        bool dead = me.Data.IsDead;
        if (dead && !_wasDead && !_deathSent) Events.Add("you_died", "cause", _exiledMe ? "ejected" : "unknown");
        _wasDead = dead;

        if (now >= _nextTick1s) { _nextTick1s = now + 1f; LogTick(me, a, radius); }
    }

    static void StartMatch(PlayerControl me, float now)
    {
        _started = true; _round++; Body.ResetVictims();
        Events.T0 = now;
        // Name from the orchestrator (label cmd, e.g. 20261008-g7) so every seat writes into the folder the chronicler reads.
        // Without a label: start time, so a restarted stand never overwrites an earlier match (r1 used to repeat).
        _gameId = _label ?? $"{DateTime.Now:yyyyMMdd-HHmm}-r{_round}";
        _label = null;
        GameLog.Open(_gameId);
        _wasDead = me.Data.IsDead; _deathSent = false; _exiledMe = false;
        var tasks = Tasks(me);
        foreach (var t in tasks) _taskDone[(uint)t["id"]] = false;
        Body.OnMatchStart();
        Events.Add("game_started", "gameId", _gameId, "role", RoleName(me.Data), "partner", Partner(me), "partners", Partners(me), "tasks", tasks);
    }

    static void LogTick(PlayerControl me, Vector2 a, float radius)
    {
        var names = new List<string>();
        foreach (var v in Visible(me, a, radius)) names.Add(v.Name);
        GameLog.Write(new Dictionary<string, object> { ["type"] = "tick", ["t"] = Events.T, ["pos"] = P(a), ["room"] = RoomAt(a), ["alive"] = !me.Data.IsDead, ["visible"] = names, ["phase"] = PhaseName() });
        if (Plugin.Cfg.Mode != "host") return;
        var ps = new List<object>();
        var all = PlayerControl.AllPlayerControls;
        for (int i = 0; i < all.Count; i++)
        {
            var p = all[i];
            if (p == null || p.Data == null) continue;
            var pos = p.GetTruePosition();
            ps.Add(new Dictionary<string, object> { ["name"] = p.Data.PlayerName, ["pos"] = P(pos), ["room"] = RoomAt(pos), ["alive"] = !p.Data.IsDead, ["imp"] = p.Data.Role != null && p.Data.Role.IsImpostor, ["inVent"] = p.inVent });
        }
        GameLog.God(new Dictionary<string, object> { ["type"] = "god", ["t"] = Events.T, ["players"] = ps });
    }

    static void ObserveMeeting(PlayerControl me, float now)
    {
        var m = MeetingHud.Instance;
        if (m != null)
        {
            _noMeetingSince = 0;
            if (!_inMeeting)
            {
                string rb = null;
                BeginMeeting(_pend ? _pendCaller : NameOf(m.reporterId), _pend ? _pendBody : rb);
                _pend = false; _resultsAt = 0; _proceedAt = 0;
            }
            // The results screen waits for the host's "Proceed" button; with nobody at the keyboard the mod presses it.
            if (m.state >= MeetingHud.MeetingStates.Results)
            {
                if (_resultsAt == 0) _resultsAt = now;
                if (now - _resultsAt > 4f && now - _proceedAt > 3f && Client != null && Client.AmHost)
                {
                    _proceedAt = now;
                    try { m.HandleProceed(); Plugin.Logger.LogInfo("[AUB] host: HandleProceed"); } catch (Exception e) { Warn("HandleProceed: " + e.Message); }
                }
            }
            else _resultsAt = 0;
            if (m.state >= MeetingHud.MeetingStates.NotVoted && !_votingAnnounced) { _votingAnnounced = true; Events.Add("voting_started"); }
            if (m.state < MeetingHud.MeetingStates.Results && m.playerStates != null)
                for (int i = 0; i < m.playerStates.Length; i++)
                {
                    var s = m.playerStates[i];
                    if (s == null || s.AmDead || !Voted(s)) continue;
                    if (_voted.Add(s.PlayerId)) Events.Add("vote_cast", "from", NameOf(s.PlayerId));
                }
            return;
        }
        if (!_inMeeting) return;
        if (ExileController.Instance != null) { _noMeetingSince = 0; return; }
        if (_noMeetingSince == 0) { _noMeetingSince = now; return; }
        if (now - _noMeetingSince < 0.5f) return;
        EmitMeetingEnded();
        _stable.Clear(); _lastRaw.Clear(); _roomCand = _room = null; // everyone moved; sightings restart
    }

    static void EmitMeetingEnded()
    {
        _inMeeting = false;
        var ev = new List<object> { "ejected", _exiledSet && !_tie ? _exiledName : null, "tie", _tie };
        if (_exiledSet && !_tie && GetConfirm()) { ev.Add("wasImpostor"); ev.Add(_exiledImp); }
        Events.Add("meeting_ended", ev.ToArray());
    }

    // Votes are secret until the results; this fires when the game itself processes a vote on this client (if it does).
    public static void OnVoteCast(byte src)
    {
        if (!_inMeeting || !_voted.Add(src)) return;
        var nm = NameOf(src);
        if (nm != null) Events.Add("vote_cast", "from", nm);
    }

    static bool GetConfirm() { try { return GameManager.Instance.LogicOptions.GetConfirmImpostor(); } catch { return false; } }

    static void BeginMeeting(string caller, string body)
    {
        _inMeeting = true; _votingAnnounced = false; _voted.Clear(); _chat.Clear(); _results = null; _exiledSet = false; _tie = false;
        _meetCaller = caller; _meetBody = body; Body.ResetVote();
        _stable.Clear(); _lastRaw.Clear(); _seenBodies.Clear();
        Events.Add("meeting_started", "caller", caller, "body", body);
    }

    // ---------------- hooks called from Harmony postfixes ----------------
    public static void OnStartMeeting(PlayerControl caller, NetworkedPlayerInfo target)
    {
        // The meeting UI appears a few seconds later; the event is sent when it does, so chat/vote work right after it.
        if (!_started || _inMeeting) return;
        _pend = true; _pendCaller = caller != null && caller.Data != null ? caller.Data.PlayerName : null; _pendBody = target != null ? target.PlayerName : null;
    }

    public static void OnVotingComplete(IEnumerable<MeetingHud.VoterState> states, NetworkedPlayerInfo exiled, bool tie)
    {
        _tie = tie; _exiledSet = true;
        _exiledName = exiled != null ? exiled.PlayerName : null;
        _exiledImp = exiled != null && exiled.Role != null && exiled.Role.IsImpostor;
        _exiledMe = exiled != null && Me != null && exiled.PlayerId == Me.PlayerId;
        // With anonymous votes the game shows only how many votes each one got, never who cast them.
        bool anon = false;
        try { anon = GameOptionsManager.Instance.CurrentGameOptions.GetBool(AmongUs.GameOptions.BoolOptionNames.AnonymousVotes); } catch { anon = true; }
        var res = new Dictionary<string, string>();
        var counts = new Dictionary<string, int>();
        if (states != null)
            foreach (var s in states)
            {
                var from = NameOf(s.VoterId);
                if (from == null || s.VotedForId == PlayerVoteArea.MissedVote) continue; // time ran out: no vote
                var to = s.VotedForId == PlayerVoteArea.SkippedVote ? "skip" : (NameOf(s.VotedForId) ?? "skip");
                res[from] = to;
                counts[to] = counts.TryGetValue(to, out var k) ? k + 1 : 1;
            }
        _results = anon ? new Dictionary<string, object> { ["anonymous"] = true, ["counts"] = counts } : res;
    }

    public static void OnChat(PlayerControl src, string text)
    {
        if (src == null || src.Data == null || text == null) return;
        var me = Me;
        if (me == null || me.Data == null) return;
        if (src.Data.IsDead && !me.Data.IsDead) return; // ghost chat is invisible to the living
        if (text.Length > 200) text = text.Substring(0, 200);
        var e = new Dictionary<string, object> { ["from"] = src.Data.PlayerName, ["text"] = text };
        if (_inMeeting) _chat.Add(e);
        Events.Add("chat", "from", src.Data.PlayerName, "text", text);
    }

    public static void OnMurder(PlayerControl killer, PlayerControl victim)
    {
        if (!_started || killer == null || victim == null || victim.Data == null || killer.Data == null) return;
        var me = Me; if (me == null) return;
        var vpos = victim.GetTruePosition(); var kpos = killer.GetTruePosition();
        if (victim.PlayerId == me.PlayerId)
        {
            // victim's own view: the killer is "seen" if lit from where the body fell
            bool seen = Lit(vpos, LightRadius(me), kpos);
            _deathSent = true; _wasDead = true;
            Events.Add("you_died", "cause", "killed", "killer", seen ? killer.Data.PlayerName : null);
            return;
        }
        if (killer.PlayerId == me.PlayerId)
        {
            Events.Add("kill_done", "victim", victim.Data.PlayerName, "room", RoomAt(vpos));
            Body.OnKilled(victim);
            return;
        }
        var a = me.GetTruePosition(); float r = LightRadius(me);
        bool visible = Sees(me, a, r, vpos) || Sees(me, a, r, kpos);
        if (visible)
        {
            Events.Add("saw_kill", "killer", killer.Data.PlayerName, "victim", victim.Data.PlayerName, "room", RoomAt(vpos));
            Body.OnSawKill(killer.Data.PlayerName, victim.Data.PlayerName);
        }
    }

    public static void OnVent(PlayerControl pc, Vent vent, bool enter)
    {
        if (!_started || pc == null || pc.Data == null || Me == null || pc.PlayerId == Me.PlayerId) return;
        var a = Me.GetTruePosition();
        if (Sees(Me, a, LightRadius(Me), pc.GetTruePosition()))
            Events.Add("saw_vent", "name", pc.Data.PlayerName, "vent", vent != null ? vent.Id : -1, "action", enter ? "enter" : "exit");
    }

    public static void OnGameEnd(GameOverReason reason)
    {
        if (_ended) return;
        string winner;
        switch (reason)
        {
            case GameOverReason.CrewmatesByVote: case GameOverReason.CrewmatesByTask: case GameOverReason.CrewmateDisconnect: winner = "crew"; break;
            case GameOverReason.ImpostorsByVote: case GameOverReason.ImpostorsByKill: case GameOverReason.ImpostorsBySabotage: case GameOverReason.ImpostorDisconnect: winner = "impostors"; break;
            default: winner = "unknown"; break;
        }
        if (_started && _inMeeting) EmitMeetingEnded(); // the game can end right at the vote, before the meeting screen closes
        if (_started) Events.Add("game_ended", "winner", winner, "reason", reason.ToString());
        _ended = true; _inMeeting = false;
        _closeLogAt = Events.Now + 3f;
    }

    // Orchestrator command: name of the next match (log folder). Only [A-Za-z0-9-], max 40.
    public static object Label(string id)
    {
        if (string.IsNullOrEmpty(id) || id.Length > 40) throw new BridgeError("bad id");
        foreach (var ch in id) if (!(ch == '-' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))) throw new BridgeError("bad id");
        _label = id;
        Plugin.Logger.LogInfo("[AUB] next match label: " + id);
        return id;
    }

    // Orchestrator command: finish the match early. Every copy emits game_ended(winner none, reason aborted) and goes to phase "ended";
    // the host also ends the game for everybody (CrewmateDisconnect: plain return to lobby, no role-specific screens).
    public static object Abort()
    {
        bool host = Client != null && Client.AmHost;
        bool inGame = Client != null && Client.GameState == InnerNetClient.GameStates.Started;
        if (!_ended)
        {
            if (_inMeeting) EmitMeetingEnded();
            Events.Add("game_ended", "winner", "none", "reason", "aborted");
            _ended = true; _inMeeting = false;
            _closeLogAt = Events.Now + 3f;
        }
        string how = "event";
        if (host && inGame && GameManager.Instance != null)
        {
            try { GameManager.Instance.RpcEndGame(GameOverReason.CrewmateDisconnect, false); how = "rpc_end_game"; }
            catch (Exception e) { Warn("abort RpcEndGame: " + e.Message); how = "event (rpc failed)"; }
        }
        Plugin.Logger.LogInfo("[AUB] abort: " + how);
        return how;
    }

    // ---------------- host commands ----------------
    static NormalGameOptionsV12 HostOptions()
    {
        var c = Client;
        if (c == null || !c.AmHost) throw new BridgeError("not host");
        if (c.GameState != InnerNetClient.GameStates.Joined) throw new BridgeError("not in lobby");
        var cur = GameOptionsManager.Instance.CurrentGameOptions;
        var o = cur != null ? cur.TryCast<NormalGameOptionsV12>() : null;
        if (o == null) throw new BridgeError("no normal-game options");
        return o;
    }

    static int Int(JsonElement r, string k, int def, int lo, int hi)
    {
        if (!r.TryGetProperty(k, out var v) || v.ValueKind == JsonValueKind.Null) return def;
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var x) || x < lo || x > hi) throw new BridgeError($"bad {k} ({lo}..{hi})");
        return x;
    }
    static float Flt(JsonElement r, string k, float def, float lo, float hi)
    {
        if (!r.TryGetProperty(k, out var v) || v.ValueKind == JsonValueKind.Null) return def;
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetSingle(out var x) || float.IsNaN(x) || x < lo || x > hi) throw new BridgeError($"bad {k} ({lo}..{hi})");
        return x;
    }
    static bool Bool(JsonElement r, string k, bool def)
    {
        if (!r.TryGetProperty(k, out var v) || v.ValueKind == JsonValueKind.Null) return def;
        if (v.ValueKind != JsonValueKind.True && v.ValueKind != JsonValueKind.False) throw new BridgeError($"bad {k} (bool)");
        return v.GetBoolean();
    }
    static bool Has(JsonElement r, string k) => r.TryGetProperty(k, out var v) && v.ValueKind != JsonValueKind.Null;

    public static object Configure(JsonElement r)
    {
        var o = HostOptions();
        string map = r.TryGetProperty("map", out var mv) && mv.ValueKind == JsonValueKind.String ? mv.GetString().ToLowerInvariant() : "skeld";
        if (map != "skeld") throw new BridgeError("only map=skeld");
        string tb = r.TryGetProperty("taskBarUpdates", out var tv) && tv.ValueKind == JsonValueKind.String ? tv.GetString().ToLowerInvariant() : "always";
        TaskBarMode mode;
        if (tb == "always") mode = TaskBarMode.Normal; else if (tb == "meetings") mode = TaskBarMode.MeetingOnly; else if (tb == "never") mode = TaskBarMode.Invisible;
        else throw new BridgeError("bad taskBarUpdates (always|meetings|never)");

        // validate everything first, then apply
        int imp = Int(r, "impostors", 2, 1, 3), disc = Int(r, "discussion", 15, 0, 120), vote = Int(r, "voting", 60, 0, 300);
        float kcd = Flt(r, "killCooldown", 20f, 2.5f, 60f);
        bool confirm = Bool(r, "confirmEjects", true);
        int? common = Has(r, "commonTasks") ? Int(r, "commonTasks", 0, 0, 2) : null;
        int? shortT = Has(r, "shortTasks") ? Int(r, "shortTasks", 0, 0, 5) : null;
        int? longT = Has(r, "longTasks") ? Int(r, "longTasks", 0, 0, 3) : null;
        int? meetings = Has(r, "emergencyMeetings") ? Int(r, "emergencyMeetings", 1, 0, 9) : null;
        int? ecd = Has(r, "emergencyCooldown") ? Int(r, "emergencyCooldown", 15, 0, 60) : null;
        int? kdist = Has(r, "killDistance") ? Int(r, "killDistance", 1, 0, 2) : null;
        float? speed = Has(r, "speed") ? Flt(r, "speed", 1f, 0.25f, 3f) : null;
        float? crewL = Has(r, "crewLight") ? Flt(r, "crewLight", 1f, 0.25f, 5f) : null;
        float? impL = Has(r, "impostorLight") ? Flt(r, "impostorLight", 1.5f, 0.25f, 5f) : null;
        bool? visual = Has(r, "visualTasks") ? Bool(r, "visualTasks", true) : null;
        bool? anon = Has(r, "anonymousVotes") ? Bool(r, "anonymousVotes", false) : null;
        bool? ghostT = Has(r, "ghostsDoTasks") ? Bool(r, "ghostsDoTasks", true) : null;

        var targets = new List<NormalGameOptionsV12> { o };
        var host = GameOptionsManager.Instance.normalGameHostOptions;
        if (host != null && host.Pointer != o.Pointer) targets.Add(host);
        foreach (var t in targets)
        {
            t.SetByte(ByteOptionNames.MapId, 0);
            t.SetInt(Int32OptionNames.NumImpostors, imp);
            t.SetInt(Int32OptionNames.DiscussionTime, disc);
            t.SetInt(Int32OptionNames.VotingTime, vote);
            t.SetFloat(FloatOptionNames.KillCooldown, kcd);
            t.SetBool(BoolOptionNames.ConfirmImpostor, confirm);
            t.SetInt(Int32OptionNames.TaskBarMode, (int)mode);
            if (common.HasValue) t.SetInt(Int32OptionNames.NumCommonTasks, common.Value);
            if (shortT.HasValue) t.SetInt(Int32OptionNames.NumShortTasks, shortT.Value);
            if (longT.HasValue) t.SetInt(Int32OptionNames.NumLongTasks, longT.Value);
            if (meetings.HasValue) t.SetInt(Int32OptionNames.NumEmergencyMeetings, meetings.Value);
            if (ecd.HasValue) t.SetInt(Int32OptionNames.EmergencyCooldown, ecd.Value);
            if (kdist.HasValue) t.SetInt(Int32OptionNames.KillDistance, kdist.Value);
            if (speed.HasValue) t.SetFloat(FloatOptionNames.PlayerSpeedMod, speed.Value);
            if (crewL.HasValue) t.SetFloat(FloatOptionNames.CrewLightMod, crewL.Value);
            if (impL.HasValue) t.SetFloat(FloatOptionNames.ImpostorLightMod, impL.Value);
            if (visual.HasValue) t.SetBool(BoolOptionNames.VisualTasks, visual.Value);
            if (anon.HasValue) t.SetBool(BoolOptionNames.AnonymousVotes, anon.Value);
            if (ghostT.HasValue) t.SetBool(BoolOptionNames.GhostsDoTasks, ghostT.Value);
            // every special role off; Judge and SpiritGuide are new in 2026.9.29
            foreach (var role in new[] { RoleTypes.Scientist, RoleTypes.Engineer, RoleTypes.GuardianAngel, RoleTypes.Shapeshifter, RoleTypes.Noisemaker, RoleTypes.Phantom, RoleTypes.Tracker, RoleTypes.Detective, RoleTypes.Viper, RoleTypes.Judge, RoleTypes.SpiritGuide })
                t.roleOptions.SetRoleRate(role, 0, 0);
        }
        var lo = GameManager.Instance.LogicOptions;
        lo.SetGameOptions(o.Cast<IGameOptions>());
        lo.SyncOptions();
        GameOptionsManager.Instance.SaveNormalHostOptions();
        Plugin.Logger.LogInfo($"[AUB] configured: impostors={imp} killCooldown={kcd} discussion={disc} voting={vote} taskbar={tb} confirm={confirm}");

        return new Dictionary<string, object>
        {
            ["impostors"] = o.GetInt(Int32OptionNames.NumImpostors), ["killCooldown"] = o.GetFloat(FloatOptionNames.KillCooldown),
            ["discussion"] = o.GetInt(Int32OptionNames.DiscussionTime), ["voting"] = o.GetInt(Int32OptionNames.VotingTime),
            ["taskBar"] = o.GetInt(Int32OptionNames.TaskBarMode), ["confirmEjects"] = o.GetBool(BoolOptionNames.ConfirmImpostor),
            ["common"] = o.GetInt(Int32OptionNames.NumCommonTasks), ["short"] = o.GetInt(Int32OptionNames.NumShortTasks), ["long"] = o.GetInt(Int32OptionNames.NumLongTasks),
            ["map"] = o.GetByte(ByteOptionNames.MapId), ["anyRoles"] = o.roleOptions.AnyRolesEnabled(),
        };
    }

    // Host only: the players who must be the impostors at the next start; empty = the game's own random pick.
    static string[] _forced = Array.Empty<string>();

    public static void SetImpostors(string[] names)
    {
        var c = Client;
        if (c == null || !c.AmHost) throw new BridgeError("not host");
        _forced = names;
        Plugin.Logger.LogInfo("[AUB] impostors: " + (names.Length > 0 ? string.Join(", ", names) : "random"));
    }

    // RoleManager.SelectRoles prefix: deal the roles from _forced. False = let the game pick (nothing
    // forced, not the host, or a forced name is not in the game).
    public static bool AssignForcedRoles()
    {
        if (_forced.Length == 0 || Client == null || !Client.AmHost) return false;
        var all = PlayerControl.AllPlayerControls;
        var names = new HashSet<string>();
        for (int i = 0; i < all.Count; i++) if (all[i] != null && all[i].Data != null && !all[i].Data.Disconnected) names.Add(all[i].Data.PlayerName);
        foreach (var n in _forced)
        {
            if (!names.Contains(n)) { Warn($"impostor {n} is not in the game: the game picks the roles"); return false; }
        }
        for (int i = 0; i < all.Count; i++)
        {
            var p = all[i];
            if (p == null || p.Data == null || p.Data.Disconnected) continue;
            p.RpcSetRole(Array.IndexOf(_forced, p.Data.PlayerName) >= 0 ? RoleTypes.Impostor : RoleTypes.Crewmate, false);
        }
        Plugin.Logger.LogInfo("[AUB] roles dealt: impostors " + string.Join(", ", _forced));
        return true;
    }

    public static void Start()
    {
        var o = HostOptions();
        var gsm = UnityEngine.Object.FindObjectOfType<GameStartManager>();
        if (gsm == null) throw new BridgeError("no start manager (not in lobby?)");
        if (gsm.startState != GameStartManager.StartingStates.NotStarting) throw new BridgeError("already starting");
        int n = GameData.Instance != null ? GameData.Instance.PlayerCount : 0;
        int imp = o.GetInt(Int32OptionNames.NumImpostors);
        var mp = NormalGameOptionsV12.MinPlayers;
        int min = mp != null && imp >= 0 && imp < mp.Length ? mp[imp] : 4;
        if (n < min) throw new BridgeError($"need at least {min} players for {imp} impostor(s), have {n}");
        Plugin.Logger.LogInfo($"[AUB] start: BeginGame players={n} impostors={imp}");
        gsm.BeginGame();
        // 2026.9.29 stops at a "5 or more players is recommended" popup (GameSizePopup) when there are
        // only 4 players; ReallyBegin(false) is that popup's "Okay" button.
        if (gsm.startState == GameStartManager.StartingStates.NotStarting && gsm.GameSizePopup != null && gsm.GameSizePopup.activeSelf)
        {
            Plugin.Logger.LogInfo("[AUB] start: game size popup -> ReallyBegin");
            gsm.ReallyBegin(false);
            gsm.GameSizePopup.SetActive(false);
        }
    }
}
