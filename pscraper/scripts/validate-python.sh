#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ARCHIVE="$(mktemp)"
SOURCE_DIR="$(mktemp -d)"
trap 'rm -rf "${ARCHIVE}" "${SOURCE_DIR}"' EXIT

shopt -s nullglob
PARTS=("${PROJECT_DIR}"/python/archive-parts/scraper-image-only.zip.b64.*)
if [[ ${#PARTS[@]} -eq 0 ]]; then
  echo "No embedded Python archive fragments were found." >&2
  exit 1
fi

cat "${PARTS[@]}" | base64 --decode > "${ARCHIVE}"
unzip -t "${ARCHIVE}"
unzip -q "${ARCHIVE}" -d "${SOURCE_DIR}"

if [[ ! -d "${SOURCE_DIR}/scraper" ]]; then
  echo "The archive does not contain the expected scraper/ package." >&2
  exit 1
fi

python -m compileall -q "${SOURCE_DIR}/scraper"
PYTHONPATH="${SOURCE_DIR}" python -m unittest discover \
  -s "${PROJECT_DIR}/tests" -v
