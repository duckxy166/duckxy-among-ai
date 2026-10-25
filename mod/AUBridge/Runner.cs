using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using AmongUs.Data;
using InnerNet;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AUBridge;

// Main-thread MonoBehaviour: drains the command queue and drives menu -> lobby automation.
public class Runner : MonoBehaviour
{
    public Runner(IntPtr ptr) : base(ptr) { }

    static readonly ConcurrentQueue<Action> Queue = new();
    static string _mode;
    static string _name;
    static int _color = -1;
    static float _nextTick, _lastAct, _searchStart;
    static float _lastIdentity, _lastAnnounce;
    static int _nameTries, _colorTries;
    static bool _searchWarned;
    static Dictionary<string, string> _outfit; // wanted cosmetics (validated); null = nothing to apply
    static bool _outfitChecked;                // launch-arg outfit validated against the catalog
    static readonly int[] _outfitTries = new int[5];

    // ---- cross-thread entry points (called from socket threads) ----
    public static T Invoke<T>(Func<T> f)
    {
        T result = default; Exception err = null;
        var done = new ManualResetEventSlim(false); // not disposed: after a timeout the queued action still runs and sets it
        Queue.Enqueue(() => { try { result = f(); } catch (Exception e) { err = e; } finally { done.Set(); } });
        if (!done.Wait(5000)) throw new TimeoutException();
        if (err != null) throw err;
        return result;
    }
    public static void Invoke(Action a) => Invoke<object>(() => { a(); return null; });

    // ---- commands (main thread only) ----
    public static void SetMode(string m) { _mode = m; _lastAct = 0; _searchStart = Time.realtimeSinceStartup; _searchWarned = false; }
    public static void SetName(string n) { _name = n; _nameTries = 0; _lastIdentity = 0; }
    public static void SetColor(int c) { _color = c; _colorTries = 0; _lastIdentity = 0; }

    // Called on the main thread. Every item must be Free or owned; otherwise BridgeError and nothing changes.
    public static void SetOutfit(Dictionary<string, string> o)
    {
        foreach (var kv in o) { var e = Cosmetics.Check(kv.Key, kv.Value); if (e != null) throw new BridgeError(e); }
        _outfit ??= new Dictionary<string, string>();
        foreach (var kv in o) _outfit[kv.Key] = kv.Value;
        _outfitChecked = true; Array.Clear(_outfitTries, 0, _outfitTries.Length); _lastIdentity = 0;
    }

    void Awake()
    {
        var c = Plugin.Cfg;
        if (c.Outfit != null) _outfit = new Dictionary<string, string>(c.Outfit);
        _mode = c.Mode; _name = c.Name; _color = c.Color; _searchStart = Time.realtimeSinceStartup;
        Plugin.Logger.LogInfo("[AUB] runner started");
    }

    void Update()
    {
        for (int i = 0; i < 32 && Queue.TryDequeue(out var a); i++)
        {
            try { a(); } catch (Exception e) { Plugin.Logger.LogError("[AUB] queued: " + e.Message); }
        }
        // Bot copies stay silent. The game sets its own mixer volumes, but never the global listener volume.
        if (Plugin.Cfg.Mute && AudioListener.volume != 0f) AudioListener.volume = 0f;
        float now = Time.realtimeSinceStartup;
        Game.Update(now);
        try { Body.Update(now); } catch (Exception e) { Plugin.Logger.LogError("[AUB] body: " + e.Message); }
        if (now < _nextTick) return;
        _nextTick = now + 0.5f;
        try { Tick(now); }
        catch (Exception e) { Plugin.Logger.LogError("[AUB] tick: " + e.Message); }
    }

    static AmongUsClient Client => AmongUsClient.Instance;
    static bool InGame => Client != null && Client.GameState != InnerNetClient.GameStates.NotJoined;

    static void Tick(float now)
    {
        ApplyIdentity(now);
        CloseAnnouncements(now);
        HandleMergePopup(now);
        PlayAgain(now);
        if (!InGame) DriveMenu(now);
    }

