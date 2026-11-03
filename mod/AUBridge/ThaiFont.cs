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
        try { AddMarkPairs(); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] thai font: mark pairs: " + e.Message); }
        return true;
    }

    const string Upper = "ัิีึื็"; // ั ิ ี ึ ื ็
    const string Tones = "่้๊๋์";       // ่ ้ ๊ ๋ ์
    const string Tall = "ปฝฟฬ";               // ป ฝ ฟ ฬ
    const string Lower = "ฺุู";                     // ุ ู ฺ
    const string Tailed = "ฎฏ";                           // ฎ ฏ
    const char SaraAm = 'ำ';                                    // ำ

    // This TextMeshPro has no mark positioning (the font's GPOS mark-to-base and mark-to-mark): every Thai
    // mark sits where the font draws it alone, so a tone mark after an upper vowel sinks into the vowel
    // (นั้น, ที่), marks on ป ฝ ฟ ฬ hit the tall stem, and a vowel under ฎ ฏ hits the tail. TMP does apply
    // its kerning table, pair adjustments that can move either glyph of two in a row: these move the mark.
    // Distances come from the glyphs' own metrics, so they fit whichever font was found.
    static void AddMarkPairs()
    {
        var chars = _asset.characterLookupTable;
        var table = _asset.fontFeatureTable;
        var list = table.glyphPairAdjustmentRecords;
        var lookup = table.m_GlyphPairAdjustmentRecordLookupDictionary;
        if (chars == null || list == null || lookup == null) { Plugin.Logger.LogWarning("[AUB] thai font: no kerning table to add mark pairs to"); return; }
        float gap = _asset.faceInfo.pointSize * 0.04f;
        int added = 0;

        bool Get(char c, out uint index, out UnityEngine.TextCore.GlyphMetrics m)
        {
            index = 0; m = default;
            if (!chars.ContainsKey(c)) return false;
            var ch = chars[c];
            if (ch == null || ch.glyph == null) return false;
            index = ch.glyphIndex; m = ch.glyph.metrics;
            return true;
        }
        static float Top(UnityEngine.TextCore.GlyphMetrics m) => m.horizontalBearingY;
        static float Bottom(UnityEngine.TextCore.GlyphMetrics m) => m.horizontalBearingY - m.height;
        void Add(uint first, uint second, float fx, float fy, float sx, float sy)
        {
            var rec = new TMP_GlyphPairAdjustmentRecord(
                new TMP_GlyphAdjustmentRecord(first, new TMP_GlyphValueRecord(fx, fy, 0, 0)),
                new TMP_GlyphAdjustmentRecord(second, new TMP_GlyphValueRecord(sx, sy, 0, 0)));
            uint key = second << 16 | first;
            if (lookup.ContainsKey(key)) lookup.Remove(key);
            lookup.Add(key, rec);
            list.Add(rec);
            added++;
        }

        // A tone mark after an upper vowel: up, clear of the vowel.
        foreach (var u in Upper)
        {
            if (!Get(u, out var ui, out var um)) continue;
            foreach (var t in Tones)
            {
                if (!Get(t, out var ti, out var tm)) continue;
                float up = Top(um) + gap - Bottom(tm);
                if (up > 0) Add(ui, ti, 0, 0, 0, up);
            }
        }
        // A tone mark before ำ (น้ำ): up, clear of its circle.
        if (Get(SaraAm, out var ai, out var am))
            foreach (var t in Tones)
            {
                if (!Get(t, out var ti, out var tm)) continue;
                float ring = Top(am) - Bottom(tm) + gap - am.height * 0.55f; // the circle is the top of ำ
                if (ring > 0) Add(ti, ai, 0, ring, 0, 0);
            }
        // An upper vowel or tone mark right after ป ฝ ฟ ฬ: left, clear of the stem.
        foreach (var c in Tall)
        {
            if (!Get(c, out var ci, out var cm)) continue;
            float stemLeft = cm.horizontalBearingX + cm.width - cm.horizontalAdvance - cm.width * 0.22f; // from the pen after the consonant
            foreach (var mk in Upper + Tones)
            {
                if (!Get(mk, out var mi, out var mm)) continue;
                float left = stemLeft - gap - (mm.horizontalBearingX + mm.width);
                if (left < 0) Add(ci, mi, 0, 0, left, 0);
            }
        }
        // A lower vowel right after ฎ ฏ: down, clear of the tail.
        foreach (var c in Tailed)
        {
            if (!Get(c, out var ci, out var cm)) continue;
            foreach (var l in Lower)
            {
                if (!Get(l, out var li, out var lm)) continue;
                float down = Bottom(cm) - gap - Top(lm);
                if (down < 0) Add(ci, li, 0, 0, 0, down);
            }
        }
        Plugin.Logger.LogInfo($"[AUB] thai font: {added} mark pairs");
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
