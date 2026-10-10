using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class WorkdeskFolderForeground
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint size;
        public IntPtr window;
        public uint flags;
        public uint count;
        public uint timeout;
    }

    public static bool Activate(IntPtr window)
    {
        // Shell tabs can expose child handles. Activate their top-level window.
        window = GetAncestor(window, 2);
        if (window == IntPtr.Zero) return false;
        if (IsIconic(window))
        {
            ShowWindowAsync(window, 9); // SW_RESTORE
            Thread.Sleep(100);
        }
        BringWindowToTop(window);
        SetForegroundWindow(window);
        if (WaitForForeground(() => GetForegroundWindow() == window, 500)) return true;

        // Windows can refuse background focus changes. Ask for attention without
        // changing system focus policy or making the folder permanently topmost.
        FlashInfo info = new FlashInfo();
        info.size = (uint)Marshal.SizeOf(typeof(FlashInfo));
        info.window = window;
        info.flags = 2; // FLASHW_TRAY
        info.count = 3;
        FlashWindowEx(ref info);
        return false;
    }

    public static bool WaitForForeground(Func<bool> isForeground, int timeoutMilliseconds)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        do
        {
            if (isForeground()) return true;
            if (elapsed.ElapsedMilliseconds >= timeoutMilliseconds) return false;
            Thread.Sleep(20);
        } while (true);
    }
}