    // Bot copies (muted = not the human's window) leave the end screen by themselves: "Play again" -> back to the lobby.
    // The human's copy stays on the results screen until the human clicks.
    static float _endSceneSince = -1f, _lastPlayAgain;
    static int _playAgainTries;
    static void PlayAgain(float now)
    {
        if (SceneManager.GetActiveScene().name != "EndGame") { _endSceneSince = -1f; _playAgainTries = 0; return; }
        if (_endSceneSince < 0) _endSceneSince = now;
        if (!Plugin.Cfg.Mute || now - _endSceneSince < 4f || now - _lastPlayAgain < 10f || _playAgainTries >= 3) return;
        var nav = UnityEngine.Object.FindObjectOfType<EndGameNavigation>();
        if (nav == null) return;
        _lastPlayAgain = now; _playAgainTries++;
        Plugin.Logger.LogInfo("[AUB] end screen: EndGameNavigation.NextGame (try " + _playAgainTries + ")");
        nav.NextGame();
    }

    static void ApplyIdentity(float now)
    {
        if (!DataManager.IsPlayerLoaded) return;
        var cust = DataManager.Player.Customization;
        if (_name != null && cust.Name != _name) cust.Name = _name;
        if (_color >= 0 && cust.Color != (byte)_color) cust.Color = (byte)_color;

        ApplyOutfitLocal();

        // In the lobby the networked copy must be updated too; retries are capped so we never fight the host's colour dedup.
        var lp = PlayerControl.LocalPlayer;
        if (!InGame || lp == null || lp.Data == null || now - _lastIdentity < 2f) return;
        _lastIdentity = now;
        if (_name != null && lp.Data.PlayerName != _name && _nameTries++ < 5) lp.CmdCheckName(_name);
        if (_color >= 0 && lp.Data.DefaultOutfit != null && lp.Data.DefaultOutfit.ColorId != _color && _colorTries++ < 5)
            lp.CmdCheckColor((byte)_color);
        ApplyOutfitNet(lp);
    }

    // Launch-arg outfit is checked once the catalog exists; invalid/unowned items are dropped with a log line.
    static bool OutfitReady()
    {
        if (_outfit == null) return false;
        if (_outfitChecked) return true;
        if (HatManager.Instance == null) return false;
        _outfitChecked = true;
        foreach (var k in new List<string>(_outfit.Keys))
        {
            var e = Cosmetics.Check(k, _outfit[k]);
            if (e != null) { Plugin.Logger.LogWarning("[AUB] outfit: dropped " + k + " (" + e + ")"); _outfit.Remove(k); }
        }
        if (_outfit.Count == 0) _outfit = null;
        return _outfit != null;
    }

    static void ApplyOutfitLocal()
    {
        if (!OutfitReady()) return;
        var c = DataManager.Player.Customization;
        if (_outfit.TryGetValue("hat", out var h) && c.Hat != h) c.Hat = h;
        if (_outfit.TryGetValue("skin", out var s) && c.Skin != s) c.Skin = s;
        if (_outfit.TryGetValue("visor", out var v) && c.Visor != v) c.Visor = v;
        if (_outfit.TryGetValue("pet", out var p) && c.Pet != p) c.Pet = p;
        if (_outfit.TryGetValue("nameplate", out var n) && c.NamePlate != n) c.NamePlate = n;
    }

    // In the lobby: send RpcSet* for every field the networked outfit does not match yet (max 5 tries per field).
    static void ApplyOutfitNet(PlayerControl lp)
    {
        if (!OutfitReady()) return;
        var o = lp.Data.DefaultOutfit;
        if (o == null) return;
        if (_outfit.TryGetValue("hat", out var h) && o.HatId != h && _outfitTries[0]++ < 5) lp.RpcSetHat(h);
        if (_outfit.TryGetValue("skin", out var s) && o.SkinId != s && _outfitTries[1]++ < 5) lp.RpcSetSkin(s);
        if (_outfit.TryGetValue("visor", out var v) && o.VisorId != v && _outfitTries[2]++ < 5) lp.RpcSetVisor(v);
        if (_outfit.TryGetValue("pet", out var p) && o.PetId != p && _outfitTries[3]++ < 5) lp.RpcSetPet(p);
        if (_outfit.TryGetValue("nameplate", out var n) && o.NamePlateId != n && _outfitTries[4]++ < 5) lp.RpcSetNamePlate(n);
    }

