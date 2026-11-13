# Clean-clone check (PLAN gate G9): clone the COMMITTED repo into a new empty temp dir, install, test, verify, build the dashboard.
# Only committed files are tested - commit your work first. Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\clean-clone-check.ps1 [-KeepDir]
param([switch]$KeepDir)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("qt-clean-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$results = New-Object System.Collections.Generic.List[object]
function Step([string]$name, [scriptblock]$body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = ""
  try { $out = (& $body 2>&1 | Out-String); $ok = ($LASTEXITCODE -eq 0) } catch { $out = $_.Exception.Message; $ok = $false }
  $results.Add([pscustomobject]@{ Step = $name; Result = $(if ($ok) { "PASS" } else { "FAIL" }); Seconds = [int]$sw.Elapsed.TotalSeconds })
  if (-not $ok) { Write-Host "--- $name output (tail) ---"; ($out -split "`n" | Select-Object -Last 25) -join "`n" | Write-Host }
  return $out
}

Step "git clone (local, committed files only)" { git clone --quiet --local $repo $tmp } | Out-Null
Set-Location $tmp
Step "npm ci (root)" { npm ci --no-audit --no-fund } | Out-Null
$t = Step "npm test" { npm test }
if ($t -match "Tests\s+(\d+) passed") { Write-Host "  vitest: $($Matches[0])" }
Step "npm run verify (three recorded proof bundles)" { npm run verify } | Out-Null
Step "npm run secret-scan" { npm run secret-scan } | Out-Null
Step "worker boots and answers /health (simulated mode, scratch env)" {
  $env:NEAR_NETWORK = 'testnet'; $env:EXEC_MODE = 'simulated'; $env:PORT = '8791'
  $pub = Get-Content data\testnet-public.json -Raw | ConvertFrom-Json
  $env:DAO_ACCOUNT = $pub.dao; $env:MANDATE_CONTRACT = $pub.mandateContract; $env:AGENT_ACCOUNT_ID = $pub.agent
  # throwaway key: the worker only reads chain state while idle; it never signs without an approved mandate
  $env:AGENT_SECRET_KEY = (node -e "import('near-api-js').then(m=>console.log(m.KeyPair.fromRandom('ed25519').toString()))").Trim()
  $env:SIM_QUOTE_RECIPIENT = '0x1111111111111111111111111111111111111111'; $env:SEALED_TERMS_KEY = ('cd' * 32)
  $env:STATE_DB = Join-Path $tmp 'check.sqlite'; $env:NEAR_TESTNET_RPC = $pub.rpc; $env:MANDATE_FROM_ID = '9999'
  $p = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "worker/index.ts" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $tmp 'w.out') -RedirectStandardError (Join-Path $tmp 'w.err')
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) { Start-Sleep 1; try { $h = Invoke-RestMethod http://127.0.0.1:8791/health -TimeoutSec 3; if ($h.ok) { $ok = $true } } catch {} }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'worker.index.ts' -and $_.CommandLine -match [regex]::Escape($tmp) -or $_.ProcessId -eq $p.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($ok) { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1; Get-Content (Join-Path $tmp 'w.err') -Tail 8 }
} | Out-Null
Set-Location (Join-Path $tmp "app")
Step "npm ci (app)" { npm ci --no-audit --no-fund } | Out-Null
Step "next build (app)" { npm run build } | Out-Null
Set-Location $repo

Write-Host "`n=== CLEAN-CLONE CHECK ($tmp) ==="
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object { $_.Result -eq "FAIL" }).Count
if (-not $KeepDir) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } else { Write-Host "kept: $tmp" }
if ($failed -gt 0) { Write-Host "RESULT: FAIL ($failed step(s))"; exit 1 } else { Write-Host "RESULT: PASS"; exit 0 }
