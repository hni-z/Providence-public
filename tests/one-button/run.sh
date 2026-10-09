#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
swift build --package-path watch-coordinator-adapter >/dev/null
binary=$(mktemp /tmp/providence-one-button-contracts.XXXXXX)
trap 'rm -f "$binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete \
  -I watch-coordinator-adapter/.build/debug/Modules \
  WatchStarter/VoiceCaptureLifecycle.swift WatchStarter/GooseInteraction.swift WatchStarter/MacControlModels.swift tests/one-button/main.swift \
  watch-coordinator-adapter/.build/debug/WatchCoordinatorAdapter.build/*.swift.o -o "$binary"
"$binary"
