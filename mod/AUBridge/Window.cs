using System;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace AUBridge;

// For recording every copy on its own: each window gets a title with its player's name (OBS finds a
// window by title, and all copies are "Among Us.exe"), and --aub-window=WxH keeps it windowed at that size.
public static class Window
{
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowText(IntPtr hWnd, string text);

    static IntPtr _hwnd;
    static float _next;
    static int _sizeTries;

    // Main thread, from Runner.Tick.
    public static void Tick(float now)
    {
        if (now < _next) return;
        _next = now + 2f;
        try { Title(); } catch (Exception e) { Plugin.Logger.LogWarning("[AUB] window title: " + e.Message); }
        Size();
    }

    static void Title()
    {
        var name = Plugin.Cfg.Name;
        if (name == null) return;
        if (_hwnd == IntPtr.Zero) _hwnd = Find();
        if (_hwnd == IntPtr.Zero) return;
        string want = "Among Us - " + name;
        var sb = new StringBuilder(256);
        GetWindowText(_hwnd, sb, sb.Capacity);
        if (sb.ToString() == want) return;
        SetWindowText(_hwnd, want);
        Plugin.Logger.LogInfo("[AUB] window title: " + want);
    }

    static IntPtr Find()
    {
        uint me = (uint)Environment.ProcessId;
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var pid);
            if (pid != me) return true;
            var cls = new StringBuilder(64);
            GetClassName(h, cls, cls.Capacity);
            if (cls.ToString() != "UnityWndClass") return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // The game applies its own saved resolution after start, so this checks again and corrects it a few times.
    static void Size()
    {
        int w = Plugin.Cfg.WindowWidth, h = Plugin.Cfg.WindowHeight;
        if (w <= 0 || h <= 0 || _sizeTries >= 10) return;
        if (Screen.width == w && Screen.height == h && Screen.fullScreenMode == FullScreenMode.Windowed) return;
        _sizeTries++;
        Screen.SetResolution(w, h, FullScreenMode.Windowed);
        Plugin.Logger.LogInfo($"[AUB] window size: {Screen.width}x{Screen.height} -> {w}x{h} (try {_sizeTries})");
    }
}
