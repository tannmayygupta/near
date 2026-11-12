# Builds the static GitHub Pages export locally exactly like CI does (no worker URL, public testnet ids only)
# and lays it out under a /near sub-path in a temp folder so it can be served with `npx serve <folder> -l 5050`.
# Usage (from app/): powershell -File scripts/export-static.ps1 -Out C:\temp\site
param([string]$Out = (Join-Path ([IO.Path]::GetTempPath()) 'qt-site'), [string]$Base = '/near')
$ErrorActionPreference = 'Stop'
$app = Resolve-Path "$PSScriptRoot\.."
Set-Location $app
$c = Get-Content ..\data\testnet-public.json -Raw | ConvertFrom-Json
$moved = $null
if (Test-Path .env.local) { $moved = Join-Path ([IO.Path]::GetTempPath()) 'qt-env.local.bak'; Move-Item .env.local $moved -Force } # a local worker URL must not leak into the export
try {
  $env:STATIC_EXPORT = '1'; $env:NEXT_PUBLIC_STATIC_DEMO = '1'; $env:NEXT_PUBLIC_BASE_PATH = $Base; $env:NEXT_PUBLIC_NEAR_NETWORK = 'testnet'
  $env:NEXT_PUBLIC_DAO = $c.dao; $env:NEXT_PUBLIC_MANDATE_CONTRACT = $c.mandateContract; $env:NEXT_PUBLIC_AGENT_ACCOUNT = $c.agent
  $env:NEXT_PUBLIC_VAULT_ACCOUNT = $c.vault; $env:NEXT_PUBLIC_NEAR_RPC = $c.rpc
  Remove-Item Env:NEXT_PUBLIC_WORKER_API -ErrorAction SilentlyContinue
  if (Test-Path out) { Remove-Item out -Recurse -Force }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
} finally {
  if ($moved -and (Test-Path $moved)) { Move-Item $moved .env.local -Force }
  foreach ($k in 'STATIC_EXPORT','NEXT_PUBLIC_STATIC_DEMO','NEXT_PUBLIC_BASE_PATH') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
}
$dst = Join-Path $Out $Base.TrimStart('/')
if (Test-Path $dst) { Get-ChildItem $dst -Force | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force } } else { New-Item -ItemType Directory -Force $dst | Out-Null }
Copy-Item -Path "out\*" -Destination $dst -Recurse -Force
New-Item -ItemType File -Path (Join-Path $dst '.nojekyll') -Force | Out-Null
"static site ready: $dst  (serve with: npx serve `"$Out`" -l 5050 --no-clipboard, open http://localhost:5050$Base/)"
