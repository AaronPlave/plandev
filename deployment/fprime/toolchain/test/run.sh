#!/bin/sh
# Run the toolchain regression tests against an image (default: plandev-fprime-toolchain:dev).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
image=${1:-plandev-fprime-toolchain:dev}
docker run --rm --network none --user 20000:20000 \
  -v "$here":/tests:ro \
  -v "$repo/sequencing-server/plugins/fprime-dictionary-parser/test/dictionary":/dictionaries:ro \
  -e FPRIME_WASM_VERSION=0.1.10 \
  "$image" sh /tests/smoke.sh
docker run --rm --network none -v "$here/..":/toolchain:ro -w /toolchain "$image" python3 -m unittest -q test.test_server
