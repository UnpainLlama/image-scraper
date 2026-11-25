# Image Scraper

A private Cloudflare-hosted image collection tool. It discovers image files on supplied pages, optionally crawls same-domain links, downloads original bytes concurrently to a private R2 bucket, and provides a verified local export followed by job deletion.

## Design principles

- Image files only: no page archiving, text extraction, conversion, resizing, or recompression.
- Exact-page and same-domain crawl modes.
- Per-job limits, per-domain politeness controls, deduplication, and retry handling.
- Job state is isolated in a SQLite-backed Durable Object. There is no D1 database or permanent job history.
- R2 is the only image storage backend. The repository contains application code only.
- Export manifests are generated on request and returned to the browser; they are not stored in R2 or the Durable Object.
- Clear is available only after local verification is confirmed.

## Defaults

- Maximum image size: 50 MiB.
- R2 storage budget per job: 8 GiB.
- Maximum crawl depth: 3.
- Maximum pages per job: 500.
- Per-job concurrent downloads: 5 (configurable, 1–20).
- Per-domain minimum request interval: 1 second.
- Failed-URL view: counts and error codes only; full URLs are never persisted in the job object.
- GitHub image mirror: not included.

## Requirements

- Cloudflare Workers account with Workers Paid recommended for configurable queue retention.
- R2 bucket.
- Two Cloudflare Queues (discovery and downloads).
- Durable Objects with SQLite storage.
- Cloudflare Browser Run binding for JavaScript-rendered-page fallback.
- Cloudflare Access application protecting the Worker/dashboard.
- Node.js 20+ and Wrangler 4.134+ for local development and deployment.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for resource provisioning and configuration.