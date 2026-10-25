using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;

namespace AUBridge;

// Walkability grid of the ship (true-position space) + A* + path smoothing. Built from the game's own colliders,
// flood-filled from the spawn point (so the void outside the hull is never "walkable"), cached to a file.
public static class Nav
{
    public const float Step = 0.25f;
    public static readonly string CacheDir = System.IO.Path.Combine(GameLog.Root, "nav");

    public static bool Ready;
    public static string Status = "none";
    public static string MaskName = "nt4608";
    public static float Clearance = 0.06f;
    static float _ox, _oy;
    static int _w, _h;
    static bool[] _walk;
    static float[] _pen;
    static int _count;
    static readonly Dictionary<string, List<int>> _roomCells = new();

    // A* scratch (reused)
    static float[] _g; static int[] _par; static int[] _seen; static int[] _closed; static int _stamp;

    public static int Cells => _count;

    // "phys": everything the physics matrix lets the local player collide with (non-trigger), the exact walls/tables/etc.
    static bool Blocked(Vector2 p, float r, int mask)
    {
        if (MaskName != "phys" && !MaskName.StartsWith("nt")) return PhysicsHelpers.CircleContains(p, r, mask);
        var hits = Physics2D.OverlapCircleAll(p, r, mask);
        for (int i = 0; i < hits.Length; i++) { var h = hits[i]; if (h != null && !h.isTrigger) return true; }
        return false;
    }

    static int MaskValue()
    {
        if (MaskName.StartsWith("nt") && int.TryParse(MaskName.Substring(2), out var ntv)) return ntv;
        if (MaskName == "phys")
        {
            int layer = PlayerControl.LocalPlayer.gameObject.layer;
            int m = Physics2D.GetLayerCollisionMask(layer);
            m &= ~((1 << layer) | Constants.PlayersOnlyMask);
            Plugin.Logger.LogInfo($"[AUB] player layer={layer} collisionMask(without players)={m}");
            return m;
        }
        switch (MaskName)
        {
            case "shipobj": return Constants.ShipAndObjectsMask;
            case "shipall": return Constants.ShipAndAllObjectsMask;
            case "shadow": return Constants.ShadowMask;
            case "ship": return Constants.ShipOnlyMask;
            default: return MaskName.StartsWith("bits") && int.TryParse(MaskName.Substring(4), out var v) ? v : Constants.ShipOnlyMask;
        }
    }

    // ---------------- build / cache ----------------
    public static void Build(bool force)
    {
        Ready = false; _roomCells.Clear();
        var ship = ShipStatus.Instance; var me = PlayerControl.LocalPlayer;
        if (ship == null || me == null) { Status = "no ship"; return; }
        var t0 = DateTime.UtcNow;

        float minx = 1e9f, miny = 1e9f, maxx = -1e9f, maxy = -1e9f;
        void Inc(Vector2 p) { minx = Math.Min(minx, p.x); miny = Math.Min(miny, p.y); maxx = Math.Max(maxx, p.x); maxy = Math.Max(maxy, p.y); }
        var rooms = ship.AllRooms;
        for (int i = 0; i < rooms.Length; i++)
        {
            var r = rooms[i]; if (r == null || r.roomArea == null) continue;
            var b = r.roomArea.bounds; Inc(b.min); Inc(b.max);
        }
        var cons = ship.AllConsoles;
        for (int i = 0; i < cons.Length; i++) if (cons[i] != null) Inc(cons[i].transform.position);
        Inc(ship.InitialSpawnCenter); Inc(ship.MeetingSpawnCenter);
        if (minx > maxx) { Status = "no bounds"; return; }
        minx -= 2.5f; miny -= 2.5f; maxx += 2.5f; maxy += 2.5f;
        _ox = (float)Math.Floor(minx * 4) / 4; _oy = (float)Math.Floor(miny * 4) / 4;
        _w = (int)Math.Ceiling((maxx - _ox) / Step) + 1; _h = (int)Math.Ceiling((maxy - _oy) / Step) + 1;

        int mask = MaskValue();
        Plugin.Logger.LogInfo($"[AUB] masks: shipOnly={Constants.ShipOnlyMask} shipObj={Constants.ShipAndObjectsMask} shipAll={Constants.ShipAndAllObjectsMask} notShip={Constants.NotShipMask} players={Constants.PlayersOnlyMask} shadow={Constants.ShadowMask}; using {MaskName}={mask}");
        string file = System.IO.Path.Combine(CacheDir, $"skeld_{MaskName}_{(int)(Step * 100)}_{(int)(Clearance * 100)}_{(int)(_ox * 100)}_{(int)(_oy * 100)}_{_w}x{_h}.nav");
        bool loaded = false;
        if (!force) loaded = TryLoad(file);
        if (!loaded)
        {
            float rad = 0.22f;
            try { var cc = me.Collider.TryCast<CircleCollider2D>(); if (cc != null) rad = cc.radius; } catch { }
            float r2 = rad + Clearance;
            var free = new bool[_w * _h];
            for (int y = 0; y < _h; y++)
                for (int x = 0; x < _w; x++)
                    free[y * _w + x] = !Blocked(new Vector2(_ox + x * Step, _oy + y * Step), r2, mask);
            // flood fill from the best spawn candidate
            var cands = new List<Vector2> { me.GetTruePosition(), ship.InitialSpawnCenter, ship.MeetingSpawnCenter };
            bool[] best = null; int bestN = 0;
            foreach (var c in cands)
            {
                int s = NearestIn(free, c, 12);
                if (s < 0) continue;
                var f = Flood(free, s, out int n);
                if (n > bestN) { bestN = n; best = f; }
            }
            if (best == null) { Status = "flood failed (no free cell near spawn)"; return; }
            _walk = best;
            try { Directory.CreateDirectory(CacheDir); Save(file); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] nav cache save: " + e.Message); }
            Plugin.Logger.LogInfo($"[AUB] nav radius={rad} clearance={Clearance}");
        }
        _count = 0; for (int i = 0; i < _walk.Length; i++) if (_walk[i]) _count++;
        ComputePenalty();
        _g = new float[_walk.Length]; _par = new int[_walk.Length]; _seen = new int[_walk.Length]; _closed = new int[_walk.Length]; _stamp = 0;
        Ready = true;
        Status = $"ok {_w}x{_h} walkable={_count} mask={MaskName} {(loaded ? "cache" : "built")} {(DateTime.UtcNow - t0).TotalMilliseconds:0}ms";
        Plugin.Logger.LogInfo("[AUB] nav " + Status);
    }

