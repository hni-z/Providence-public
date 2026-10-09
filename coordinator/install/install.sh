#!/bin/sh
# Providence user-local bootstrap. No elevated privileges or shell configuration edits.
# Usage: curl --proto '=https' --tlsv1.2 -fsS https://providence.hani.so/install.sh | sh
# Add: | sh -s -- --configure-key to update a key without starting a companion.
# Advanced first setup: | sh -s -- --workspace-folder /absolute/folder
providence_install() (
  set -eu
  umask 077
  fail() { printf 'Providence: %s\n' "$*" >&2; exit 1; }
  mode=connect
  workspace_folder=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --configure-key) [ "$mode" = connect ] || fail 'Unexpected duplicate option.'; mode=key; shift ;;
      --workspace-folder)
        [ "$#" -ge 2 ] && [ -z "$workspace_folder" ] && [ -n "$2" ] || fail 'Use --workspace-folder with one absolute folder path.'
        workspace_folder=$2; shift 2 ;;
      *) fail 'Supported options: --configure-key or --workspace-folder PATH. Never put API keys in a command.' ;;
    esac
  done
  [ "$mode" != key ] || [ -z "$workspace_folder" ] || fail 'Folder selection is for computer setup; omit it with --configure-key.'
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This installer supports macOS and Linux. Windows uses install.ps1; iPhone, iPad, and Apple Watch need their native app.' ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; armv7*|armv6*) fail '32-bit ARM is unsupported. Use a 64-bit OS on Raspberry Pi.' ;; *) fail 'Unsupported processor. Use x64 or ARM64.' ;; esac
  if [ "$platform" = linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    fail 'This installer needs a glibc Linux distribution. Alpine/musl is not supported.'
  fi
  for tool in curl tar awk sed mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Required system tool is missing: $tool"; done
  if command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | awk '{print $1}'; }
  else fail 'A SHA-256 verifier (shasum or sha256sum) is required.'; fi
  [ -n "${HOME-}" ] && [ -d "$HOME" ] || fail 'Your home directory could not be located.'
  root="$HOME/.providence/installation"
  for path in "$HOME/.providence" "$root" "$root/releases" "$root/runtimes"; do
    [ ! -L "$path" ] || fail "Refusing a symbolic-link install directory: $path"
    [ ! -e "$path" ] || [ -d "$path" ] || fail "Install path is not a directory: $path"
    mkdir -p "$path"
    chmod 700 "$path"
  done
  [ ! -e "$root/.uninstall-lock" ] || fail 'An uninstall is active or needs attention. Check its completion before reinstalling.'
  mkdir "$root/.install-lock" 2>/dev/null || fail "Another install is active, or an interrupted install left $root/.install-lock. Check it before retrying."
  stage=''
  cleanup() { [ -z "$stage" ] || rm -rf "$stage"; rmdir "$root/.install-lock" 2>/dev/null || :; }
  trap cleanup 0
  trap 'exit 130' INT TERM HUP
  [ ! -e "$root/.uninstall-lock" ] || fail 'An uninstall started concurrently. Nothing was downloaded or activated.'
  stage=$(mktemp -d "$root/.install.XXXXXXXX")
  download() {
    status=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 20 --max-time 600 --max-filesize "$3" --output "$2" --write-out '%{http_code}' "$1") || fail 'A required HTTPS download failed. Setup stopped before starting Providence.'
    [ "$status" = 200 ] || fail 'A download returned a redirect or an unexpected response.'
  }
  download 'https://providence.hani.so/downloads/companion-manifest.json' "$stage/manifest.json" 65536
  # Read only a fixed-format digest before Node is available. It must also match
  # the separately pinned official Node checksum below; arbitrary URLs are never read.
  node_hash=$(sed -n "s/^  \"node_${platform}_${arch}_sha256\": \"\([a-f0-9]*\)\",\{0,1\}$/\1/p" "$stage/manifest.json")
  case "$platform-$arch" in
    darwin-arm64) expected_node_hash=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
    darwin-x64) expected_node_hash=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
    linux-arm64) expected_node_hash=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
    linux-x64) expected_node_hash=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
  esac
  [ "$node_hash" = "$expected_node_hash" ] || fail 'The manifest does not match the pinned Node runtime.'
  runtime_name="node-v22.23.3-$platform-$arch"
  runtime="$root/runtimes/$runtime_name"
  if [ -e "$runtime" ] || [ -L "$runtime" ]; then
    [ ! -L "$runtime" ] && [ -f "$runtime/.providence-archive-sha256" ] && [ "$(cat "$runtime/.providence-archive-sha256")" = "$node_hash" ] || fail "Existing runtime is unrecognized and was left untouched: $runtime"
  else
    printf 'Installing private Node.js 22.23.3 for %s %s…\n' "$platform" "$arch"
    download "https://nodejs.org/dist/v22.23.3/$runtime_name.tar.gz" "$stage/node.tar.gz" 150000000
    [ "$(sha256 "$stage/node.tar.gz")" = "$node_hash" ] || fail 'Node archive checksum mismatch. Nothing was extracted.'
    tar -xzf "$stage/node.tar.gz" -C "$stage"
    [ -x "$stage/$runtime_name/bin/node" ] || fail 'The pinned Node archive is incomplete.'
    printf '%s\n' "$node_hash" > "$stage/$runtime_name/.providence-archive-sha256"
    mv "$stage/$runtime_name" "$runtime"
  fi
  node="$runtime/bin/node"
  npm_cli="$runtime/lib/node_modules/npm/bin/npm-cli.js"
  [ "$("$node" -p 'process.versions.node')" = 22.23.3 ] || fail 'The private Node runtime cannot run on this OS. Node 22 needs macOS 11+ or compatible glibc Linux.'
  PATH="$runtime/bin:$PATH"
  export PATH
  "$node" --input-type=module - "$stage/manifest.json" > "$stage/verified-fields" <<'PROVIDENCE_MANIFEST'
