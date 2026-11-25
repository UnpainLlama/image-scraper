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

## Design rules

- Image files only. No text/article extraction or website archiving.
- No conversion, resizing, recompression, or re-encoding.
- No D1 database and no permanent job history.
- No full image URLs are persisted in Durable Object state or application error summaries. Queue messages necessarily hold URLs temporarily while work is pending.
- Per-job state is isolated in a SQLite-backed Durable Object.
- R2 is private and is the only image storage backend.
- GitHub stores application code only; there is no GitHub image mirror.
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
| Queue retention | 24 hours |
| Abandoned-object lifecycle | 7 days |

## Quick start

Read DEPLOYMENT.md before deploying. Cloudflare resources (R2 bucket, queues, Durable Object namespace and Access policy) must be provisioned in your account.

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

- Queue messages temporarily contain the page or image URL needed by a consumer. They are acknowledged when work completes and are subject to the configured queue retention period.
- A job paused longer than the queue retention period may lose queued work. Resume or cancel paused jobs before queue messages expire.
- The application blocks local hostnames, IP-literal URLs, unusual ports, and unsafe redirect destinations. DNS resolution is performed by the Cloudflare runtime; this application does not implement a separate DNS pinning resolver.
- Browser Run is used only as a fallback for pages that appear JavaScript-rendered. A website can still change behavior after rendering; the scraper does not bypass logins, CAPTCHAs, paywalls, or access controls.
- R2 lifecycle expiration is a safety net for abandoned jobs, not an exact deletion timer. Cloudflare states that lifecycle deletions typically complete within 24 hours of the expiration time.
- Clearing removes application job data. It cannot erase Cloudflare platform-level Access, request, billing, or operational records, nor logs held by the target website.

## License

Private project. No license is granted for redistribution.