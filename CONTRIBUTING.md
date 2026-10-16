# Contributing

Start with an issue describing the observed behavior, expected result, CLI version and a redacted reproduction. Never attach credentials, raw private transcripts or production node configurations.

Use Node.js 24. Install locked dependencies with `npm ci` in `server` and `web`. Run `npm test` in both directories and `npm run build` in `web`. Container changes must pass the isolated smoke scenario in `docs/public/operations.md`.

Maintain the existing six session states and engine-specific native session IDs. JSONL is the durable event source; do not merge identical events from multiple sources without identity checks. Approval, queue, recovery and lifecycle changes require behavioral tests. Do not kill a live writer or remove a CLI lock to make a recovery test pass.

Pull requests should explain the user-visible trigger, resulting behavior and validation. Contributions are provided under the repository's ISC license. Third-party code needs attribution and a compatible license.
