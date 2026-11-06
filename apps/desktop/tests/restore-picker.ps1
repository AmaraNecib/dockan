param([int]$AppProcessId, [string]$SelectedPath, [switch]$Cancel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RestorePickerWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string text);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppProcessId)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'))
)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $dialog = $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  if ($null -ne $dialog) { break }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $dialog) { throw 'Native file dialog did not appear for this fixture process' }
$handle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($Cancel) {
  [void][RestorePickerWindow]::PostMessage($handle, 0x0111, [IntPtr]2, [IntPtr]::Zero)
} else {
  $field = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')))
  if ($null -eq $field) { throw 'Native filename control was not found' }
  $pattern = $field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $pattern.SetValue($SelectedPath)
  [void][RestorePickerWindow]::PostMessage($handle, 0x0111, [IntPtr]1, [IntPtr]::Zero)
}
