# Starts the packaged app from a folder and checks it answers (used by the Windows package workflow).
#   pwsh scripts/smoke-test.ps1 -App <folder containing "Start LK Companion.cmd"> -DataHome <empty data folder>
param([Parameter(Mandatory)][string]$App, [Parameter(Mandatory)][string]$DataHome)
$ErrorActionPreference = 'Stop'
foreach ($required in 'launcher.mjs', 'version.json', 'apply-update.cmd', 'node\node.exe', 'app\server.js', 'app\.next\BUILD_ID', 'app\.next\static') {
  if (-not (Test-Path (Join-Path $App $required))) { throw "The package is missing $required" }
}
$env:LKC_HOME = $DataHome
$env:LKC_NO_BROWSER = '1'
$out = Join-Path $DataHome 'launcher.out'
$err = Join-Path $DataHome 'launcher.err'
New-Item -ItemType Directory -Force -Path $DataHome | Out-Null
$p = Start-Process -FilePath (Join-Path $App 'node\node.exe') -ArgumentList 'launcher.mjs' -WorkingDirectory $App -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
try {
  $ok = $false
  for ($i = 0; $i -lt 90 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3127/api/status; if ($r.StatusCode -eq 200) { $ok = $true } } catch {}
  }
  Get-Content $out
  if (-not $ok) { Get-Content $err; Get-Content (Join-Path $DataHome 'logs\server.log') -ErrorAction SilentlyContinue; throw 'The packaged app did not start.' }
  foreach ($path in '/', '/settings', '/chronology', '/assistant') {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:3127$path"
    if ($r.StatusCode -ne 200) { throw "$path answered $($r.StatusCode)" }
    Write-Output "$path OK"
  }
  if (-not (Test-Path (Join-Path $DataHome 'lk-companion.db'))) { throw 'The database was not created in LKC_HOME.' }
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$App*" } | Stop-Process -Force
  Start-Sleep -Seconds 2
}
