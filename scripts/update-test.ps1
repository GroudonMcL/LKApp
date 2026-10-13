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

# The real path, as when the app asks for a restart or you double-click "Start LK Companion" with
# an update waiting: the start script hands over to a copy of apply-update.cmd in %TEMP%, started
# in its own window. Spaces everywhere (app folder, data folder, TEMP) on purpose: cmd strips the
# outer quotes of a line it is given, which once broke this hand-over.
$real = Join-Path $root 'real path'
$app2 = Join-Path $real 'my apps\LK Companion'
$data2 = Join-Path $real 'my data'
$temp2 = Join-Path $real 'my temp'
$ready2 = Join-Path $data2 'updates\ready\LK Companion'
New-Item -ItemType Directory -Force -Path $app2, $ready2, $temp2 | Out-Null
Copy-Item -Recurse -Force (Join-Path $Package '*') $app2
Copy-Item -Recurse -Force (Join-Path $Package '*') $ready2
Set-Content (Join-Path $ready2 'app\new-chunk.js') 'new'
(Get-Content (Join-Path $ready2 'version.json') | ConvertFrom-Json | ForEach-Object { $_.build = 999999; $_ } | ConvertTo-Json) | Set-Content (Join-Path $ready2 'version.json')
Set-Content (Join-Path $data2 'updates\ready.json') '{"build":999999,"version":"0.1.0"}'
$env:LKC_HOME = $data2
$env:TEMP = $temp2
$env:TMP = $temp2
& cmd /c "`"$(Join-Path $app2 'Start LK Companion.cmd')`" < NUL"
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and (Test-Path (Join-Path $data2 'updates\ready'))) { Start-Sleep -Seconds 2 }
if ((Get-Content (Join-Path $app2 'version.json') | ConvertFrom-Json).build -ne 999999) { throw 'Start LK Companion did not install the waiting update (hand-over to apply-update.cmd failed)' }
if (-not (Test-Path (Join-Path $app2 'app\new-chunk.js'))) { throw 'new app files were not copied by the hand-over' }
Write-Output 'Start LK Companion installed the waiting update through its %TEMP% copy (paths with spaces).'

# A leftover update no newer than the installed copy is removed, never installed.
$own = (Get-Content (Join-Path $Package 'version.json') | ConvertFrom-Json).build
$app3 = Join-Path $real 'newer\LK Companion'
New-Item -ItemType Directory -Force -Path $app3, $ready2 | Out-Null
Copy-Item -Recurse -Force (Join-Path $Package '*') $app3
Copy-Item -Recurse -Force (Join-Path $Package '*') $ready2
(Get-Content (Join-Path $ready2 'version.json') | ConvertFrom-Json | ForEach-Object { $_.build = [Math]::Max(0, $own - 1); $_ } | ConvertTo-Json) | Set-Content (Join-Path $ready2 'version.json')
& (Join-Path $app3 'node\node.exe') (Join-Path $app3 'launcher.mjs') --pending-update
if ($LASTEXITCODE -ne 0) { throw "an older waiting update was offered for install (exit $LASTEXITCODE)" }
if (Test-Path (Join-Path $data2 'updates\ready')) { throw 'the older waiting update was not removed' }
if ((Get-Content (Join-Path $app3 'version.json') | ConvertFrom-Json).build -ne $own) { throw 'the installed copy changed' }
Write-Output 'An older waiting update is removed, not installed.'
exit 0
