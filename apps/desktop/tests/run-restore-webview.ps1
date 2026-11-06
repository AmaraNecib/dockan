param([Parameter(Mandatory=$true)][string]$Repository)
$ErrorActionPreference = 'Stop'
Set-Location $Repository
# This opt-in unit-test executable instantiates Wry. Unlike the packaged app
# executable, Cargo's lib-test target does not receive Tauri's Windows manifest.
$build = & cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features native-restore-webview-test --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$executable = $null
foreach ($line in $build) {
  try { $item = $line | ConvertFrom-Json } catch { continue }
  if ($item.reason -eq 'compiler-artifact' -and $item.target.name -eq 'dokan_lib' -and $item.profile.test -and $item.executable) { $executable = $item.executable }
}
if (!$executable) { throw 'Cargo did not report the interactive fixture executable' }
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$mt = Get-ChildItem $sdk -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'x64/mt.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$mt) { throw 'The installed Windows SDK manifest tool is required; no tool is downloaded' }
& $mt -nologo -manifest (Join-Path $Repository 'apps/desktop/tests/windows-test.manifest.xml') "-outputresource:$executable;#1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $executable backup_restore_real_webview_journey --ignored --nocapture
exit $LASTEXITCODE
