#!/bin/sh
# Toolchain regression tests; run inside the image by ./run.sh (offline, unprivileged).
set -eu
# F Prime v4.2.0 Math deployment: has Svc.FileManager.ShellCommand(command, logFileName).
DICT=/dictionaries/MathDeploymentTopologyDictionary.json
export HOME=/tmp/home CARGO_HOME=/tmp/home/cargo CARGO_TARGET_DIR=/tmp/home/target
mkdir -p "$CARGO_HOME"
cd /tmp

echo "== fprime-wasm init (offline, vendored crates)"
fprime-wasm init seqs --name seqs --dictionary "$DICT" >/dev/null
cd seqs
cp /opt/fprime/profiles/profile_*.toml .
cat > src/bin/startup.rs <<'RS'
#![no_std]
#![no_main]
use seqs::*;
#[fprime_main(restrict)]
pub fn main() {
    // Svc.FileManager.ShellCommand has an argument named `command`: fprime_macros 0.1.10 fails on it.
    FileHandling.fileManager.ShellCommand("ls", "/tmp/out");
    CdhCore.cmdDisp.CMD_NO_OP();
}
RS

echo "== upstream fprime_macros $FPRIME_WASM_VERSION (unpatched) reproduces the bug"
mkdir -p /tmp/unpatched && cp -r . /tmp/unpatched/seqs && cd /tmp/unpatched/seqs
printf '\n[patch.crates-io]\nfprime_macros = { path = "/opt/fprime/vendor/fprime_macros-%s" }\n' "$FPRIME_WASM_VERSION" >> .cargo/config.toml
if fprime-wasm build -- --bin startup > /tmp/unpatched.log 2>&1; then
  echo "FAIL: the unpatched release built; drop the patch (see deployment/fprime/README.md)"; exit 1
fi
grep -q "command" /tmp/unpatched.log && grep -E "^error" /tmp/unpatched.log | head -3
cd /tmp/seqs

echo "== patched build + verify"
fprime-wasm build -- --bin startup >/tmp/build.log 2>&1 || { cat /tmp/build.log; exit 1; }
fprime-wasm verify --no-build --json | grep -q '"passed": *true' || { fprime-wasm verify --no-build; exit 1; }
ls -l "$CARGO_TARGET_DIR/wasm32v1-none/release/startup.wasm"

echo "== restriction profile is enforced by the build"
sed -i 's/CdhCore.cmdDisp.CMD_NO_OP();/loop { CdhCore.cmdDisp.CMD_NO_OP(); }/' src/bin/startup.rs
if fprime-wasm build -- --bin startup > /tmp/profile.log 2>&1; then echo "FAIL: loop accepted in restrict mode"; exit 1; fi
grep -m1 -i "restrict" /tmp/profile.log

echo "== fprime-seqgen"
printf 'R00:00:00 CdhCore.cmdDisp.CMD_NO_OP\nR00:00:01 CdhCore.cmdDisp.CMD_NO_OP_STRING "hello"\n' > /tmp/ok.seq
fprime-seqgen --dictionary "$DICT" /tmp/ok.seq /tmp/ok.bin >/dev/null && test -s /tmp/ok.bin && ls -l /tmp/ok.bin

echo "OK"
