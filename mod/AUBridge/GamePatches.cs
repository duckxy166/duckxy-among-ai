using System;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes.Arrays;

namespace AUBridge;

// Event hooks. One class per patch so that a failure of one never disables the others (see Plugin.Load).
static class Hook
{
    public static void Safe(string what, Action a)
    {
        try { a(); } catch (Exception e) { Plugin.Logger.LogWarning($"[AUB] hook {what}: {e.Message}"); }
    }
}

[HarmonyPatch(typeof(PlayerControl), nameof(PlayerControl.MurderPlayer))]
static class PMurder
{
    [HarmonyPostfix] static void Post(PlayerControl __instance, PlayerControl target) => Hook.Safe("murder", () => Game.OnMurder(__instance, target));
}

[HarmonyPatch(typeof(RoleManager), nameof(RoleManager.SelectRoles))]
static class PSelectRoles
{
    [HarmonyPrefix] static bool Pre() { bool dealt = false; Hook.Safe("selectRoles", () => dealt = Game.AssignForcedRoles()); return !dealt; }
}

[HarmonyPatch(typeof(PlayerControl), nameof(PlayerControl.StartMeeting))]
static class PStartMeeting
{
    [HarmonyPostfix] static void Post(PlayerControl __instance, NetworkedPlayerInfo target) => Hook.Safe("startMeeting", () => Game.OnStartMeeting(__instance, target));
}

[HarmonyPatch(typeof(ChatController), nameof(ChatController.AddChat))]
static class PChat
{
    [HarmonyPostfix] static void Post(PlayerControl sourcePlayer, string chatText) => Hook.Safe("chat", () => Game.OnChat(sourcePlayer, chatText));
}

[HarmonyPatch(typeof(AmongUsClient), nameof(AmongUsClient.OnGameEnd))]
static class PGameEnd
{
    [HarmonyPostfix] static void Post(EndGameResult endGameResult) => Hook.Safe("gameEnd", () => Game.OnGameEnd(endGameResult.GameOverReason));
}

[HarmonyPatch(typeof(MeetingHud), nameof(MeetingHud.VotingComplete))]
static class PVotingComplete
{
    [HarmonyPostfix] static void Post(Il2CppStructArray<MeetingHud.VoterState> states, NetworkedPlayerInfo exiled, bool tie) =>
        Hook.Safe("votingComplete", () => Game.OnVotingComplete(states, exiled, tie));
}

[HarmonyPatch(typeof(MeetingHud), nameof(MeetingHud.CastVote))]
static class PCastVote
{
    // 2026.9.29: CastVote(PlayerId, PlayerId). Declaring the parameter as byte compiles but makes Harmony emit
    // invalid IL, which breaks CastVote itself (no vote ever counts).
    [HarmonyPostfix] static void Post(InnerNet.PlayerId srcPlayerId) { byte src = srcPlayerId; Hook.Safe("castVote", () => Game.OnVoteCast(src)); }
}

[HarmonyPatch(typeof(Vent), nameof(Vent.EnterVent))]
static class PVentEnter
{
    [HarmonyPostfix] static void Post(Vent __instance, PlayerControl pc) => Hook.Safe("ventEnter", () => Game.OnVent(pc, __instance, true));
}

[HarmonyPatch(typeof(Vent), nameof(Vent.ExitVent))]
static class PVentExit
{
    [HarmonyPostfix] static void Post(Vent __instance, PlayerControl pc) => Hook.Safe("ventExit", () => Game.OnVent(pc, __instance, false));
}

[HarmonyPatch(typeof(PlayerPhysics), nameof(PlayerPhysics.FixedUpdate))]
static class PPhysics
{
    [HarmonyPostfix] static void Post(PlayerPhysics __instance) { try { Body.ApplyVelocity(__instance); } catch (Exception) { } }
}

// Feeds the bot's direction into the game's own input path too (animation, facing), while the bot is driving.
[HarmonyPatch(typeof(KeyboardJoystick), nameof(KeyboardJoystick.DeltaL), MethodType.Getter)]
static class PJoyKey
{
    [HarmonyPostfix] static void Post(ref UnityEngine.Vector2 __result) { if (Body.Active) __result = Body.Desired; }
}
