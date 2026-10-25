using System;
using HarmonyLib;

namespace AUBridge;

// Guest-account link popup (AskToMergeGuest) is opened by EOSManager.BeginMergeGuestAccountFlow.
// We skip it and take the "Not right now" continuation instead. MergeGuestAccountIntoPlatform
// (the real merge) and RequestMergeGuestAccount are never called by this plugin.
[HarmonyPatch]
public static class Patches
{
    [HarmonyPatch(typeof(EOSManager), nameof(EOSManager.BeginMergeGuestAccountFlow))]
    [HarmonyPrefix]
    public static bool SkipMergePopup(EOSManager __instance)
    {
        Plugin.Logger.LogInfo("[AUB] guest-link popup suppressed (BeginMergeGuestAccountFlow skipped)");
        try { __instance.EndMergeGuestAccountFlow(); }
        catch (Exception e) { Plugin.Logger.LogError("[AUB] EndMergeGuestAccountFlow failed: " + e.Message); }
        return false;
    }

    // Hard guard: the real merge must never run while this plugin is loaded, whatever path reaches it.
    [HarmonyPatch(typeof(EOSManager), nameof(EOSManager.MergeGuestAccountIntoPlatform))]
    [HarmonyPrefix]
    public static bool BlockMerge()
    {
        Plugin.Logger.LogError("[AUB] MergeGuestAccountIntoPlatform blocked");
        return false;
    }

    // The popup still appears (the login flow reaches it natively). Do not hide it and leave the login stuck:
    // remember it, Runner then presses its "Not right now" button (never the "go ahead" one).
    public static AskToMergeGuest PendingPopup;
    public static float PopupSeen;

    [HarmonyPatch(typeof(AskToMergeGuest), nameof(AskToMergeGuest.Start))]
    [HarmonyPostfix]
    public static void HideMergePopup(AskToMergeGuest __instance)
    {
        Plugin.Logger.LogWarning("[AUB] AskToMergeGuest.Start ran; will press 'Not right now' (no merge)");
        PendingPopup = __instance;
        PopupSeen = UnityEngine.Time.realtimeSinceStartup;
    }
}
