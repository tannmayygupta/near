# Re-records every end-to-end run on the CURRENT contract (public testnet, about an hour). The Ref testnet pool is open to anyone and each run sells NEAR into it,
# so the pool is restored to a market-like price before each run (scripts/dev/ref-rebalance.ts). Logs: data/secret/rerecord-<name>.log
$env:NODE_NO_WARNINGS = '1'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
foreach ($run in 'custody', 'restart', 'real', 'sealed') {
  npx tsx scripts/dev/ref-rebalance.ts 57 4.5 2>&1 | Out-Null
  "=== $run $(Get-Date -Format s)" | Tee-Object -FilePath "data/secret/rerecord-$run.log"
  npx tsx --env-file=.env "scripts/testnet/e2e-$run.ts" 2>&1 | Out-String | Add-Content -Path "data/secret/rerecord-$run.log" -Encoding utf8
  $tail = Get-Content "data/secret/rerecord-$run.log" | Select-String 'passed' | Select-Object -Last 1
  "$run -> $tail"
}
