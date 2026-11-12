param([switch]$WorkerOnly)
# Starts the worker API (EXEC_MODE=simulated, public testnet) and the dashboard locally. Secrets are read from git-ignored data/secret + .env, never printed.
$root = Resolve-Path "$PSScriptRoot\..\.."
Set-Location $root
$pub  = Get-Content data\testnet-public.json -Raw | ConvertFrom-Json
$named = (Get-Content data\secret\testnet-named.json -Raw | ConvertFrom-Json)
$envf = @{}
Get-Content .env | ForEach-Object { $l = $_.TrimStart([char]0xFEFF); if ($l -match '^([A-Z_]+)=(.*)$') { $envf[$matches[1]] = $matches[2].Trim() } }

$agentKey = $named.agentowner.secretKey
$wenv = @{
  NEAR_NETWORK = 'testnet'; EXEC_MODE = 'simulated'; SIM_AUTOFUND = '1'; PORT = '8787'
  DAO_ACCOUNT = $pub.dao; MANDATE_CONTRACT = $pub.mandateContract
  AGENT_ACCOUNT_ID = $pub.agent; AGENT_SECRET_KEY = $agentKey
  SIM_QUOTE_RECIPIENT = '0x1111111111111111111111111111111111111111'
  SEALED_TERMS_KEY = ('ab' * 32); STATE_DB = 'data/worker-dev.sqlite'
  NEAR_AI_API_KEY = $envf['NEAR_AI_API_KEY']
  NEAR_TESTNET_RPC = $pub.rpc; MANDATE_FROM_ID = '7'
}
foreach ($k in $wenv.Keys) { Set-Item -Path "env:$k" -Value $wenv[$k] }
$w = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx","worker/index.ts" -PassThru -WindowStyle Hidden -RedirectStandardOutput "data\worker-dev.out.log" -RedirectStandardError "data\worker-dev.err.log"
"worker PID $($w.Id)"

if ($WorkerOnly) { return }
$env:NEXT_PUBLIC_WORKER_API = 'http://localhost:8787'
$env:NEXT_PUBLIC_NEAR_NETWORK = 'testnet'
$env:NEXT_PUBLIC_DAO_ACCOUNT = $pub.dao
$env:NEXT_PUBLIC_MANDATE_CONTRACT = $pub.mandateContract
$env:NEXT_PUBLIC_AGENT_ACCOUNT = $pub.agent
$env:NEXT_PUBLIC_NEAR_RPC = $pub.rpc
Set-Location app
$a = Start-Process -FilePath "npx.cmd" -ArgumentList "next","dev","-p","3100" -PassThru -WindowStyle Hidden -RedirectStandardOutput "..\data\app-dev.out.log" -RedirectStandardError "..\data\app-dev.err.log"
"app PID $($a.Id)"
