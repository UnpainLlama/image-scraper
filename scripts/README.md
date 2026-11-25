# Local export scripts

- export.sh copies the current job prefix from a private R2 bucket to a local directory using rclone and read-only R2 credentials.
- verify.sh checks every manifest entry against local file size and SHA-256, then prints a compact JSON report for the dashboard.

Neither script writes the manifest or report back to Cloudflare. Keep the manifest and verification report locally until the job has been cleared.