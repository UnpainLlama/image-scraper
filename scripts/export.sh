#!/usr/bin/env bash
set -euo pipefail

for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET JOB_ID DEST_DIR; do
  if [ -z "$(printenv "$name" || true)" ]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
done

if ! command -v rclone >/dev/null 2>&1; then
  printf 'rclone is required. Install it from https://rclone.org/install/\n' >&2
  exit 2
fi

REMOTE=":s3:$R2_BUCKET/jobs/$JOB_ID"
ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
mkdir -p "$DEST_DIR"

rclone copy "$REMOTE" "$DEST_DIR" \
  --s3-provider Cloudflare \
  --s3-endpoint "$ENDPOINT" \
  --s3-access-key-id "$R2_ACCESS_KEY_ID" \
  --s3-secret-access-key "$R2_SECRET_ACCESS_KEY" \
  --s3-no-check-bucket \
  --fast-list \
  --transfers 8 \
  --checkers 16

printf 'Export copied to: %s\n' "$DEST_DIR"
printf 'Next: run scripts/verify.sh MANIFEST.json DEST_DIR > verification-report.json\n'