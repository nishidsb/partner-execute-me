# AuraDesk - keyboard / focus-text recorder (resident worker)
#
# ASCII only: Windows PowerShell 5.1 parses .ps1 as ANSI when there is no BOM.
#
# Two independent threads, both started from here:
#   1) WH_KEYBOARD_LL hook  -> one line per keydown, delivered on stdout
#   2) UI Automation poll   -> one line per focus snapshot, delivered on stdout
#
# Line protocol on stdout (Node parses, tab-free, '|' separated):
#   R|ready
#   E|<ts>|<vk>|<mods>|<char>|<exe>|<window title>      keydown (title is last: may contain '|')
#   X|<json>                                            focus snapshot, see Keys.UiAJson
#   Z|<msg>                                             worker-side complaint (never contains text)
#
# Why UIA on top of the hook: WH_KEYBOARD_LL gives virtual key codes only, so an
# IME-composed Chinese word never shows up as itself (you get the pinyin keys).
# Reading the focused control's ValuePattern is the only way to keep the real text.
#
# Nothing is written to disk here. This process only emits events; the Node side
# decides what to store, and drops everything while a password field has focus.
param()

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$code = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

namespace AuraKeys {

  public static class W32 {
    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandleW(string lpModuleName);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
    [DllImport("user32.dll")] public static extern int ToUnicodeEx(uint wVirtKey, uint wScanCode, byte[] lpKeyState, StringBuilder pwszBuff, int cchBuff, uint wFlags, IntPtr dwhkl);
    [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    [StructLayout(LayoutKind.Sequential)] public struct MSG {
      public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
      public uint time; public int ptX; public int ptY;
    }
  }

  public static class Out {
    static readonly object gate = new object();
    public static void Line(string s) {
      lock (gate) {
        try { Console.Out.Write(s); Console.Out.Write("\n"); Console.Out.Flush(); } catch { }
      }
    }
  }

  public static class Keys {
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104;

    static IntPtr hook = IntPtr.Zero;
    static W32.HookProc proc;          // must stay reachable, otherwise the GC eats the callback
    static volatile bool running = false;

    static IntPtr lastHwnd = IntPtr.Zero;
    static string lastExe = "";
    static string lastTitle = "";
    static long lastMetaAt = 0;

    public static bool Running { get { return running; } }

    static bool Down(int vk) { return (W32.GetAsyncKeyState(vk) & 0x8000) != 0; }
    static bool Toggled(int vk) { return (W32.GetAsyncKeyState(vk) & 0x0001) != 0; }

    static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

    /* Foreground exe + title. Cached for 900 ms: a burst of typing would otherwise
       hit Process.GetProcessById once per key. */
    static void RefreshMeta() {
      long t = Now();
      IntPtr h = W32.GetForegroundWindow();
      if (h == lastHwnd && (t - lastMetaAt) < 900) return;
      lastHwnd = h;
      lastMetaAt = t;
      lastExe = ""; lastTitle = "";
      if (h == IntPtr.Zero) return;
      try {
        var sb = new StringBuilder(300);
        W32.GetWindowTextW(h, sb, 300);
        lastTitle = sb.ToString();
      } catch { }
      try {
        uint pid;
        W32.GetWindowThreadProcessId(h, out pid);
        using (var p = Process.GetProcessById((int)pid)) { lastExe = p.ProcessName; }
      } catch { }
    }

    static string CharOf(int vk, int sc) {
      try {
        byte[] st = new byte[256];
        if (Down(0x10) || Down(0xA0) || Down(0xA1)) st[0x10] = 0x80;
        if (Down(0x11) || Down(0xA2) || Down(0xA3)) st[0x11] = 0x80;
        if (Down(0x12) || Down(0xA4) || Down(0xA5)) st[0x12] = 0x80;
        if (Toggled(0x14)) st[0x14] = 0x01;
        var sb = new StringBuilder(8);
        // Layout must come from the window that owns the focus, not from this thread,
        // otherwise a 104-key US layout would decode everything typed in a JP window.
        uint tid = 0;
        W32.GetWindowThreadProcessId(W32.GetForegroundWindow(), out tid);
        IntPtr hkl = W32.GetKeyboardLayout(tid);
        // flags 0x04 = do not modify keyboard state, so dead keys cannot poison the IME.
        int n = W32.ToUnicodeEx((uint)vk, (uint)sc, st, sb, 8, 4, hkl);
        if (n <= 0) return "";
        string s = sb.ToString();
        if (s.Length > n) s = s.Substring(0, n);
        // drop control chars; keep the key identity in vk
        var keep = new StringBuilder();
        for (int i = 0; i < s.Length; i++) { char c = s[i]; if (c >= 32) keep.Append(c); }
        return keep.ToString();
      } catch { return ""; }
    }

    static IntPtr Cb(int nCode, IntPtr wParam, IntPtr lParam) {
      try {
        if (nCode >= 0) {
          int msg = (int)wParam;
          if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
            int vk = Marshal.ReadInt32(lParam);
            int sc = Marshal.ReadInt32(lParam, 4) & 0xFF;
            RefreshMeta();
            string ch = CharOf(vk, sc);
            string safeTitle = (lastTitle == null ? "" : lastTitle).Replace("\r", " ").Replace("\n", " ");
            Out.Line("E|" + Now() + "|" + vk + "|" + sc + "|" + ch + "|" + (lastExe == null ? "" : lastExe) + "|" + safeTitle);
          }
        }
      } catch { }
      return W32.CallNextHookEx(hook, nCode, wParam, lParam);
    }

