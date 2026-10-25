using System;
using System.Collections.Generic;
using System.Text.Json;
using AmongUs.Data;

namespace AUBridge;

// Cosmetics catalog and outfit validation (main thread only).
// Rule: only items with Free == true or bought on this account (PlayerPurchasesData.GetPurchase) may be worn.
// There are NO patches that unlock paid items; the check below is the only gate.
public static class Cosmetics
{
    public static readonly string[] Cats = { "hats", "skins", "visors", "pets", "nameplates" };
    // outfit field name -> catalog category (same order as Cats)
    public static readonly string[] Fields = { "hat", "skin", "visor", "pet", "nameplate" };

    static List<CosmeticData> All(string cat)
    {
        var res = new List<CosmeticData>();
        var hm = HatManager.Instance;
        if (hm == null) return res;
        switch (cat)
        {
            case "hats": if (hm.allHats != null) for (int i = 0; i < hm.allHats.Length; i++) res.Add(hm.allHats[i]); break;
            case "skins": if (hm.allSkins != null) for (int i = 0; i < hm.allSkins.Length; i++) res.Add(hm.allSkins[i]); break;
            case "visors": if (hm.allVisors != null) for (int i = 0; i < hm.allVisors.Length; i++) res.Add(hm.allVisors[i]); break;
            case "pets": if (hm.allPets != null) for (int i = 0; i < hm.allPets.Length; i++) res.Add(hm.allPets[i]); break;
            case "nameplates": if (hm.allNamePlates != null) for (int i = 0; i < hm.allNamePlates.Length; i++) res.Add(hm.allNamePlates[i]); break;
        }
        return res;
    }

    public static bool Owned(CosmeticData d)
    {
        try { return DataManager.Player.Purchases.GetPurchase(d.ProdId, d.BundleId); }
        catch { return false; }
    }

    public static bool Usable(CosmeticData d) => d != null && (d.Free || Owned(d));

    static CosmeticData Find(string cat, string id)
    {
        foreach (var d in All(cat)) if (d != null && d.ProdId == id) return d;
        return null;
    }

    // null = ok; otherwise the error text. field is one of Fields.
    public static string Check(string field, string id)
    {
        int ix = Array.IndexOf(Fields, field);
        if (ix < 0) return "bad field " + field;
        if (string.IsNullOrEmpty(id) || id.Length > 100) return "bad " + field + " id";
        if (HatManager.Instance == null) return "catalog not loaded";
        var d = Find(Cats[ix], id);
        if (d == null) return "unknown " + field + " id";
        if (!Usable(d)) return "not owned: " + field + " " + id;
        return null;
    }

    public static object Catalog(string only, bool usableOnly)
    {
        if (HatManager.Instance == null) throw new BridgeError("catalog not loaded");
        var res = new Dictionary<string, object> { ["ok"] = true };
        foreach (var cat in Cats)
        {
            if (only != null && only != cat) continue;
            var list = new List<object>();
            foreach (var d in All(cat))
            {
                if (d == null) continue;
                string id = null, name = null; bool free = false;
                try { id = d.ProdId; free = d.Free; } catch { }
                if (string.IsNullOrEmpty(id)) continue;
                bool owned = free || Owned(d);
                if (usableOnly && !owned) continue;
                try { name = d.GetItemName(); } catch { }
                var o = new Dictionary<string, object> { ["id"] = id, ["free"] = free, ["owned"] = owned };
                if (!string.IsNullOrEmpty(name) && name != id) o["name"] = name;
                list.Add(o);
            }
            res[cat] = list;
        }
        res["current"] = Current();
        return res;
    }

    public static Dictionary<string, object> Current()
    {
        var cur = new Dictionary<string, object>();
        if (!DataManager.IsPlayerLoaded) return cur;
        var c = DataManager.Player.Customization;
        cur["hat"] = c.Hat; cur["skin"] = c.Skin; cur["visor"] = c.Visor; cur["pet"] = c.Pet; cur["nameplate"] = c.NamePlate;
        return cur;
    }

    // Parses {"hat":..} from a bridge request / launch arg; only known string fields are kept.
    public static Dictionary<string, string> ParseFields(JsonElement root, out string error)
    {
        error = null;
        var d = new Dictionary<string, string>();
        foreach (var f in Fields)
        {
            if (!root.TryGetProperty(f, out var v)) continue;
            if (v.ValueKind != JsonValueKind.String) { error = "bad " + f; return null; }
            var s = v.GetString();
            if (string.IsNullOrEmpty(s) || s.Length > 100) { error = "bad " + f; return null; }
            d[f] = s;
        }
        return d;
    }
}
