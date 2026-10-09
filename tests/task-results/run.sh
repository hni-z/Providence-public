#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
swift build --package-path watch-coordinator-adapter >/dev/null
binary=$(mktemp /tmp/providence-task-results.XXXXXX)
trap 'rm -f "$binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors \
  -I watch-coordinator-adapter/.build/debug/Modules \
  WatchStarter/TaskResultResolver.swift tests/task-results/main.swift \
  watch-coordinator-adapter/.build/debug/WatchCoordinatorAdapter.build/*.swift.o -o "$binary"
"$binary"