    public static void Start() {
      if (running) return;
      proc = Cb;
      var th = new Thread(delegate() {
        try {
          hook = W32.SetWindowsHookExW(WH_KEYBOARD_LL, proc, W32.GetModuleHandleW(null), 0);
          if (hook == IntPtr.Zero) {
            Out.Line("Z|hook-install-failed err=" + Marshal.GetLastWin32Error());
            return;
          }
          running = true;
          Out.Line("R|hook");
          W32.MSG m;
          while (W32.GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
          running = false;
        } catch (Exception e) { Out.Line("Z|hook-thread " + e.GetType().Name); }
      });
      th.IsBackground = true;
      th.SetApartmentState(ApartmentState.STA);
      th.Start();
    }

    public static void Stop() {
      try { if (hook != IntPtr.Zero) W32.UnhookWindowsHookEx(hook); } catch { }
      hook = IntPtr.Zero;
      running = false;
    }

    /* ---- UI Automation: what is actually in the box he is typing into ---- */

    static long lastCost = 0;
    static volatile bool uiaOn = true;

    static string J(string s) {
      if (s == null) return "null";
      var sb = new StringBuilder("\"");
      for (int i = 0; i < s.Length; i++) {
        char c = s[i];
        if (c == '"') sb.Append("\\\"");
        else if (c == '\\') sb.Append("\\\\");
        else if (c == '\n') sb.Append("\\n");
        else if (c == '\r') sb.Append("\\r");
        else if (c == '\t') sb.Append("\\t");
        else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
        else sb.Append(c);
      }
      sb.Append("\"");
      return sb.ToString();
    }

    static string Snapshot() {
      long t0 = Now();
      AutomationElement ae = AutomationElement.FocusedElement;
      if (ae == null) return null;

      bool pw = false;
      try { pw = (bool)ae.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty); } catch { }

      string ct = "";
      try { ct = ae.Current.ControlType.ProgrammaticName; } catch { }
      if (ct != null) ct = ct.Replace("ControlType.", "");

      if (pw) {
        RefreshMeta();
        return "{\"t\":" + t0 + ",\"pw\":1,\"a\":" + J(lastExe) + ",\"w\":" + J(lastTitle) + "}";
      }

      /* Only editable-ish controls are worth a round trip. Reading a whole document
         (TextPattern.DocumentRange) costs hundreds of ms on Chromium and returns the
         page body, not what he typed, so we ask for the visible range instead. */
      string text = null;
      object vp;
      if (ae.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) {
        try { text = ((ValuePattern)vp).Current.Value; } catch { }
      }
      if (text == null) {
        object tp;
        if (ae.TryGetCurrentPattern(TextPattern.Pattern, out tp)) {
          try {
            // TextPatternRange lives in System.Windows.Automation.Text, which we do not `using`
            System.Windows.Automation.Text.TextPatternRange[] rs = ((TextPattern)tp).GetVisibleRanges();
            if (rs != null && rs.Length > 0) text = rs[0].GetText(400);
          } catch { }
        }
      }

      RefreshMeta();
      long cost = Now() - t0;
      lastCost = cost;
      var json = new StringBuilder();
      json.Append("{\"t\":").Append(t0)
          .Append(",\"pw\":0,\"a\":").Append(J(lastExe))
          .Append(",\"w\":").Append(J(lastTitle))
          .Append(",\"ct\":").Append(J(ct))
          .Append(",\"ms\":").Append(cost)
          .Append(",\"x\":").Append(J(text)).Append("}");
      return json.ToString();
    }

    public static void StartUia() {
      var th = new Thread(delegate() {
        Thread.Sleep(1200);   // let the hook settle first; UIA init is the slow part
        while (uiaOn) {
          try {
            string s = Snapshot();
            if (s != null) Out.Line("X|" + s);
          } catch (Exception e) { Out.Line("Z|uia " + e.GetType().Name); }
          /* Self-throttling: a slow target (Chromium with a huge page) must not turn
             into a busy loop. Nothing faster than 3 s, nothing slower than 60 s. */
          long napL = lastCost * 4 + 1500;
          if (napL < 3000) napL = 3000;
          if (napL > 60000) napL = 60000;
          lastCost = 0;
          Thread.Sleep((int)napL);
        }
      });
      th.IsBackground = true;
      th.SetApartmentState(ApartmentState.STA);
      th.Start();
    }

    public static void StopUia() { uiaOn = false; }
  }
}
"@

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition $code -ReferencedAssemblies UIAutomationClient, UIAutomationTypes
} catch {
  $msg = $_.Exception.Message
  # Dig through every ErrorRecord on the stack: Add-Type buries the actual
  # compiler errors (file line / error text) a few levels deep.
  foreach ($e in @($Error)) {
    try {
      $msg = $msg + ' ||| ' + $e.ToString()
      $to = $e.TargetObject
      if ($to -is [System.CodeDom.Compiler.CompilerError[]]) {
        foreach ($ce in $to) { $msg = $msg + ' CE:' + $ce.Line + ':' + $ce.ErrorText }
      }
      $ex = $e.Exception
      while ($ex) {
        if ($ex.InnerExceptions) {
          foreach ($x in $ex.InnerExceptions) { $msg = $msg + ' || ' + $x.Message }
        }
        if ($ex.InnerException -eq $ex) { break }
        $ex = $ex.InnerException
      }
    } catch { }
  }
  [Console]::Out.WriteLine("Z|compile-failed " + $msg)
  [Console]::Out.Flush()
  exit 1
}

[AuraKeys.Keys]::StartUia()
[AuraKeys.Keys]::Start()

# Main thread just idles on stdin: 'quit' (or a closed pipe) shuts everything down.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  if ($line.Trim() -eq 'ping') { [Console]::Out.WriteLine("P|pong"); [Console]::Out.Flush() }
}

[AuraKeys.Keys]::StopUia()
[AuraKeys.Keys]::Stop()
