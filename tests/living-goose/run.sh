#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
binary=$(mktemp /tmp/providence-living-goose.XXXXXX)
trap 'rm -f "$binary"' EXIT
swiftc -parse-as-library -strict-concurrency=complete \
  WatchStarter/ProvidenceFlowPresentation.swift tests/living-goose/main.swift -o "$binary"
"$binary"
