using UnityEngine;

namespace AUBridge;

// `pause {on}`: game time stands still on this copy (Time.timeScale 0) while the brains think, so a slow
// model loses no game time. Movement, kill cooldowns, sabotage and meeting timers all stop; Events.Now
// leaves the paused time out, so the mod's own timers and event times stop with them. The runner sends
// `pause {on:true}` again every few seconds while it holds the pause: a copy that hears nothing for
// 15 s (runner gone) resumes on its own.
public static class Pause
{
    public static bool On { get; private set; }
    static float _since, _total, _heard;

    // Real seconds this copy has spent paused.
    public static float Elapsed => _total + (On ? Time.realtimeSinceStartup - _since : 0f);

    public static void Set(bool on)
    {
        float now = Time.realtimeSinceStartup;
        _heard = now;
        if (on == On) return;
        if (on) { _since = now; Time.timeScale = 0f; }
        else { _total += now - _since; Time.timeScale = 1f; }
        On = on;
        Plugin.Logger.LogInfo($"[AUB] pause {(on ? "on" : "off")} (paused {Elapsed:0.0}s so far)");
    }

    // Main thread, every frame from Runner.Update.
    public static void Tick()
    {
        if (On && Time.realtimeSinceStartup - _heard > 15f) { Plugin.Logger.LogWarning("[AUB] pause: no word from the runner for 15 s, resuming"); Set(false); }
        if (On && Time.timeScale != 0f) Time.timeScale = 0f; // the game never sets it, but hold it anyway
    }
}
