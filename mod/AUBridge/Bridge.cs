using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace AUBridge;

// Loopback-only newline-delimited JSON server. Game access goes through Runner.Invoke (main thread).
public static class Bridge
{
    const int MaxLine = 8 * 1024, MaxConns = 6, IdleMs = 5 * 60 * 1000;
    static int _conns;
    static byte[] _token;

    public static void Start(int port, string token)
    {
        // Fail closed: without a token the bridge is not opened at all (no unauthenticated control of the game).
        if (string.IsNullOrEmpty(token) || token.Length < 16) { Plugin.Logger.LogError("[AUB] no --aub-token (>=16 chars): bridge NOT started"); return; }
        _token = Encoding.UTF8.GetBytes(token);
        var listener = new TcpListener(IPAddress.Loopback, port);
        try { listener.Start(8); }
        catch (Exception e) { Plugin.Logger.LogError($"[AUB] bridge could not listen on 127.0.0.1:{port}: {e.Message}"); return; }
        Plugin.Logger.LogInfo($"[AUB] bridge listening on 127.0.0.1:{port}");
        new Thread(() => AcceptLoop(listener)) { IsBackground = true, Name = "AUB-accept" }.Start();
    }

    static void AcceptLoop(TcpListener l)
    {
        while (true)
        {
            try
            {
                var c = l.AcceptTcpClient();
                if (Interlocked.Increment(ref _conns) > MaxConns)
                {
                    Interlocked.Decrement(ref _conns);
                    c.Close();
                    continue;
                }
                new Thread(() => Serve(c)) { IsBackground = true, Name = "AUB-conn" }.Start();
            }
            catch (Exception e) { Plugin.Logger.LogError("[AUB] accept: " + e.Message); Thread.Sleep(500); }
        }
    }

    static void Serve(TcpClient c)
    {
        try
        {
            c.ReceiveTimeout = IdleMs; c.SendTimeout = 5000; c.NoDelay = true;
            using var s = c.GetStream();
            var buf = new byte[MaxLine];
            int len = 0;
            var one = new byte[1024];
            while (true)
            {
                int n = s.Read(one, 0, one.Length);
                if (n <= 0) break;
                for (int i = 0; i < n; i++)
                {
                    byte b = one[i];
                    if (b == (byte)'\n')
                    {
                        Reply(s, Handle(Encoding.UTF8.GetString(buf, 0, len).Trim()));
                        len = 0;
                    }
                    else if (len < MaxLine) buf[len++] = b;
                    else { Reply(s, Err("line too long")); return; }
                }
            }
        }
        catch (Exception) { /* closed / timeout */ }
        finally { try { c.Close(); } catch { } Interlocked.Decrement(ref _conns); }
    }

