#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
recovery_build=$(mktemp -d /tmp/providence-transcription-recovery.XXXXXX)
trap 'rm -rf "$recovery_build"' EXIT
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors -emit-library -emit-module \
  -module-name WatchCoordinatorAdapter \
  watch-coordinator-adapter/Sources/WatchCoordinatorAdapter/*.swift \
  -emit-module-path "$recovery_build/WatchCoordinatorAdapter.swiftmodule" \
  -o "$recovery_build/libWatchCoordinatorAdapter.dylib"
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors \
  -I "$recovery_build" -L "$recovery_build" -lWatchCoordinatorAdapter \
  -Xlinker -rpath -Xlinker "$recovery_build" \
  WatchStarter/VoiceTranscriptionSession.swift tests/transcription-recovery/main.swift \
  -o "$recovery_build/recovery-tests"
"$recovery_build/recovery-tests"
