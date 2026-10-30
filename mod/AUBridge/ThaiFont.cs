using System;
using TMPro;
using UnityEngine;

namespace AUBridge;

// The game's TextMeshPro fonts have no Thai glyphs, so Thai chat shows as boxes. This builds a dynamic
// font asset from a Windows font that has Thai and adds it as a fallback to TMP and to every loaded font.
public static class ThaiFont
{
    static readonly string[] Wanted = { "leelawui.ttf", "leelawad.ttf", "tahoma.ttf" }; // first one found wins
    static TMP_FontAsset _asset;
    static bool _failed;
    static float _nextScan;
    static int _attached;

    // Main thread, from Runner.Tick. Font assets load with scenes, so the scan repeats.
    public static void Tick(float now)
    {
        if (_failed || now < _nextScan) return;
        _nextScan = now + 5f;
        try
        {
            if (_asset == null && !Create()) { _failed = true; return; }
            Attach();
        }
        catch (Exception e) { _failed = true; Plugin.Logger.LogWarning("[AUB] thai font: " + e.Message); }
    }

    static bool Create()
    {
        string path = null;
        foreach (var want in Wanted)
        {
            foreach (var p in Font.GetPathsToOSFonts())
                if (p.EndsWith("\\" + want, StringComparison.OrdinalIgnoreCase) || p.EndsWith("/" + want, StringComparison.OrdinalIgnoreCase)) { path = p; break; }
            if (path != null) break;
        }
        if (path == null) { Plugin.Logger.LogWarning("[AUB] thai font: no Leelawadee or Tahoma in the OS fonts"); return false; }

        var font = new Font(path);
        _asset = TMP_FontAsset.CreateFontAsset(font);
        if (_asset == null) { Plugin.Logger.LogWarning("[AUB] thai font: CreateFontAsset failed for " + path); return false; }
        _asset.name = "AUB Thai";
        font.hideFlags = HideFlags.HideAndDontSave;
        _asset.hideFlags = HideFlags.HideAndDontSave; // survives scene loads and UnloadUnusedAssets
        if (_asset.material != null) _asset.material.hideFlags = HideFlags.HideAndDontSave;
        bool ok = _asset.TryAddCharacters("กขคงจฉชซญดตถทนบปผพฟภมยรลวศสหอฮะาำิีึืุู่้๊๋็์เแโใไ");
        Plugin.Logger.LogInfo($"[AUB] thai font: {path} (glyphs {(ok ? "ok" : "partial")})");
        return true;
    }

    static void Attach()
    {
        int n = 0;
        var global = TMP_Settings.fallbackFontAssets;
        if (global != null && !global.Contains(_asset)) { global.Add(_asset); n++; }
        foreach (var fa in Resources.FindObjectsOfTypeAll<TMP_FontAsset>())
        {
            if (fa == null || fa == _asset) continue;
            var table = fa.fallbackFontAssetTable;
            if (table == null) { table = new Il2CppSystem.Collections.Generic.List<TMP_FontAsset>(); fa.fallbackFontAssetTable = table; }
            if (table.Contains(_asset)) continue;
            table.Add(_asset);
            n++;
        }
        if (n > 0) { _attached += n; Plugin.Logger.LogInfo($"[AUB] thai font: fallback added to {n} font(s), {_attached} so far"); }
    }
}