    static bool[] Flood(bool[] free, int start, out int n)
    {
        var res = new bool[free.Length]; n = 0;
        var q = new Queue<int>(); q.Enqueue(start); res[start] = true; n = 1;
        int[] dx = { 1, -1, 0, 0, 1, 1, -1, -1 }, dy = { 0, 0, 1, -1, 1, -1, 1, -1 };
        while (q.Count > 0)
        {
            int c = q.Dequeue(); int cx = c % _w, cy = c / _w;
            for (int k = 0; k < 8; k++)
            {
                int nx = cx + dx[k], ny = cy + dy[k];
                if (nx < 0 || ny < 0 || nx >= _w || ny >= _h) continue;
                int ni = ny * _w + nx;
                if (res[ni] || !free[ni]) continue;
                if (k >= 4 && (!free[cy * _w + nx] || !free[ny * _w + cx])) continue; // no corner cutting
                res[ni] = true; n++; q.Enqueue(ni);
            }
        }
        return res;
    }

    static void ComputePenalty()
    {
        _pen = new float[_walk.Length];
        var dist = new int[_walk.Length];
        var q = new Queue<int>();
        for (int i = 0; i < _walk.Length; i++) { if (!_walk[i]) { dist[i] = 0; q.Enqueue(i); } else dist[i] = 99; }
        int[] dx = { 1, -1, 0, 0 }, dy = { 0, 0, 1, -1 };
        while (q.Count > 0)
        {
            int c = q.Dequeue(); if (dist[c] >= 4) continue;
            int cx = c % _w, cy = c / _w;
            for (int k = 0; k < 4; k++)
            {
                int nx = cx + dx[k], ny = cy + dy[k];
                if (nx < 0 || ny < 0 || nx >= _w || ny >= _h) continue;
                int ni = ny * _w + nx;
                if (dist[ni] > dist[c] + 1) { dist[ni] = dist[c] + 1; q.Enqueue(ni); }
            }
        }
        for (int i = 0; i < _walk.Length; i++) _pen[i] = _walk[i] && dist[i] < 4 ? (4 - dist[i]) * 0.35f : 0f;
    }

