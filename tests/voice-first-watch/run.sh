#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
voice_test_binary=$(mktemp /tmp/providence-voice-contracts.XXXXXX)
trap 'rm -f "$voice_test_binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete \
  WatchStarter/AssistantModels.swift WatchStarter/VoiceContracts.swift \
  tests/voice-first-watch/main.swift -o "$voice_test_binary"
"$voice_test_binary"