import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const hash = /^[a-f0-9]{64}$/;
if (m.schemaVersion !== 1 || m.nodeVersion !== '22.23.3' || m.codexVersion !== '0.157.1' || !hash.test(m.version ?? '') || !hash.test(m.archiveZipSha256 ?? '') || !hash.test(m.archiveTarGzSha256 ?? '')) throw new Error('Invalid install manifest.');
const base = `https://providence.hani.so/downloads/${m.version}/providence-companion`;
if (m.archiveZipUrl !== base + '.zip' || m.archiveTarGzUrl !== base + '.tar.gz') throw new Error('Untrusted archive location.');
console.log(m.version); console.log(m.archiveTarGzUrl); console.log(m.archiveTarGzSha256);
PROVIDENCE_MANIFEST
  release_version=$(sed -n '1p' "$stage/verified-fields")
  archive_url=$(sed -n '2p' "$stage/verified-fields")
  archive_hash=$(sed -n '3p' "$stage/verified-fields")
  release="$root/releases/$release_version"
  if [ -e "$release" ] || [ -L "$release" ]; then
    [ ! -L "$release" ] && [ -f "$release/.providence-archive-sha256" ] && [ "$(cat "$release/.providence-archive-sha256")" = "$archive_hash" ] && [ -f "$release/coordinator/scripts/connect.mjs" ] || fail "Existing release is incomplete or unrecognized and was left untouched: $release"
    printf 'Providence is already downloaded. Resuming this computer’s setup…\n'
  else
    printf 'Downloading and verifying Providence…\n'
    download "$archive_url" "$stage/companion.tar.gz" 20000000
    [ "$(sha256 "$stage/companion.tar.gz")" = "$archive_hash" ] || fail 'Companion archive checksum mismatch. Nothing was extracted.'
    tar -tzf "$stage/companion.tar.gz" > "$stage/archive-files"
    awk 'BEGIN { n=0 } !/^providence-companion\/[A-Za-z0-9_.\/-]+$/ || /(^|\/)\.\.(\/|$)/ { exit 1 } { n++ } END { if (!n) exit 1 }' "$stage/archive-files" || fail 'The archive contains an unsafe path.'
    tar -tvzf "$stage/companion.tar.gz" > "$stage/archive-types"
    awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { exit 1 }' "$stage/archive-types" || fail 'Links and special files are not allowed in a companion archive.'
    tar -xzf "$stage/companion.tar.gz" -C "$stage"
    source="$stage/providence-companion"
    [ -f "$source/coordinator/scripts/connect.mjs" ] && [ -f "$source/coordinator/package-lock.json" ] && [ -f "$source/coordinator/install/prepare-codex.mjs" ] || fail 'The companion archive is incomplete.'
    (cd "$source/coordinator" && "$node" "$npm_cli" ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund --update-notifier=false --registry=https://registry.npmjs.org --cache "$source/coordinator/.npm-cache")
    printf '%s\n' "$archive_hash" > "$source/.providence-archive-sha256"
    cp "$stage/manifest.json" "$source/.providence-manifest.json"
    mv "$source" "$release"
  fi
  "$node" "$release/coordinator/install/uninstall.mjs" --register > /dev/null
  if [ "$mode" = connect ]; then
    printf 'Checking the installed Codex runtime…\n'
    CODEX_BIN=$("$node" "$release/coordinator/install/prepare-codex.mjs" "$root/runtimes" "$npm_cli")
    export CODEX_BIN
    "$node" "$release/coordinator/install/uninstall.mjs" --register > /dev/null
  fi
  cleanup
  stage=''
  trap - 0 INT TERM HUP
  cd "$release/coordinator"
  # The script may arrive over a pipe. Prompts and hidden key input need the TTY.
  [ -r /dev/tty ] || fail 'Run this command in an interactive terminal.'
  if [ "$mode" = key ]; then
    exec "$node" scripts/connect.mjs --configure-key < /dev/tty
  elif [ -n "$workspace_folder" ]; then
    exec "$node" scripts/connect.mjs --full-access --workspace-folder "$workspace_folder" < /dev/tty
  else
    exec "$node" scripts/connect.mjs --full-access < /dev/tty
  fi
)
providence_install "$@"