    static bool TryLoad(string file)
    {
        try
        {
            if (!File.Exists(file)) return false;
            using var br = new BinaryReader(File.OpenRead(file));
            if (br.ReadInt32() != 0x4E415631) return false;
            int w = br.ReadInt32(), h = br.ReadInt32(); float ox = br.ReadSingle(), oy = br.ReadSingle(), st = br.ReadSingle();
            if (w != _w || h != _h || Math.Abs(ox - _ox) > 1e-3 || Math.Abs(oy - _oy) > 1e-3 || Math.Abs(st - Step) > 1e-6) return false;
            var bytes = br.ReadBytes(w * h);
            if (bytes.Length != w * h) return false;
            _walk = new bool[w * h];
            for (int i = 0; i < bytes.Length; i++) _walk[i] = bytes[i] != 0;
            return true;
        }
        catch (Exception e) { Plugin.Logger.LogWarning("[AUB] nav cache load: " + e.Message); return false; }
    }

    static void Save(string file)
    {
        var tmp = file + ".tmp" + Environment.ProcessId;
        using (var bw = new BinaryWriter(File.Create(tmp)))
        {
            bw.Write(0x4E415631); bw.Write(_w); bw.Write(_h); bw.Write(_ox); bw.Write(_oy); bw.Write(Step);
            var bytes = new byte[_walk.Length];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = (byte)(_walk[i] ? 1 : 0);
            bw.Write(bytes);
        }
        if (File.Exists(file)) File.Delete(file);
        File.Move(tmp, file);
    }

    // ASCII picture of the grid for inspection ('#' blocked, '.' walkable, digits = rooms' first letters not used). Top = max y.
    public static string Dump(IEnumerable<Vector2> marks)
    {
        if (!Ready) return null;
        var marked = new Dictionary<int, char>();
        if (marks != null) { char c = 'A'; foreach (var m in marks) { int i = CellOf(m); if (i >= 0) marked[i] = c; if (c < 'Z') c++; } }
        var sb = new StringBuilder();
        sb.AppendLine($"origin={_ox},{_oy} step={Step} w={_w} h={_h}");
        for (int y = _h - 1; y >= 0; y--)
        {
            for (int x = 0; x < _w; x++) { int i = y * _w + x; sb.Append(marked.TryGetValue(i, out var ch) ? ch : _walk[i] ? (_pen[i] > 0 ? ',' : '.') : '#'); }
            sb.AppendLine();
        }
        return sb.ToString();
    }

    // ---------------- cell helpers ----------------
    public static int CellOf(Vector2 p)
    {
        int cx = (int)Math.Floor((p.x - _ox) / Step + 0.5f), cy = (int)Math.Floor((p.y - _oy) / Step + 0.5f);
        if (cx < 0 || cy < 0 || cx >= _w || cy >= _h) return -1;
        return cy * _w + cx;
    }
    public static Vector2 Center(int i) => new Vector2(_ox + (i % _w) * Step, _oy + (i / _w) * Step);
    public static bool WalkAt(Vector2 p) { int i = CellOf(p); return i >= 0 && _walk[i]; }

    static int NearestIn(bool[] arr, Vector2 p, int maxR)
    {
        int cx = (int)Math.Floor((p.x - _ox) / Step + 0.5f), cy = (int)Math.Floor((p.y - _oy) / Step + 0.5f);
        int best = -1; float bd = 1e9f; int found = -1;
        for (int r = 0; r <= maxR; r++)
        {
            if (found >= 0 && r > found + 1) break;
            for (int y = cy - r; y <= cy + r; y++)
                for (int x = cx - r; x <= cx + r; x++)
                {
                    if (Math.Max(Math.Abs(x - cx), Math.Abs(y - cy)) != r) continue;
                    if (x < 0 || y < 0 || x >= _w || y >= _h) continue;
                    int i = y * _w + x; if (!arr[i]) continue;
                    float d = (new Vector2(_ox + x * Step, _oy + y * Step) - p).sqrMagnitude;
                    if (d < bd) { bd = d; best = i; if (found < 0) found = r; }
                }
        }
        return best;
    }
    public static int Nearest(Vector2 p, int maxR = 16) => Ready ? NearestIn(_walk, p, maxR) : -1;

    // Straight segment fully on walkable cells (start is allowed to be slightly off-grid).
    public static bool Los(Vector2 a, Vector2 b)
    {
        float d = Vector2.Distance(a, b);
        int n = Math.Max(1, (int)Math.Ceiling(d / 0.08f));
        for (int k = 0; k <= n; k++)
        {
            var p = Vector2.Lerp(a, b, (float)k / n);
            if (!WalkAt(p) && (k == n || Vector2.Distance(p, a) > 0.3f)) return false;
        }
        return true;
    }