    static void Reply(Stream s, object o)
    {
        var data = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(o) + "\n");
        s.Write(data, 0, data.Length);
    }

    static object Err(string m) => new Dictionary<string, object> { ["ok"] = false, ["error"] = m };

    static object Handle(string line)
    {
        try
        {
            if (line.Length == 0) return Err("empty");
            using var doc = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 4 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Err("bad request");

            var t = Str(root, "token");
            if (_token == null || t == null || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(t), _token))
                return Err("unauthorized");
            var cmd = Str(root, "cmd");
            switch (cmd)
            {
                case "state": break;
                case "host": Plugin.Logger.LogInfo("[AUB] cmd host"); Runner.Invoke(() => Runner.SetMode("host")); break;
                case "join": Plugin.Logger.LogInfo("[AUB] cmd join"); Runner.Invoke(() => Runner.SetMode("join")); break;
                case "setname":
                    {
                        var n = Validate.Name(Str(root, "name"));
                        if (n == null) return Err("bad name");
                        Plugin.Logger.LogInfo("[AUB] cmd setname " + n);
                        Runner.Invoke(() => Runner.SetName(n));
                        break;
                    }
                case "setcolor":
                    {
                        if (!root.TryGetProperty("color", out var cv) || cv.ValueKind != JsonValueKind.Number || !cv.TryGetInt32(out var col) || col < 0 || col > 17)
                            return Err("bad color");
                        Plugin.Logger.LogInfo("[AUB] cmd setcolor " + col);
                        Runner.Invoke(() => Runner.SetColor(col));
                        break;
                    }
                case "cosmetics":
                    {
                        var cat = Str(root, "category");
                        if (cat != null && Array.IndexOf(Cosmetics.Cats, cat) < 0) return Err("bad category");
                        bool uo = root.TryGetProperty("usable_only", out var uov) && uov.ValueKind == JsonValueKind.True;
                        return Runner.Invoke(() => Cosmetics.Catalog(cat, uo));
                    }
                case "setoutfit":
                    {
                        var of = Cosmetics.ParseFields(root, out var oerr);
                        if (of == null) return Err(oerr);
                        if (of.Count == 0) return Err("no outfit fields");
                        Plugin.Logger.LogInfo("[AUB] cmd setoutfit " + string.Join(",", of.Keys));
                        Runner.Invoke(() => Runner.SetOutfit(of)); // validates (BridgeError -> error reply)
                        break;
                    }
                case "configure":
                    {
                        Plugin.Logger.LogInfo("[AUB] cmd configure");
                        var cr = root.Clone(); // the queued call may outlive this handler (timeout) and the JsonDocument
                        var opts = Runner.Invoke(() => Game.Configure(cr));
                        var snap = (Dictionary<string, object>)Runner.Invoke(Runner.Snapshot);
                        snap["options"] = opts;
                        return snap;
                    }
                case "start": Plugin.Logger.LogInfo("[AUB] cmd start"); Runner.Invoke(Game.Start); break;
                case "abort": Plugin.Logger.LogInfo("[AUB] cmd abort"); Runner.Invoke(Game.Abort); break;
                case "label": { if (!root.TryGetProperty("id", out var lv) || lv.ValueKind != JsonValueKind.String) return Err("label needs id (string)"); var id = lv.GetString(); Runner.Invoke(() => Game.Label(id)); break; }
                case "wait_event": return WaitEvent(root);
                case "act": { var a = ActArgs.Parse(root); return Runner.Invoke(() => Body.Act(a)); }
                case "autopilot": { var a = new ActArgs { Do = "autopilot" }; if (root.TryGetProperty("on", out var ov)) { if (ov.ValueKind != JsonValueKind.True && ov.ValueKind != JsonValueKind.False) return Err("bad on (bool)"); a.On = ov.GetBoolean(); } return Runner.Invoke(() => Body.Autopilot(a)); }
                case "reflex":
                    {
                        if (!root.TryGetProperty("set", out var rs)) return Err("missing 'set'");
                        var defs = Body.ParseReflexes(rs);
                        Runner.Invoke(() => Body.SetReflexes(defs));
                        break;
                    }
                case "nav": { var cp = root.Clone(); return Runner.Invoke(() => Body.NavCmd(cp)); }
                default: return Err("unknown cmd");
            }
            return Runner.Invoke(Runner.Snapshot);
        }
        catch (JsonException) { return Err("bad json"); }
        catch (BridgeError e) { return Err(e.Message); }
        catch (TimeoutException) { return Err("game thread busy"); }
        catch (Exception e) { Plugin.Logger.LogError("[AUB] handler: " + e); return Err("internal error"); }
    }

    // Long poll: runs on the socket thread and never touches the game, so the main thread stays free.
    static object WaitEvent(JsonElement root)
    {
        double timeout = 30;
        if (root.TryGetProperty("timeout", out var tv))
        {
            if (tv.ValueKind != JsonValueKind.Number || !tv.TryGetDouble(out timeout) || double.IsNaN(timeout)) return Err("bad timeout");
            timeout = Math.Max(0, Math.Min(60, timeout));
        }
        long since = 0;
        if (root.TryGetProperty("since", out var sv) && (sv.ValueKind != JsonValueKind.Number || !sv.TryGetInt64(out since))) return Err("bad since");
        bool quiet = root.TryGetProperty("quiet", out var qv) && qv.ValueKind == JsonValueKind.True;
        var (seq, events) = Events.Wait(since, timeout, quiet);
        return new Dictionary<string, object> { ["ok"] = true, ["seq"] = seq, ["events"] = events };
    }

    static string Str(JsonElement o, string k) =>
        o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
