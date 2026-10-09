#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
swift build --package-path watch-coordinator-adapter >/dev/null
binary=$(mktemp /tmp/providence-voice-output.XXXXXX)
trap 'rm -f "$binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete -warnings-as-errors \
  -I watch-coordinator-adapter/.build/debug/Modules \
  WatchStarter/VoiceOutputContracts.swift WatchStarter/VoiceAutomaticSpeechLedger.swift WatchStarter/TaskResultResolver.swift tests/voice-output/main.swift \
  watch-coordinator-adapter/.build/debug/WatchCoordinatorAdapter.build/*.swift.o -o "$binary"
"$binary"
