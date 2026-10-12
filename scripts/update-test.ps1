# Installs an "update" over an installed copy of the package with apply-update.cmd, as
# "Start LK Companion" does after the app asks for it, and checks the result (Windows CI).
#   pwsh scripts/update-test.ps1 -Package <unzipped "LK Companion" folder>
param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP 'update-test'
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
$installed = Join-Path $root 'installed\LK Companion'
$data = Join-Path $root 'data'
$ready = Join-Path $data 'updates\ready\LK Companion'
New-Item -ItemType Directory -Force -Path $installed, $ready | Out-Null
Copy-Item -Recurse -Force (Join-Path $Package '*') $installed
Copy-Item -Recurse -Force (Join-Path $Package '*') $ready
# The installed copy has an old file that the update no longer has, and data of its own nearby.
Set-Content (Join-Path $installed 'app\old-chunk.js') 'old'
Set-Content (Join-Path $root 'installed\my-notes.txt') 'keep me'
# The update is marked so its arrival can be seen.
Set-Content (Join-Path $ready 'app\new-chunk.js') 'new'
(Get-Content (Join-Path $ready 'version.json') | ConvertFrom-Json | ForEach-Object { $_.build = 999999; $_ } | ConvertTo-Json) | Set-Content (Join-Path $ready 'version.json')
Set-Content (Join-Path $data 'updates\ready.json') '{"build":999999,"version":"0.1.0"}'

$env:LKC_NO_RESTART = '1'
& cmd /c "`"$(Join-Path $ready 'apply-update.cmd')`" `"$installed`" `"$data`" < NUL"
if ($LASTEXITCODE -ne 0) { throw "apply-update.cmd failed with $LASTEXITCODE" }

if ((Get-Content (Join-Path $installed 'version.json') | ConvertFrom-Json).build -ne 999999) { throw 'version.json was not updated' }
if (-not (Test-Path (Join-Path $installed 'app\new-chunk.js'))) { throw 'new app files were not copied' }
if (Test-Path (Join-Path $installed 'app\old-chunk.js')) { throw 'old app files were not removed' }
if (-not (Test-Path (Join-Path $installed 'node\node.exe'))) { throw 'node.exe is missing after the update' }
if (-not (Test-Path (Join-Path $root 'installed\my-notes.txt'))) { throw 'a file outside the app folder was touched' }
if (Test-Path (Join-Path $data 'updates\ready')) { throw 'the downloaded update was not cleaned up' }
Write-Output 'Update installed over the installed copy: new files in, old app files out, everything else untouched.'

# Refuses a folder that is not LK Companion.
$other = Join-Path $root 'not-the-app'
New-Item -ItemType Directory -Force -Path $other, $ready | Out-Null
Copy-Item -Recurse -Force (Join-Path $Package '*') $ready
Set-Content (Join-Path $other 'precious.txt') 'keep'
& cmd /c "`"$(Join-Path $ready 'apply-update.cmd')`" `"$other`" `"$data`" < NUL"
if (-not (Test-Path (Join-Path $other 'precious.txt'))) { throw 'apply-update.cmd changed a folder that is not LK Companion' }
if (Test-Path (Join-Path $other 'launcher.mjs')) { throw 'apply-update.cmd copied into a folder that is not LK Companion' }
Write-Output 'A folder that is not LK Companion is refused.'
exit 0
