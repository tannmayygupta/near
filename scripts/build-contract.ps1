# Builds + tests the mandate contract inside a pinned Docker image (no local Rust needed) and writes contracts/mandate/out/mandate.wasm.
# The image tag is pinned (near-sdk 5.30 needs rustc >= 1.95); the build copies the sources to a temp directory so nothing but the wasm and Cargo.lock is written back.
# Prints the wasm's sha256 and the NEAR code hash (base58 of sha256) so it can be compared with the deployed contract: npm run verify:contract
param([string]$Image = "rust:1.99.1-bookworm")
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$src = Join-Path $root "contracts\mandate"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("qt-build-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
Copy-Item "$src\*" $tmp -Recurse -Exclude out, target
New-Item -ItemType Directory -Force (Join-Path $tmp "out") | Out-Null
docker volume create qt-cargo-reg2 | Out-Null
docker volume create qt-target-v2 | Out-Null
try {
  docker run --rm -v "${tmp}:/work" -v qt-target-v2:/work/target -v qt-cargo-reg2:/usr/local/cargo/registry -w /work $Image bash -c "rustup target add wasm32-unknown-unknown >/dev/null 2>&1 && cargo test --release 2>&1 | grep -E 'test result|FAILED|panicked' ; cargo test --release --features migrate 2>&1 | grep -E 'test result|FAILED|panicked'; cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -3 && cp target/wasm32-unknown-unknown/release/mandate.wasm out/mandate.wasm && ls -l out"
  New-Item -ItemType Directory -Force (Join-Path $src "out") | Out-Null
  Copy-Item (Join-Path $tmp "out\mandate.wasm") (Join-Path $src "out\mandate.wasm") -Force
  Copy-Item (Join-Path $tmp "Cargo.lock") (Join-Path $src "Cargo.lock") -Force
  $h = (Get-FileHash (Join-Path $src "out\mandate.wasm") -Algorithm SHA256).Hash.ToLower()
  Write-Host "mandate.wasm sha256 $h"
  Write-Host "compare with the chain: npm run verify:contract (prints the base58 code hash)"
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
