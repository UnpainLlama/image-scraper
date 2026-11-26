# Image Scraper

A private, image-only Cloudflare collection tool. It discovers image files on supplied pages, optionally crawls same-site links, downloads original bytes to a private R2 bucket, and provides a verified local export followed by job deletion.

## Runtime

The scraper engine is TypeScript and runs on Cloudflare Workers, Queues, SQLite-backed Durable Objects and R2. It does not require Python, a Docker image, Cloudflare Containers, a Linux VM, or a remote shell. The browser interface is a guided terminal-style console, not a general-purpose operating-system shell.

## What it does

1. Accepts a website URL and one or more pages.
2. Processes the supplied pages and bounded site-specific continuations, or follows generic same-origin links in Crawl mode.
3. Finds image elements, responsive image sources, linked image files, Open Graph images, CSS backgrounds, and external stylesheets.
4. Downloads original image bytes using configurable per-job concurrency and per-domain request spacing.
5. Streams, validates and hashes images before storing them in the private R2 bucket.
6. Generates a manifest on request so the files can be copied to a local machine with rclone.
7. Verifies file sizes and SHA-256 hashes before enabling Clear.
8. Deletes the R2 job prefix and erases the job Durable Object state.

## Site-specific discovery

The scraper automatically selects an image-only adapter for these supported hosts:

- **Sex.com** — JSON GIF listings, search and tag endpoints, with bounded page/limit pagination. Relative media URIs use the known Sex.com CDN; absolute media URIs keep their supplied host.
- **Rule34.xxx** — tag/list pages, thumbnail-to-sample image URLs, and 42-item offset pagination. A directly supplied post page can resolve its original image.
- **Realbooru.com** — image post links, original image extraction from post pages, fallback scanning for non-thumbnail `/images/` links, and 42-item offset pagination.
- **Elitebabes.com** — selectable list-thumbnail mode or full-size gallery mode, with sequential list pagination. Gallery mode excludes thumbnail variants.
- **Buondua.com** — album listings, album-scoped image extraction, 20-item listing offsets, and numbered album pages.
- **Other static websites** — generic HTML and CSS image discovery.

The guided console uses **Exact mode** with the selected adapter. Static mode follows only an explicit same-origin next-page control; it does not spider every link on the website. The lower-level API retains **Crawl mode** for callers that explicitly need generic same-origin links up to a configured depth.

Site layouts and private APIs can change. The fixture tests simulate known HTML/API responses; they do not guarantee that every live site will accept a request or keep the same markup.

## Design rules

- Image files only. No video downloading, Pornhub adapter, text/article extraction or website archiving.
- No conversion, resizing, recompression, or re-encoding.
- No D1 database and no permanent job history.
- Task URLs and depth are stored in the per-job Durable Object until completion and job clear. Queue messages contain only job IDs and task IDs. URLs, filenames and R2 keys are never written to application logs.
- Per-job state is isolated in a SQLite-backed Durable Object.
- R2 is private and is the only image storage backend.
- GitHub stores application code only; there is no GitHub image mirror.
- Dashboard access uses a password-only login. The password and session-signing key are Worker secrets, never application files.
- API requests require a signed, HTTP-only session cookie. Sessions expire after 12 hours, and login attempts are throttled to five per 15-minute window.
- Application logging and Cloudflare Worker observability are disabled in wrangler.jsonc.
- The hosted console does not provide Tor/SOCKS routing or pasted browser cookies. It does not expose a general-purpose shell or provide a mechanism to bypass logins, CAPTCHAs, paywalls or access controls.

## Free-tier defaults

The default job settings are deliberately modest for a Cloudflare Workers Free account:

| Setting | Default |
|---|---:|
| Maximum image size | 50 MiB |
| R2 storage budget per job | 1 GiB |
| Concurrent work per job | 3 (configurable 1–5) |
| Per-domain minimum request interval | 1 second |
| Maximum crawl depth | 3 |
| Maximum pages per job | 100 |
| Maximum seed pages | 50 |
| Maximum discovered images per job | 2,000 |
| Queue retention | 24 hours (Free); up to 14 days (Paid) |
| Job abandonment threshold | 30 days idle |
| Abandonment grace period | 7 days |
| Temporary object expiry | 1 day (`tmp/` only) |

These are application limits, not a guarantee that every website or job will fit within every Cloudflare quota. Queue retries consume additional Queue operations; Browser Run is limited to 10 minutes/day on Workers Free. R2 includes 10 GB-month of Standard storage, 1 million Class A operations and 10 million Class B operations per month; usage above those allowances is billable. Export and clear completed jobs to keep R2 usage low.

See [DEPLOYMENT.md](DEPLOYMENT.md) before deploying.

## Quick start

Cloudflare resources (the existing R2 bucket, two Queues and Durable Object namespace) must be present in your account.

    npm install
    npm run typecheck
    npm test
    npx wrangler login
    npx wrangler deploy

## Export

Download the manifest from the terminal console, then use the scripts in scripts/:

    export R2_ACCOUNT_ID="your-cloudflare-account-id"
    export R2_ACCESS_KEY_ID="your-r2-read-key"
    export R2_SECRET_ACCESS_KEY="your-r2-read-secret"
    export R2_BUCKET="image-scraper-archive"
    export JOB_ID="job-id-from-dashboard"
    export DEST_DIR="./image-export"

    scripts/export.sh
    scripts/verify.sh manifest-JOB_ID.json "$DEST_DIR" > verification-report.json

Upload verification-report.json in the terminal console. Clear is enabled only after the report matches the manifest recorded for that job. The Worker stores images as content-addressed objects (`objects/<sha256>.<ext>`); an export therefore retains those hash-based names rather than reconstructing per-gallery folders from the former Python CLI.

## Important limits

- Queue messages contain only `{ jobId, taskId }`. The per-job Durable Object stores the task URL and depth and is the source of truth.
- Paused queue hints are acknowledged. On resume, pending tasks are republished. The alarm reconciler republishes tasks whose queue hint was lost/exhausted or whose worker lease expired; retention is no longer the task store.
- The application blocks local hostnames, IP-literal URLs, unusual ports, and unsafe redirect destinations. DNS resolution is performed by the Cloudflare runtime; this application does not implement a separate DNS pinning resolver.
- Browser Run can independently retrieve a page when Worker HTTP returns 403 and can render JavaScript-heavy pages. Its request allowlist includes only the selected supported site and its explicitly configured related domains. Browser Run returns HTML, not original image bytes; image CDN downloads still use Worker HTTP and can independently fail. If the Browser Run quota is exhausted, the scraper reports the retrieval failure.
- Completed job objects have no blanket lifecycle expiry. The Durable Object marks jobs abandoned after 30 days without user action or task progress, shows a 7-day grace period, then runs resumable Clear. This is the only automatic deletion of final job objects. Only `tmp/` objects expire automatically after one day; R2 lifecycle deletion is not immediate.
- Clearing removes application job data. It cannot erase Cloudflare platform-level Access, request, billing, or operational records, nor logs held by the target website.

## License

Private project. No license is granted for redistribution.
