param([int]$AppProcessId, [string]$SelectedPath, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RestorePickerWindow {
  public delegate bool EnumWindow(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetDlgItemText(IntPtr window, int id, string text);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(int pid) {
    var process = System.Diagnostics.Process.GetProcessById(pid);
    IntPtr found = IntPtr.Zero;
    foreach (System.Diagnostics.ProcessThread thread in process.Threads) {
      EnumThreadWindows((uint)thread.Id, (window, data) => {
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        if (name.ToString() == "#32770") found = window;
        return true;
      }, IntPtr.Zero);
    }
    return found;
  }
}
'@
# Enumerate the fixture's own threads. UIAutomation's root can omit an owned
# dialog on the Webview test desktop even while the modal is visibly pending.
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$handle = [IntPtr]::Zero
while ([DateTime]::UtcNow -lt $deadline) {
  $handle = [RestorePickerWindow]::Find($AppProcessId)
  if ($handle -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ($handle -eq [IntPtr]::Zero) { throw 'Native file dialog did not appear for this fixture process' }
if ($Cancel) {
  [void][RestorePickerWindow]::PostMessage($handle, 0x0111, [IntPtr]2, [IntPtr]::Zero)
} else {
  if ([RestorePickerWindow]::GetDlgItem($handle, 1148) -eq [IntPtr]::Zero) { throw 'Native filename control was not found' }
  if (![RestorePickerWindow]::SetDlgItemText($handle, 1148, $SelectedPath)) { throw 'Native filename control could not be filled' }
  [void][RestorePickerWindow]::PostMessage($handle, 0x0111, [IntPtr]1, [IntPtr]::Zero)
}
