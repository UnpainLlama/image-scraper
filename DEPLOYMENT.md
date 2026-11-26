# Deployment and Cloudflare setup

This repository contains application code only. It does not create Cloudflare resources automatically and does not include account credentials. The scraper runs directly on Cloudflare Workers; no Python runtime, Docker image, Cloudflare Container, Linux VM or external Python host is required.

## 1. Cloudflare plan and resources

**The TypeScript implementation can run on Workers Free for modest jobs.** The repository defaults are intentionally limited to 1 GiB, 100 pages and 2,000 images per job, with a maximum of five queue workers per queue.

Relevant current Free allowances:

- **Workers:** 100,000 requests/day and 10 ms CPU time per ordinary Worker invocation. Keep API requests small; image transfers and parsing are processed asynchronously by Queue consumers.
- **Queues:** 10,000 standard operations/day, with 24-hour message retention. A normal message delivery usually costs three operations (write, read and delete); retries add more.
- **Durable Objects:** SQLite-backed classes are supported on Free. The documented Free allowances include 100,000 DO requests/day, 13,000 GB-seconds/day, 5 million SQL rows read/day, 100,000 SQL rows written/day, and 5 GB of total SQLite storage. Free-plan usage above any one of these daily limits is rejected until the daily reset. This application uses SQLite storage.
- **Queue consumers:** Queue consumer invocations have a default 30-second active CPU budget and a 15-minute wall-clock limit. The scraper leaves that default unchanged; normal Worker HTTP requests still have the separate 10 ms Free CPU limit.
- **Browser Run:** 10 minutes/day on Free. It is only a fallback for pages that look JavaScript-rendered; if the quota is exhausted, the scraper continues with static HTML.
- **R2 Standard storage:** 10 GB-month, 1 million Class A operations and 10 million Class B operations/month, with free Internet egress. R2 usage above the included allowances is billable.

The application does not upgrade the account or enable a Paid plan. Free quotas are not unlimited: Queue or Worker/DO operations can fail after their included limits are reached, and R2 overage can incur charges. Keep stored objects within the R2 allowance, export and Clear verified jobs, and monitor usage in the Cloudflare dashboard. A large crawl, repeated retries, or many retained jobs may not fit the Free allowances. Do not assume that a job can exceed the defaults without cost.

