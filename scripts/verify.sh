#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'Usage: scripts/verify.sh MANIFEST.json DESTINATION_DIRECTORY\n' >&2
  exit 2
fi
MANIFEST="$1"
DEST_DIR="$2"

if [ ! -f "$MANIFEST" ] || [ ! -d "$DEST_DIR" ]; then
  printf 'Manifest or destination directory was not found.\n' >&2
  exit 2
fi

for command_name in jq sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required.\n' "$command_name" >&2
    exit 2
  fi
done

JOB_ID=$(jq -r '.jobId // empty' "$MANIFEST")
PREFIX=$(jq -r '.prefix // empty' "$MANIFEST")
if [ -z "$JOB_ID" ] || [ -z "$PREFIX" ] || [ "$PREFIX" != "jobs/$JOB_ID/" ]; then
  printf 'Manifest identity or prefix is invalid.\n' >&2
  exit 2
fi

MANIFEST_SHA=$(sha256sum "$MANIFEST" | awk '{print $1}')
FILES_CHECKED=0
BYTES_CHECKED=0
FAILED=0

while IFS="$(printf '\t')" read -r key expected_size expected_sha content_type; do
  FILES_CHECKED=$((FILES_CHECKED + 1))
  case "$key" in
    "$PREFIX"*) relative=$(printf '%s' "$key" | sed "s|^$PREFIX||") ;;
    *) FAILED=$((FAILED + 1)); continue ;;
  esac

  case "$relative" in
    ""|/*|*../*|../*|*/..) FAILED=$((FAILED + 1)); continue ;;
  esac

  file_path="$DEST_DIR/$relative"
  if [ ! -f "$file_path" ]; then
    FAILED=$((FAILED + 1))
    continue
  fi

  actual_size=$(wc -c < "$file_path" | tr -d ' ')
  actual_sha=$(sha256sum "$file_path" | awk '{print $1}')
  if [ "$actual_size" != "$expected_size" ] || [ "$actual_sha" != "$expected_sha" ]; then
    FAILED=$((FAILED + 1))
    continue
  fi
  BYTES_CHECKED=$((BYTES_CHECKED + actual_size))
done < <(jq -r '.files[] | [.key, (.size|tostring), .sha256, (.contentType // "")] | @tsv' "$MANIFEST")

printf '{"manifestSha256":"%s","filesChecked":%s,"bytesChecked":%s,"failed":%s}\n' \
  "$MANIFEST_SHA" "$FILES_CHECKED" "$BYTES_CHECKED" "$FAILED"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi