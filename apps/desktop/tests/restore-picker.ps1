param([int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RestorePickerWindow {
  public delegate bool EnumWindow(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
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
# Only cancellation is automated. UIAutomation does not expose the native Open
# pattern on this harness desktop; selection is a separate test-only adapter.
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$handle = [IntPtr]::Zero
while ([DateTime]::UtcNow -lt $deadline) {
  $handle = [RestorePickerWindow]::Find($AppProcessId)
  if ($handle -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ($handle -eq [IntPtr]::Zero) { throw 'Native file dialog did not appear for this fixture process' }
[void][RestorePickerWindow]::PostMessage($handle, 0x0111, [IntPtr]2, [IntPtr]::Zero)
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([RestorePickerWindow]::IsWindow($handle) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if ([RestorePickerWindow]::IsWindow($handle)) { throw 'Native picker did not close after cancellation' }
