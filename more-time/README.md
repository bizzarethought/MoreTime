# MoreTime iMessage account linking

Photon's iMessage bridge and the website account-linking API run together in a
long-running Node 24+ process. The repository root forwards npm commands here.

```sh
cd /Users/rishikeshsrivatsan/MoreTime
npm run setup
npm run typecheck
npm test
npm start
```

Keep the existing Photon credentials in `more-time/.env`. To enable account
linking, configure the website's JWT public-key URL, issuer, audience, and exact
allowed website origins. `.env.example` lists the settings; do not overwrite or
commit `.env`.

The API starts on `127.0.0.1:8080` by default and includes:

- `POST /api/messaging/link` — request a connection and consented welcome message.
- `GET /api/messaging/status` — read your account's connection status.
- `DELETE /api/messaging/link` — disconnect and invalidate pending codes.
- `GET /health` — health check.

Read the [landing-page integration guide](docs/landing-page-integration.md) for
the request/response contract, frontend example, Photon shared-number behavior,
and deployment settings. The website auth provider and live end-to-end test
remain to be configured. There is no unauthenticated account-linking bypass.

Links and message deduplication receipts persist in a gitignored SQLite database
under `data/`. Use a persistent volume and one running replica when deploying.

The former echo loop now handles connection requests. It does not yet download
bill attachments or call the resolution agent; replies state that limitation.
Run `npm run dev` for automatic restart after source edits.