    // ---------------- rooms ----------------
    public static List<int> RoomCells(string room)
    {
        if (_roomCells.TryGetValue(room, out var l)) return l;
        l = new List<int>();
        var ship = ShipStatus.Instance;
        PlainShipRoom pr = null;
        for (int i = 0; i < ship.AllRooms.Length; i++) { var r = ship.AllRooms[i]; if (r != null && r.RoomId.ToString() == room) { pr = r; break; } }
        if (pr != null && pr.roomArea != null)
            for (int i = 0; i < _walk.Length; i++) if (_walk[i] && pr.roomArea.OverlapPoint(Center(i))) l.Add(i);
        _roomCells[room] = l;
        return l;
    }

    // Walkable open-floor cell of the room closest to the room's centre.
    public static bool RoomGoal(string room, out Vector2 goal)
    {
        goal = default;
        var cells = RoomCells(room);
        if (cells.Count == 0) return false;
        var ship = ShipStatus.Instance; Vector2 c = default;
        for (int i = 0; i < ship.AllRooms.Length; i++) { var r = ship.AllRooms[i]; if (r != null && r.RoomId.ToString() == room) { c = r.roomArea.bounds.center; break; } }
        int best = -1; float bd = 1e9f;
        foreach (var i in cells)
        {
            if (_pen[i] > 0) continue;
            float d = (Center(i) - c).sqrMagnitude;
            if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) foreach (var i in cells) { float d = (Center(i) - c).sqrMagnitude; if (d < bd) { bd = d; best = i; } }
        goal = Center(best);
        return true;
    }

    public static bool RandomInRoom(string room, System.Random rnd, out Vector2 goal)
    {
        goal = default;
        var cells = RoomCells(room);
        var open = new List<int>();
        foreach (var i in cells) if (_pen[i] <= 0) open.Add(i);
        if (open.Count == 0) open = cells;
        if (open.Count == 0) return false;
        goal = Center(open[rnd.Next(open.Count)]);
        return true;
    }

    // ---------------- A* ----------------
    static readonly int[] Dx = { 1, -1, 0, 0, 1, 1, -1, -1 }, Dy = { 0, 0, 1, -1, 1, -1, 1, -1 };

    // Smoothed waypoints from `from` to `to` (start excluded). null = no path.
    public static List<Vector2> Path(Vector2 from, Vector2 to, HashSet<int> blocked, out float length)
    {
        length = 0;
        if (!Ready) return null;
        int s = Nearest(from), g = Nearest(to);
        if (s < 0 || g < 0) return null;
        _stamp++;
        var open = new PriorityQueue<int, float>();
        _g[s] = 0; _par[s] = -1; _seen[s] = _stamp; open.Enqueue(s, 0);
        int gx = g % _w, gy = g / _w; bool found = false;
        while (open.Count > 0)
        {
            int c = open.Dequeue();
            if (_closed[c] == _stamp) continue;
            _closed[c] = _stamp;
            if (c == g) { found = true; break; }
            int cx = c % _w, cy = c / _w;
            for (int k = 0; k < 8; k++)
            {
                int nx = cx + Dx[k], ny = cy + Dy[k];
                if (nx < 0 || ny < 0 || nx >= _w || ny >= _h) continue;
                int ni = ny * _w + nx;
                if (!_walk[ni] || _closed[ni] == _stamp) continue;
                if (blocked != null && blocked.Contains(ni) && ni != g) continue;
                if (k >= 4 && (!_walk[cy * _w + nx] || !_walk[ny * _w + cx])) continue;
                float cost = (k >= 4 ? 1.4142f : 1f) * (1f + _pen[ni]);
                float ng = _g[c] + cost;
                if (_seen[ni] != _stamp || ng < _g[ni])
                {
                    _seen[ni] = _stamp; _g[ni] = ng; _par[ni] = c;
                    int ddx = Math.Abs(nx - gx), ddy = Math.Abs(ny - gy);
                    float h = (ddx + ddy) + (1.4142f - 2f) * Math.Min(ddx, ddy);
                    open.Enqueue(ni, ng + h);
                }
            }
        }
        if (!found) return null;
        var cells = new List<int>();
        for (int c = g; c != -1; c = _par[c]) cells.Add(c);
        cells.Reverse();
        var pts = new List<Vector2> { from };
        for (int i = 1; i < cells.Count; i++) pts.Add(Center(cells[i]));
        if (WalkAt(to)) pts[pts.Count - 1] = to;
        // string pulling
        var res = new List<Vector2>();
        int a = 0;
        while (a < pts.Count - 1)
        {
            int j = Math.Min(pts.Count - 1, a + 60);
            while (j > a + 1 && !Los(pts[a], pts[j])) j--;
            res.Add(pts[j]); length += Vector2.Distance(pts[a], pts[j]); a = j;
        }
        if (res.Count == 0) res.Add(pts[pts.Count - 1]);
        return res;
    }
}
