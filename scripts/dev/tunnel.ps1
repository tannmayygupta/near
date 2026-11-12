# Free Cloudflare "quick tunnel" for a temporary public demo of the LOCAL worker (8787) and dashboard (3100). No login, no account.
# Links change on every start; the PC must stay awake. Start the stack first: scripts\dev\start-testnet.ps1
# WARNING: the public worker URL exposes /api/parse, which spends your NEAR AI credits. Stop the tunnels when not demoing (command printed at the end).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\tunnel.ps1 [-RestartDashboard]
param([switch]$RestartDashboard, [int]$WorkerPort = 8787, [int]$AppPort = 3100)
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cf)) { Write-Error "cloudflared not found at $cf"; exit 1 }
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
New-Item -ItemType Directory -Force data | Out-Null

function Test-Port($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Start-Tunnel([int]$port, [string]$name) {
  $err = Join-Path $root "data\tunnel-$name.err.log"; Remove-Item $err -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $cf -ArgumentList "tunnel", "--url", "http://localhost:$port", "--no-autoupdate" -PassThru -WindowStyle Hidden `
       -RedirectStandardError $err -RedirectStandardOutput (Join-Path $root "data\tunnel-$name.out.log")
  $url = $null
  for ($i = 0; $i -lt 45 -and -not $url; $i++) {
    Start-Sleep 1
    if (Test-Path $err) { $m = Select-String -Path $err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
  }
  [pscustomobject]@{ Name = $name; Pid = $p.Id; Url = $url }
}

if (-not (Test-Port $WorkerPort)) { Write-Error "nothing listening on $WorkerPort - start scripts\dev\start-testnet.ps1 first"; exit 1 }
$worker = Start-Tunnel $WorkerPort "worker"
if (-not $worker.Url) { Write-Error "worker tunnel did not print a URL (see data\tunnel-worker.err.log)"; exit 1 }

if ($RestartDashboard) {
  # NEXT_PUBLIC_* is inlined by Next.js: restart the dashboard so browsers on the internet call the worker tunnel, not localhost.
  Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  $pub = Get-Content (Join-Path $root "data\testnet-public.json") -Raw | ConvertFrom-Json
  $env:NEXT_PUBLIC_WORKER_API = $worker.Url
  $env:NEXT_PUBLIC_NEAR_NETWORK = 'testnet'; $env:NEXT_PUBLIC_NEAR_RPC = $pub.rpc
  $env:NEXT_PUBLIC_DAO = $pub.dao; $env:NEXT_PUBLIC_DAO_ACCOUNT = $pub.dao
  $env:NEXT_PUBLIC_MANDATE_CONTRACT = $pub.mandateContract; $env:NEXT_PUBLIC_AGENT_ACCOUNT = $pub.agent
  Start-Process -FilePath "npx.cmd" -ArgumentList "next", "dev", "-p", "$AppPort" -WorkingDirectory (Join-Path $root "app") -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $root "data\app-dev.out.log") -RedirectStandardError (Join-Path $root "data\app-dev.err.log") | Out-Null
  for ($i = 0; $i -lt 60 -and -not (Test-Port $AppPort); $i++) { Start-Sleep 1 }
}
if (-not (Test-Port $AppPort)) { Write-Error "nothing listening on $AppPort - start the dashboard (or use -RestartDashboard)"; exit 1 }
$app = Start-Tunnel $AppPort "dashboard"

"{0} {1}" -f $worker.Pid, $app.Pid | Set-Content (Join-Path $root "data\tunnel.pids")
Write-Host ""
Write-Host "Worker API : $($worker.Url)   (check: $($worker.Url)/health)"
Write-Host "Dashboard  : $($app.Url)"
if (-not $RestartDashboard) { Write-Host "NOTE: without -RestartDashboard the dashboard still calls http://localhost:$WorkerPort, so remote visitors see worker errors." }
Write-Host "Stop       : Stop-Process -Id $($worker.Pid),$($app.Pid) -Force"
