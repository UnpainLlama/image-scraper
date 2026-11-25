# Image Scraper

A private Cloudflare-hosted image collection tool. It discovers image files on supplied pages, optionally crawls same-site links, downloads original bytes concurrently to a private R2 bucket, and provides a verified local export followed by job deletion.

## What it does

1. Accepts a website URL and one or more pages.
2. Scrapes exact pages or follows same-origin links within a bounded crawl.
3. Finds image elements, responsive image sources, linked image files, Open Graph images, CSS backgrounds, and external stylesheets.
4. Downloads original image bytes using configurable per-job concurrency and per-domain request spacing.
5. Stores images temporarily in a private R2 bucket.
6. Generates a manifest on request so the files can be copied to a local machine with rclone.
7. Verifies file sizes and SHA-256 hashes before enabling Clear.
8. Deletes the R2 job prefix and erases the job Durable Object state.

## Site-specific discovery

The scraper automatically selects an image-only adapter for these supported hosts:

- **Sex.com** — paginated JSON GIF listings, search, and tag results.
- **Rule34.xxx** — tag/list pages, sample image URLs, and post-page links.
- **Realbooru.com** — list pagination and original image URLs from image posts.
- **Elitebabes.com** — gallery listings and full-size gallery images.
- **Buondua.com** — album listings, album images, and album pagination.

Use **Crawl** mode when starting from a listing page that links to galleries, posts, albums, or additional listing pages. Exact mode processes only the supplied seed page. These adapters do not add video discovery or downloading. Site layouts and APIs can change, so live behavior may differ from the fixture tests.

## Design rules

- Image files only. No text/article extraction or website archiving.
- No conversion, resizing, recompression, or re-encoding.
- No D1 database and no permanent job history.
- Task URLs and depth are stored in the per-job Durable Object until completion and job clear. Queue messages contain only job IDs and task IDs. URLs, filenames and R2 keys are never written to application logs.
- Per-job state is isolated in a SQLite-backed Durable Object.
- R2 is private and is the only image storage backend.
- GitHub stores application code only; there is no GitHub image mirror.
- Dashboard access uses a password-only login. The password and session-signing key are Worker secrets, never application files.
- API requests require a signed, HTTP-only session cookie. Sessions expire after 12 hours, and login attempts are throttled to five per 15-minute window.
- Application logging and Cloudflare Worker observability are disabled in wrangler.jsonc.

## Defaults

| Setting | Default |
|---|---:|
| Maximum image size | 50 MiB |
| R2 storage budget per job | 8 GiB |
| Concurrent work per job | 5 (configurable 1–20) |
| Per-domain minimum request interval | 1 second |
| Maximum crawl depth | 3 |
| Maximum pages | 500 |
| Maximum seed pages | 50 |
| Maximum discovered images | 50,000 |
| Queue retention | 14 days (Paid; Free is fixed at 24 hours) |
| Job abandonment threshold | 30 days idle |
| Abandonment grace period | 7 days |
| Temporary object expiry | 1 day (`tmp/` only) |

## Quick start

Read DEPLOYMENT.md before deploying. Cloudflare resources (R2 bucket, queues and Durable Object namespace) must be provisioned in your account.

    npm install
    npm run typecheck
    npm test
    npx wrangler login
    npx wrangler deploy

## Export

Download the manifest from the dashboard, then use the scripts in scripts/:

    export R2_ACCOUNT_ID="your-cloudflare-account-id"
    export R2_ACCESS_KEY_ID="your-r2-read-key"
    export R2_SECRET_ACCESS_KEY="your-r2-read-secret"
    export R2_BUCKET="image-scraper-archive"
    export JOB_ID="job-id-from-dashboard"
    export DEST_DIR="./image-export"

    scripts/export.sh
    scripts/verify.sh manifest-JOB_ID.json "$DEST_DIR" > verification-report.json

Upload verification-report.json in the dashboard. Clear is enabled only after the report matches the manifest recorded for that job.

## Important limits

- Queue messages contain only `{ jobId, taskId }`. The per-job Durable Object stores the task URL and depth and is the source of truth.
- Paused queue hints are acknowledged. On resume, pending tasks are republished. The alarm reconciler republishes tasks whose queue hint was lost/exhausted or whose worker lease expired; retention is no longer the task store.
- The application blocks local hostnames, IP-literal URLs, unusual ports, and unsafe redirect destinations. DNS resolution is performed by the Cloudflare runtime; this application does not implement a separate DNS pinning resolver.
- Browser Run is used only as a fallback for pages that appear JavaScript-rendered. A website can still change behavior after rendering; the scraper does not bypass logins, CAPTCHAs, paywalls, or access controls.
- Completed job objects have no blanket lifecycle expiry. The Durable Object marks jobs abandoned after 30 days without user action or task progress, shows a 7-day grace period, then runs resumable Clear. This is the only automatic deletion of final job objects. Only `tmp/` objects expire automatically after one day; R2 lifecycle deletion is not immediate.
- Clearing removes application job data. It cannot erase Cloudflare platform-level Access, request, billing, or operational records, nor logs held by the target website.

## License

Private project. No license is granted for redistribution.