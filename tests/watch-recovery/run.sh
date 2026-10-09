#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
build_dir=$(mktemp -d /tmp/providence-watch-recovery.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors -emit-library -emit-module \
  -module-name WatchCoordinatorAdapter watch-coordinator-adapter/Sources/WatchCoordinatorAdapter/*.swift \
  -emit-module-path "$build_dir/WatchCoordinatorAdapter.swiftmodule" -o "$build_dir/libWatchCoordinatorAdapter.dylib"
swiftc -D DEBUG -parse-as-library -strict-concurrency=complete -warnings-as-errors \
  -I "$build_dir" -L "$build_dir" -lWatchCoordinatorAdapter -Xlinker -rpath -Xlinker "$build_dir" \
  WatchStarter/MacControlKeychain.swift WatchStarter/MacControlPairing.swift WatchStarter/VoiceTranscriptionSession.swift \
  WatchStarter/MacControlModel.swift WatchStarter/MacControlModels.swift WatchStarter/TaskRoutePlanner.swift \
  WatchStarter/TaskResultResolver.swift WatchStarter/WatchRecoveryPresentation.swift tests/watch-recovery/main.swift tests/watch-recovery/delegated.swift tests/watch-recovery/mirroring.swift \
  -o "$build_dir/watch-recovery-tests"
"$build_dir/watch-recovery-tests"
