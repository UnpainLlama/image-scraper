# Deployment and Cloudflare setup

This repository contains application code only. It does not create Cloudflare resources automatically and does not include account credentials.

## 1. Cloudflare plan and resources

A Workers Paid plan is recommended for configurable queue retention and higher sustained processing. The application is designed around these resources:

- Worker: image-scraper
- R2 bucket: image-scraper-archive
- Queue: image-scraper-discovery
- Queue: image-scraper-download
- SQLite-backed Durable Object class: JobDurableObject
- Browser Run binding: BROWSER

The Worker configuration binds R2, both queues, the Durable Object namespace, static assets and Browser Run. Wrangler creates or updates the Durable Object namespace during deployment using the migration in wrangler.jsonc.

## 2. Create the R2 bucket

    npx wrangler r2 bucket create image-scraper-archive

Keep the bucket private. Do not attach a public custom domain.

Apply the abandoned-job lifecycle safety net:

    npx wrangler r2 bucket lifecycle set image-scraper-archive --file infra/r2-lifecycle.json

The lifecycle file expires objects under jobs/ after seven days and aborts incomplete multipart uploads after one day. The application currently uses streamed single-object R2 puts (maximum configured file size 50 MiB), not multipart uploads. The abort rule is an additional bucket-level safeguard.

Cloudflare documents that objects are typically removed within 24 hours after their lifecycle expiration time. The lifecycle rule is not a real-time deletion guarantee.

## 3. Create the queues

    npx wrangler queues create image-scraper-discovery
    npx wrangler queues create image-scraper-download

The Free plan fixes message retention at 24 hours. On a plan where retention is configurable, explicitly set the same 24-hour window:

    npx wrangler queues update image-scraper-discovery --message-retention-period-secs 86400
    npx wrangler queues update image-scraper-download --message-retention-period-secs 86400

There is no dead-letter queue by default. Queue messages contain the temporary page or image URLs required to perform the job. They are acknowledged after processing and are removed after the retention window if they are not processed. A paused job must be resumed or cancelled before its queued messages expire.

Consumer-level concurrency is capped at 50 invocations per queue in Wrangler. A separate Durable Object enforces each job's configured concurrency (1–20) and per-domain delay.

## 4. Install and deploy

Use Node.js 20 or later.

    npm install
    npm run typecheck
    npm test
    npx wrangler login
    npx wrangler deploy

Wrangler uses wrangler.jsonc. Do not add credentials to that file. The R2 bucket is accessed through a Worker binding, so the Worker does not need an R2 access key.

## 5. Protect the dashboard and API with Cloudflare Access

Protect the complete Worker hostname, not only the dashboard route. The policy must cover:

- /
- Static dashboard assets
- /api/jobs
- /api/jobs/*

Create an Access application for the deployed Worker hostname and allow only your intended account. Confirm the policy blocks an unauthenticated request to both the dashboard and an API endpoint. Do not leave a public bypass hostname enabled. If your account cannot apply Access to the workers.dev hostname, disable that public hostname and use a hostname/route that is protected by Access.

The app has no second login system. Its security boundary is Cloudflare Access.

## 6. Export credentials

Export credentials are created separately from Worker credentials. Create an R2 API token with Object Read permission scoped to the image-scraper-archive bucket. Keep the Access Key ID and Secret Access Key on the machine running rclone; do not add them to GitHub or Cloudflare Worker variables.

Set these environment variables before running scripts/export.sh:

- R2_ACCOUNT_ID
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
- R2_BUCKET
- JOB_ID
- DEST_DIR

The manifest is downloaded from the dashboard and is not stored by the Worker. After export:

    scripts/verify.sh manifest-JOB_ID.json ./image-export > verification-report.json

Upload the resulting JSON report in the dashboard. The report includes only the manifest digest, checked file count, checked byte count and failure count. It contains no source URLs.

## 7. Clear a job

Clear is unavailable until:

- The job has completed or has been cancelled.
- All registered queue tasks have drained.
- No download permits or byte reservations remain.
- The manifest verification report matches the manifest and reports zero failures.

The clear endpoint deletes every R2 object under the job prefix, lists the prefix again to confirm it is empty, deletes Durable Object alarms and calls SQLite Durable Object deleteAll(). No deletion receipt is persisted.

The application does not create multipart uploads, so there are no app-created multipart upload IDs to abort during normal clearing. The R2 lifecycle rule separately aborts abandoned multipart uploads as a bucket safety net.

## 8. Privacy and observability

- Worker observability, invocation logs and traces are disabled in wrangler.jsonc.
- The Worker does not call console.log, console.error or emit URLs, headers, filenames or R2 keys.
- Durable Object state stores hashed page identities, hashed image URL identities, content hashes, queue task hashes, counters, domain rate-limit timestamps and error codes. It does not store full page or image URLs.
- Queues necessarily hold URLs while messages are pending.
- Cloudflare Access and Cloudflare platform-level operational records are outside the application's retention controls.
- Target websites receive normal HTTP requests and may retain their own access logs.