# Builds + tests the mandate contract inside Docker (no local Rust needed).
# Output: contracts/mandate/out/mandate.wasm
param([string]$Image = "rust:1.99.1-bookworm")
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$src = Join-Path $root "contracts\mandate"
New-Item -ItemType Directory -Force (Join-Path $src "out") | Out-Null
docker volume create qt-cargo-cache | Out-Null
docker run --rm -v "${src}:/work" -v qt-cargo-cache:/usr/local/cargo/registry -v qt-target-cache:/work/target -w /work $Image bash -c "rustup target add wasm32-unknown-unknown >/dev/null 2>&1 && cargo test --release 2>&1 | tail -40 && cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -15 && cp target/wasm32-unknown-unknown/release/mandate.wasm out/mandate.wasm && ls -l out"
