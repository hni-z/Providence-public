#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
swift build --package-path watch-coordinator-adapter
adapter_build=$(swift build --package-path watch-coordinator-adapter --show-bin-path)
routing_test_binary=$(mktemp /tmp/providence-task-routing.XXXXXX)
trap 'rm -f "$routing_test_binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors \
  -I "$adapter_build/Modules" \
  WatchStarter/MacControlModels.swift WatchStarter/TaskRoutePlanner.swift tests/task-routing/main.swift tests/task-routing/mirroring.swift \
  "$adapter_build"/WatchCoordinatorAdapter.build/*.swift.o \
  -o "$routing_test_binary"
"$routing_test_binary"
