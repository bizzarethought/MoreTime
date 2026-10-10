# MoreTime intake, iMessage and Gemini

Photon's iMessage bridge, Gemini bill assistant, guest intake, and the website account-linking API run together in a
long-running Node 24+ process. The repository root forwards npm commands here.

```sh
# From the repository root, with Node 24+ available:
npm run setup
npm run typecheck
npm test
npm start
```

Configure Photon credentials and `GEMINI_API_KEY` locally in `more-time/.env` or the process environment.
Guest intake needs no sign-in provider. Set exact allowed website origins;
defaults include `http://localhost:8000` and `http://127.0.0.1:8000`. To enable the
separate account endpoints, also configure the website's JWT public-key URL,
issuer, and audience. `.env.example` lists the settings; preserve existing secrets
and do not commit `.env`.

The API starts on `127.0.0.1:8080` by default and includes:

- `POST /api/messaging/link` — request a connection and consented welcome message.
- `POST /api/intake` — submit guest phone, consent, location, and bill/text; send a connection code.
- `GET /api/intake/status` — check that guest request using its status-only bearer token.
- `GET /api/messaging/status` — read your account's connection status.
- `DELETE /api/messaging/link` — disconnect and invalidate pending codes.
- `GET /health` — health check.

Read the [guest intake guide](../landing/INTAKE_INTEGRATION.md) for the landing-page
contract, local setup, storage lifecycle, and agent handoff. The
[account-linking guide](docs/landing-page-integration.md) covers the separate JWT
endpoints and Photon shared-number behavior. Live delivery needs configured
credentials and an eligible recipient. Guest status tokens cannot access accounts.

Links and message deduplication receipts persist in a gitignored SQLite database
under `data/`. Use a persistent volume and one running replica when deploying.

After verification, Gemini extracts bill facts and replies in the same iMessage
conversation. Follow-up questions use persisted bill facts, the document and the
last ten turns. Website uploads and direct iMessage PDF/image attachments work.
Without `GEMINI_API_KEY`, verification works but analysis remains disabled.
Read [Gemini setup](docs/gemini-setup.md), or run `npm run gemini:check` from the
root to check Gemini independently without sending an iMessage.

The assistant can explain bills and draft requests; contacting billers, policy
retrieval and scheduled follow-ups are not implemented. Reply STOP to disconnect
and remove the saved case from the active database.
Run `npm run dev` for automatic restart after source edits.