    // Announcements popup is closed through its own Close(); it only dismisses, nothing else.
    static void CloseAnnouncements(float now)
    {
        if (now - _lastAnnounce < 1f) return;
        _lastAnnounce = now;
        var mm = UnityEngine.Object.FindObjectOfType<MainMenuManager>();
        var p = mm != null ? mm.announcementPopUp : null;
        if (p != null && p.gameObject.activeInHierarchy)
        {
            Plugin.Logger.LogInfo("[AUB] closing announcements popup");
            p.Close();
        }
    }

    static readonly HashSet<string> _warned = new();
    static void WarnOnce(string m) { if (_warned.Add(m)) Plugin.Logger.LogWarning(m); }

    // Never join anything outside the local network (official servers must stay untouched).
    // Only loopback and RFC1918 ranges: not 100.64/10 (Tailscale), 198.18/15, 26/8 (Radmin), link-local or public.
    static bool IsLan(string a)
    {
        if (!System.Net.IPAddress.TryParse(a, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return (b[0] == 127 && b[1] == 0 && b[2] == 0 && b[3] == 1)
            || b[0] == 10 || (b[0] == 192 && b[1] == 168) || (b[0] == 172 && b[1] >= 16 && b[1] <= 31);
    }

    static int _popupStep;
    static void HandleMergePopup(float now)
    {
        var pop = Patches.PendingPopup;
        if (pop == null) { _popupStep = 0; return; }
        float age = now - Patches.PopupSeen;
        try
        {
            if (_popupStep == 0 && age > 0.5f)
            {
                _popupStep = 1;
                Plugin.Logger.LogInfo("[AUB] popup: pressing NotRightNowButton");
                pop.NotRightNowButton.OnClick.Invoke();
            }
            else if (_popupStep == 1 && age > 8f && !LoginDone())
            {
                _popupStep = 2;
                Plugin.Logger.LogInfo("[AUB] popup: fallback EOSManager.EndMergeGuestAccountFlow");
                DestroyableSingleton<EOSManager>.Instance.EndMergeGuestAccountFlow();
            }
            else if (_popupStep == 2 && age > 16f && !LoginDone())
            {
                _popupStep = 3;
                Plugin.Logger.LogInfo("[AUB] popup: fallback EOSManager.BeginFinalPartsOfLoginFlow");
                DestroyableSingleton<EOSManager>.Instance.BeginFinalPartsOfLoginFlow();
            }
            else if (_popupStep >= 1 && age > 30f) { _popupStep = 4; Patches.PendingPopup = null; }
        }
        catch (Exception e) { Plugin.Logger.LogError("[AUB] popup handling: " + e.Message); _popupStep = Math.Max(_popupStep, 1); }
    }

    static bool LoginDone() { try { return DestroyableSingleton<EOSManager>.Instance.HasFinishedLoginFlow(); } catch { return false; } }

    static bool HostServerUp()
    {
        try
        {
            foreach (var e in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveUdpListeners())
                if (e.Port == 22023) return true;
        }
        catch { }
        return false;
    }

    static void DriveMenu(float now)
    {
        if ((_mode != "host" && _mode != "join") || now - _lastAct < 3f) return;
        // MainMenuManager exists only on the main-menu scene; the local screen (host/join buttons) may be another scene.
        var mm = UnityEngine.Object.FindObjectOfType<MainMenuManager>();
        if (mm != null && !mm.finishStartup) return;

        if (_mode == "host")
        {
            var hb = UnityEngine.Object.FindObjectOfType<HostLocalGameButton>();
            if (hb != null && hb.isActiveAndEnabled)
            {
                ForceHostOptions();
                Plugin.Logger.LogInfo("[AUB] host: HostLocalGameButton.OnClick");
                _lastAct = now + 15f; // let the connect coroutine finish before retrying
                hb.OnClick();
                return;
            }
        }
        else
        {
            JoinGameButton best = null;
            foreach (var jb in UnityEngine.Object.FindObjectsOfType<JoinGameButton>())
            {
                if (!jb.isActiveAndEnabled || string.IsNullOrEmpty(jb.netAddress)) continue;
                if (!IsLan(jb.netAddress)) { WarnOnce("[AUB] join: skipping non-LAN address " + jb.netAddress); continue; }
                if (best == null || (jb.netAddress == "127.0.0.1" && best.netAddress != "127.0.0.1")) best = jb; // prefer loopback
            }
            if (best != null)
            {
                Plugin.Logger.LogInfo("[AUB] join: JoinGameButton.OnClick " + best.netAddress);
                _lastAct = now + 10f;
                best.OnClick();
                return;
            }
            // Only one process per PC can listen for LAN broadcasts (UDP 47777), so most joiners never see the list.
            // If a local server is up, connect straight to loopback through a copy of the list-button prefab.
            var gd = UnityEngine.Object.FindObjectOfType<GameDiscovery>();
            if (gd != null && gd.ButtonPrefab != null && now - _searchStart > 8f && HostServerUp())
            {
                var jb = UnityEngine.Object.Instantiate(gd.ButtonPrefab);
                jb.netAddress = "127.0.0.1";
                jb.NetworkMode = NetworkModes.LocalGame;
                Plugin.Logger.LogInfo("[AUB] join: direct JoinGameButton.OnClick 127.0.0.1");
                _lastAct = now + 12f;
                jb.OnClick();
                return;
            }
            if (!_searchWarned && now - _searchStart > 120f)
            {
                _searchWarned = true;
                Plugin.Logger.LogWarning("[AUB] join: no local game found after 120s, still trying");
            }
            if (gd != null) return; // already on the local screen, just wait
        }
        // Local screen is not open yet: press the main-menu "Local" button.
        if (mm != null && mm.playLocalButton != null)
        {
            Plugin.Logger.LogInfo("[AUB] opening local game screen");
            _lastAct = now;
            mm.playLocalButton.OnClick.Invoke();
        }
    }

    static void ForceHostOptions()
    {
        try
        {
            var g = GameOptionsManager.Instance;
            foreach (var o in new[] { g.normalGameHostOptions, g.currentNormalGameOptions })
            {
                if (o == null) continue;
                o._MapId_k__BackingField = 0;          // The Skeld
                o._MaxPlayers_k__BackingField = 15;
            }
        }
        catch (Exception e) { Plugin.Logger.LogWarning("[AUB] could not set host options: " + e.Message); }
    }

    // ---- state snapshot (main thread) ----
    public static object Snapshot()
    {
        string stage = "menu";
        // On the results screen the client still counts as "joined", so check the scene first (it used to report "lobby")
        if (SceneManager.GetActiveScene().name == "EndGame") stage = "ended";
        else if (Client != null && Client.GameState == InnerNetClient.GameStates.Started) stage = "ingame";
        else if (InGame) stage = "lobby";
        else if (_mode == "join") stage = "searching";

        string name = _name; int color = _color;
        if (DataManager.IsPlayerLoaded) { name = DataManager.Player.Customization.Name; color = DataManager.Player.Customization.Color; }

        var players = new List<object>();
        var lp = PlayerControl.LocalPlayer;
        var gd = GameData.Instance;
        if (InGame && gd != null && gd.AllPlayers != null)
        {
            for (int i = 0; i < gd.AllPlayers.Count; i++)
            {
                var p = gd.AllPlayers[i];
                if (p == null) continue;
                players.Add(new Dictionary<string, object>
                {
                    ["name"] = p.PlayerName,
                    ["color"] = p.DefaultOutfit != null ? p.DefaultOutfit.ColorId : -1,
                    ["isLocal"] = lp != null && p.PlayerId == lp.PlayerId,
                });
            }
            if (lp != null && lp.Data != null) { name = lp.Data.PlayerName; if (lp.Data.DefaultOutfit != null) color = lp.Data.DefaultOutfit.ColorId; }
        }
        else if (name != null)
            players.Add(new Dictionary<string, object> { ["name"] = name, ["color"] = color, ["isLocal"] = true });

        object game = null;
        try { game = Game.GameState(); } catch (Exception e) { Plugin.Logger.LogError("[AUB] game state: " + e); }
        return new Dictionary<string, object>
        {
            ["ok"] = true,
            ["id"] = Plugin.Cfg.Id,
            ["game"] = game,
            ["scene"] = SceneManager.GetActiveScene().name,
            ["mode"] = _mode,
            ["stage"] = stage,
            ["name"] = name,
            ["color"] = color,
            ["players"] = players,
        };
    }
}

