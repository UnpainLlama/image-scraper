# pscraper

Private, image-only hosted version of the original Python scraper. **The scraping code remains Python**; the browser streams the real CLI prompts and output instead of reimplementing the workflow in TypeScript.

## Layout

- `python/archive-parts/` — cleaned Python source archive, stored as ordered Base64 text fragments. The Docker build reconstructs and extracts it.
- `container/` — Linux container API server and startup script. FastAPI starts the original CLI as a child process and forwards terminal input/output over a WebSocket.
- `worker/` — Cloudflare Worker password authentication and Durable Object container routing.
- `web/` — password-only unlock screen and terminal UI based on the supplied Termux screenshots.
- `Dockerfile` — CPython 3.13 Linux image, dependencies and R2 FUSE mount.

The existing root TypeScript scraper is untouched.

## Image-only behavior

Retained image adapters: Sex.com, Rule34, Realbooru, EliteBabes, Buondua and generic static image pages. Pornhub and the video downloader are excluded. Video sources are skipped.

## Local checks

Run from this directory:

```sh
archive="$(mktemp)"
tmpdir="$(mktemp -d)"
cat python/archive-parts/scraper-image-only.zip.b64.* | base64 -d > "$archive"
unzip -t "$archive"
unzip -q "$archive" -d "$tmpdir"
PYTHONPATH="$tmpdir" python -m compileall -q "$tmpdir/scraper"
PYTHONPATH="$tmpdir" python -m unittest discover -s tests -v
rm -rf "$tmpdir" "$archive"
npm install
npm run typecheck
```

A Docker daemon is required to build the container locally.

## Cloudflare prerequisites

This requires Cloudflare Workers Paid with Containers enabled. Create a private R2 bucket named `pscraper-storage` (or change `R2_BUCKET_NAME`) and an R2 S3 API token with read/write access only to that bucket.

Configure:
- Worker secret `APP_PASSWORD`: unique passphrase, at least 15 characters.
- Worker secret `SESSION_SECRET`: at least 32 random characters.
- Worker variable `R2_ACCOUNT_ID`: Cloudflare account ID (**not a secret**).
- Worker secret `AWS_ACCESS_KEY_ID`: R2 access key ID.
- Worker secret `AWS_SECRET_ACCESS_KEY`: R2 secret access key.

Never commit `.dev.vars` or credentials. Use `.dev.vars.example` only for variable names.

## Session behavior and limitations

- One interactive terminal session at a time.
- Browser disconnect stops the active CLI process; it is not left running unattended.
- Downloaded files and metadata are written to `/mnt/pscraper`, mounted to R2 with TigrisFS.
- R2 is object storage behind FUSE, not local SSD; performance and filesystem behavior must be checked in a Cloudflare integration test.
- Tor is not started in the container and remains unavailable in this first hosted build.
- `Ctrl+C` interrupts, `Ctrl+L` clears the view, and `Ctrl+Shift+L` locks the session.

## Not deployed

This branch creates no Cloudflare resources, secrets, R2 buckets, or billing changes. The Worker typecheck, Docker build, R2 mount, WebSocket upgrade and live adapter behavior still require deployment/integration checks.
