# Image Scraper — Python container runtime

The hosted image scraper keeps the original scraping implementation in **CPython**. This subproject supplies the Cloudflare Worker, Linux container, browser terminal and persistent storage bridge.

The Python runtime is deliberately kept separate from the existing root TypeScript implementation while it is being validated.

## Layout

- `python/archive-parts/` — cleaned Python source archive, stored as ordered Base64 text fragments. The Docker build reconstructs and extracts it.
- `container/` — Linux container API server and startup script. FastAPI starts the original CLI as a child process and forwards terminal input/output over a WebSocket.
- `worker/` — Cloudflare Worker password authentication and Durable Object container routing.
- `web/` — password-only unlock screen and Termux-inspired terminal UI.
- `Dockerfile` — CPython 3.13 Linux image, dependencies and R2 FUSE mount.
- `scripts/validate-python.sh` — validates the embedded archive, compiles the scraper modules and runs the image-only unit tests.

## Image-only behavior

Retained image adapters: Sex.com, Rule34, Realbooru, EliteBabes, Buondua and generic static image pages. Pornhub and the video downloader are excluded. Video sources are skipped.

## Local validation

Run from this directory:

```sh
python -m pip install --disable-pip-version-check -r container/requirements.txt
bash scripts/validate-python.sh
npm install --no-audit --no-fund
npm run typecheck
docker build --platform linux/amd64 --tag image-scraper-pscraper:local .
```

A Docker daemon is required for the container build. The GitHub Actions workflow runs the same checks automatically.

## Existing Cloudflare resources

This service reuses the existing **image-scraper** Worker name and the existing private R2 bucket **image-scraper-archive**. Do not create a second bucket for this service.

The bucket is mounted at `/mnt/r2`; Python downloads are written only under `/mnt/r2/pscraper/`. This keeps the Python files separate from the TypeScript app's existing `jobs/` and `tmp/jobs/` object prefixes.

Configure:
- Worker secret `APP_PASSWORD`: unique passphrase, at least 15 characters.
- Worker secret `SESSION_SECRET`: at least 32 random characters.
- Worker variable `R2_ACCOUNT_ID`: Cloudflare account ID (**not a secret**).
- Worker secret `AWS_ACCESS_KEY_ID`: R2 access key ID.
- Worker secret `AWS_SECRET_ACCESS_KEY`: R2 secret access key.
- Worker variable `R2_BUCKET_NAME`: `image-scraper-archive` (already set in `wrangler.jsonc`).

The R2 API token should be scoped to the existing `image-scraper-archive` bucket with the access needed by the mounted filesystem. Never commit credentials or `.dev.vars`.

## Session behavior and limitations

- One interactive terminal session at a time.
- Browser disconnect stops the active CLI process; it is not left running unattended.
- Downloaded files and metadata are written below `/mnt/r2/pscraper` on the existing R2 bucket.
- R2 is object storage behind FUSE, not local SSD; performance and filesystem behavior must be checked in a Cloudflare integration test.
- Tor is not started in the container and remains unavailable in this first hosted build.
- `Ctrl+C` interrupts, `Ctrl+L` clears the view, and `Ctrl+Shift+L` locks the session.

## Deployment status

This validation branch does not create Cloudflare resources, upload secrets, or deploy anything. The Worker typecheck and Docker build run in CI; the live R2 mount, WebSocket upgrade and live site adapters still require a later Cloudflare integration test.
