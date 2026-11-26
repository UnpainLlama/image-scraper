#!/bin/sh
set -eu

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

# Mount the existing image-scraper bucket, but keep this Python service isolated
# under its own prefix so it cannot overwrite the TypeScript app's jobs/ objects.
mkdir -p /mnt/r2 /mnt/r2/pscraper
/usr/local/bin/tigrisfs \
  --endpoint "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --region auto \
  -f "${R2_BUCKET_NAME}" /mnt/r2 &
fuse_pid=$!
server_pid=""
cleanup() {
  if [ -n "${server_pid}" ]; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  fusermount -u /mnt/r2 2>/dev/null || true
  kill "${fuse_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

attempt=0
until mountpoint -q /mnt/r2; do
  if ! kill -0 "${fuse_pid}" 2>/dev/null; then
    echo "R2 mount process exited before mounting" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 30 ]; then
    echo "Timed out waiting for the R2 mount" >&2
    exit 1
  fi
  sleep 1
done

export PSCRAPER_DOWNLOAD_DIR=/mnt/r2/pscraper
export PSCRAPER_STORAGE_BACKEND=r2
uvicorn server:app --host 0.0.0.0 --port 8080 --proxy-headers --no-access-log &
server_pid=$!
wait "${server_pid}"
