param(
  [Parameter(Mandatory = $true)][ValidateSet("window-info", "focus", "capture", "shortcut", "uia-info", "uia-invoke")][string]$Action,
  [string]$Title = "project",
  [string]$OutputPath,
  [ValidateSet("CTRL_R", "CTRL_S", "F5")][string]$Shortcut,
  [string]$ControlName
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct DouyinRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class DouyinNative {
  [DllImport("user32.dll", EntryPoint = "GetWindowRect")]
  private static extern bool GetWindowRectNative(IntPtr hWnd, out DouyinRect rect);
  public static int[] GetWindowRectValues(IntPtr hWnd) {
    DouyinRect rect;
    if (!GetWindowRectNative(hWnd, out rect)) return null;
    return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
  }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
Add-Type -AssemblyName System.Drawing
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Get-TargetProcess {
  $items = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      $_.MainWindowTitle -like "*$Title*" -or $_.Path -like "*@bytedminiprogram-ide*"
    )
  })
  if ($items.Count -eq 0) { throw "target IDE window was not found" }
  if ($items.Count -gt 1) { throw "multiple target IDE windows found" }
  return $items[0]
}

function Get-Rect($handle) {
  $values = [DouyinNative]::GetWindowRectValues($handle)
  if ($null -eq $values) { throw "cannot read window bounds" }
  return [ordered]@{ left = $values[0]; top = $values[1]; right = $values[2]; bottom = $values[3] }
}

function Json($value) { $value | ConvertTo-Json -Compress -Depth 6 }

function Get-UiaSummary {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $all = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
    $items = @($all | Where-Object { $_.Current.Name -or $_.Current.AutomationId } | Select-Object -First 40 | ForEach-Object {
      [ordered]@{ name = $_.Current.Name; automationId = $_.Current.AutomationId; type = $_.Current.ControlType.ProgrammaticName }
    })
    return [ordered]@{ supported = $true; exposedCount = $all.Count; elements = $items }
  }
  catch { return [ordered]@{ supported = $false; reason = "UIA is unavailable" } }
}

function Invoke-UiaButton($name) {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
    $matches = @($buttons | Where-Object { $_.Current.Name -eq $name })
    if ($matches.Count -ne 1) { return [ordered]@{ supported = $false; clicked = $false; control = $name; matched = $matches.Count; reason = "UIA control is not exposed" } }
    $pattern = $matches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return [ordered]@{ supported = $true; clicked = $true; control = $name; matched = 1 }
  }
  catch { return [ordered]@{ supported = $false; clicked = $false; control = $name; reason = "UIA control invoke failed" } }
}

$process = Get-TargetProcess
$handle = [IntPtr]$process.MainWindowHandle
$rect = Get-Rect $handle
$bounds = [ordered]@{
  left = $rect.left; top = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top
}

switch ($Action) {
  "window-info" {
    Json ([ordered]@{ supported = $true; pid = $process.Id; handle = $process.MainWindowHandle; title = $process.MainWindowTitle; bounds = $bounds })
  }
  "focus" {
    [DouyinNative]::ShowWindowAsync($handle, 9) | Out-Null
    [DouyinNative]::SetForegroundWindow($handle) | Out-Null
    Json ([ordered]@{ supported = $true; focused = $true; pid = $process.Id; title = $process.MainWindowTitle })
  }
  "capture" {
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { throw "capture requires OutputPath" }
    if ($bounds.width -le 0 -or $bounds.height -le 0) { throw "window bounds are invalid" }
    $bitmap = New-Object System.Drawing.Bitmap($bounds.width, $bounds.height)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.CopyFromScreen($bounds.left, $bounds.top, 0, 0, $bitmap.Size) }
      finally { $graphics.Dispose() }
      $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $bitmap.Dispose() }
    Json ([ordered]@{ supported = $true; path = $OutputPath; bounds = $bounds })
  }
  "shortcut" {
    if ([string]::IsNullOrWhiteSpace($Shortcut)) { throw "shortcut requires Shortcut" }
    [DouyinNative]::ShowWindowAsync($handle, 9) | Out-Null
    [DouyinNative]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 80
    $VK_CONTROL = 0x11; $VK_R = 0x52; $VK_S = 0x53; $VK_F5 = 0x74
    $key = switch ($Shortcut) { "CTRL_R" { $VK_R } "CTRL_S" { $VK_S } "F5" { $VK_F5 } }
    if ($Shortcut -like "CTRL_*") { [DouyinNative]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero) }
    [DouyinNative]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [DouyinNative]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
    if ($Shortcut -like "CTRL_*") { [DouyinNative]::keybd_event($VK_CONTROL, 0, 2, [UIntPtr]::Zero) }
    Json ([ordered]@{ supported = $true; shortcut = $Shortcut; pid = $process.Id })
  }
  "uia-info" { Json (Get-UiaSummary) }
  "uia-invoke" {
    if ([string]::IsNullOrWhiteSpace($ControlName)) { throw "uia-invoke requires ControlName" }
    Json (Invoke-UiaButton $ControlName)
  }
}