Cloudflare reference pages:
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Queues pricing and limits](https://developers.cloudflare.com/queues/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

The application uses these existing resources:

- Worker: `image-scraper`
- R2 bucket: `image-scraper-archive`
- Queue: `image-scraper-discovery`
- Queue: `image-scraper-download`
- SQLite-backed Durable Object class: `JobDurableObject`
- Browser Run binding: `BROWSER`

The Worker configuration binds R2, both queues, the Durable Object namespace, static assets and Browser Run. Wrangler creates or updates the Durable Object namespace during deployment using the migration in wrangler.jsonc.

## 2. Reuse the existing R2 bucket

The intended bucket is `image-scraper-archive`. Reuse it; **do not create a second bucket** if this one already exists. Only when setting up a brand-new account without the bucket, run:

    npx wrangler r2 bucket create image-scraper-archive

Keep the bucket private. Do not attach a public custom domain.

Apply the abandoned-job lifecycle safety net:

    npx wrangler r2 bucket lifecycle set image-scraper-archive --file infra/r2-lifecycle.json

The lifecycle file does not expire completed job objects. It deletes only objects under the top-level `tmp/` prefix after one day and aborts incomplete multipart uploads after one day. Temporary image keys use `tmp/jobs/<job-id>/<task-id>` so this prefix rule covers only incomplete work. Final images remain under `jobs/<job-id>/` until the Durable Object's abandonment policy clears that job.

Cloudflare documents that objects are typically removed within 24 hours after their lifecycle expiration time. The lifecycle rule is not a real-time deletion guarantee.

## 3. Create the queues

Reuse the named production queues if they already exist; do not create duplicates.

    npx wrangler queues create image-scraper-discovery
    npx wrangler queues create image-scraper-download

Workers Free Queue retention is fixed at 24 hours. Workers Paid can configure retention up to 14 days. The following optional commands apply only to a Paid account; do not run them on Free:

    npx wrangler queues update image-scraper-discovery --message-retention-period-secs 1209600
    npx wrangler queues update image-scraper-download --message-retention-period-secs 1209600

Wrangler configures a retry count of five. Queue messages contain only the job ID and task ID; URLs and depth remain in the per-job Durable Object. The Durable Object is authoritative. A consumer leases a task before doing work. Paused consumers acknowledge hints without leasing, and resume republishes pending tasks. An alarm reconciler republishes tasks after a send failure, lost/exhausted hint, or expired lease. `sendBatch` publications are limited to 100 messages per batch.

Consumer concurrency is capped at five invocations per queue. A separate Durable Object enforces each job's configured concurrency (1–5) and per-domain delay.

## 4. Install and deploy

Use Node.js 20 or later.

    npm install
    npm run typecheck
    npm test
    npx wrangler login
    npx wrangler deploy

Wrangler uses wrangler.jsonc. Do not add credentials to that file. The R2 bucket is accessed through a Worker binding, so the Worker does not need an R2 access key.

## 5. Password-only authentication

The terminal-style browser console uses one password and no username, email address, Google login or Cloudflare Access JWT. The Worker protects every API route with a signed session cookie.

If you keep a Cloudflare Access application for the Worker hostname, add a Bypass policy for everyone. This lets requests reach the Worker; it does not bypass the application's password check. Do not add a public API route or remove the Worker-side session check.

In Cloudflare, open Workers & Pages > image-scraper > Settings > Variables and Secrets. Add these as encrypted secrets:

- `APP_PASSWORD`: the password used to unlock the dashboard. The application currently requires at least 8 characters; use a long, unique password.
- `SESSION_SECRET`: an independently generated random value with at least 32 random characters. Do not reuse the dashboard password.

Keep both values out of GitHub, wrangler.jsonc, and dashboard files. Configure the same secrets separately for any staging Worker.

The login endpoint allows five attempts in a 15-minute window. Failed attempts are counted by the existing SQLite-backed Durable Object namespace. Successful login clears the counter. Sessions use a Secure, HttpOnly, SameSite=Strict cookie and expire after 12 hours.

The console HTML and static assets can be served before login, but every scraper API endpoint returns 401 until a valid session is present. Logging out expires the browser cookie. Rotating SESSION_SECRET invalidates existing sessions.

## 6. Terminal console workflow

After login, the browser console guides the operator through the supported site selection:

- Sex.com: search query or list URL
- Rule34 / Realbooru: tags or list URL
- EliteBabes: tag, home or gallery URL, then listing thumbnails or full-size galleries
- Buondua: home, hot, tag or album URL / numeric album ID
- Static: an HTML page URL; image and GIF URLs are discovered, and only an explicit same-origin next-page link is followed
- Auto: detects a supported hostname from a URL; an unclassified URL is treated as static HTML, while a search term defaults to Sex.com

The console checks the target using Worker HTTP first. If that request returns 403, it independently tries Browser Run to determine whether the public page can be rendered. This preflight verifies page access only; it does not guarantee that the site's API or image CDN will permit downloads. It accepts 1–100 pages (Enter defaults to 100), 1–5 parallel workers (Enter defaults to 3), and applies the existing 2,000-image/GIF-file / 1-GiB per-job caps. These are hard application ceilings for this Free-oriented build.

The hosted Worker does not offer Tor/SOCKS, browser-cookie paste, a general terminal, per-album local folders, or the former Python CLI's metadata files. Image and GIF files are stored in R2 as content-addressed objects under the job prefix. Site adapters and target-site behavior still need live integration checks after deployment.

## 7. Export credentials

Export credentials are created separately from Worker credentials. Create an R2 API token with Object Read permission scoped to the image-scraper-archive bucket. Keep the Access Key ID and Secret Access Key on the machine running rclone; do not add them to GitHub or Cloudflare Worker variables.

Set these environment variables before running scripts/export.sh:

- R2_ACCOUNT_ID
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
- R2_BUCKET
- JOB_ID
- DEST_DIR

The manifest is downloaded from the dashboard and is not stored by the Worker. Save it locally in the project working directory as manifest-JOB_ID.json. After export:

    scripts/verify.sh manifest-JOB_ID.json ./image-export > verification-report.json

Upload the resulting JSON report in the terminal console. The report includes only the manifest digest, checked file count, checked byte count and failure count. It contains no source URLs.

## 8. Clear a job

Clear is unavailable until:

- The job has completed or has been cancelled.
- All registered queue tasks have drained.
- No download permits or byte reservations remain.
- The manifest verification report matches the manifest and reports zero failures.

The clear endpoint is resumable. It stops leasing, deletes the job prefix in paginated batches, stores only a cursor and deletion counters while clearing, confirms the prefix is empty, deletes the alarm and then calls SQLite Durable Object `deleteAll()`. A failed batch leaves `clearing_failed`; the alarm retries and the dashboard can submit Clear again. The response receipt is returned to the caller and is not persisted. Queue hints are not purged at queue level because those queues are shared by jobs; stale hints are acknowledged when the job/task no longer exists.

The application currently uses streamed single-object R2 puts and does not create multipart uploads. The bucket lifecycle rule aborts any incomplete multipart upload after one day.

## 9. Privacy and observability

- Worker observability, invocation logs and traces are disabled in wrangler.jsonc.
- The Worker does not call console.log, console.error or emit URLs, headers, filenames or R2 keys.
- Durable Object state stores task URLs only while a job is active, along with hashed page/image identities, content claims, counters, domain pacing timestamps and error codes. Task rows are deleted when the job is cleared.
- Queue messages contain only job IDs and task IDs, never URLs.
- Cloudflare Access and Cloudflare platform-level operational records are outside the application's retention controls.
- Target websites receive normal HTTP requests and may retain their own access logs.
