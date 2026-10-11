# Landing-page intake integration

## Guest intake

The landing page now uses a guest flow accepting a bill and/or text plus a phone
number and ZIP code or state. The separate account-linking API still accepts only
`address` and `consent`, requires a sign-in JWT, and caps requests at 8 KB.

The intake reuses `photonTransport(...).welcome(...)`, `LinkStore.issue`, and the
existing `CONNECT <code>` reply handler. Account authentication and endpoints
keep their existing contract. After phone verification, the Photon message loop
hands the saved intake to Gemini for bill extraction and conversational replies.
See [Gemini setup](../more-time/docs/gemini-setup.md) for enabling the engine.

Two modules under `more-time/src/` handle the intake:

- `intake-store.ts`: persist guest intake details and attachment bytes in SQLite;
  associate the intake with an opaque server-created ID and the existing link
  challenge. Store only a hash of the browser's access token.
- `intake-api.ts`: accept/validate the form, save its details, send the existing
  connection message, and report whether the recipient has replied with the code.

Two existing backend files provide the wiring:

- `index.ts`: construct the intake handler with the existing Photon transport and
  store, route intake requests to it, and include local landing-page origins.
- `server.ts`: allow a bounded 10 MB attachment plus multipart overhead only for
  the intake route. Keep the account endpoints' existing 8 KB limit.

The guest access token grants access only to that intake's connection status.
It does not sign the visitor into an account or bypass the existing JWT API.
Phone ownership is confirmed by the existing inbound connection-code handler.
No details are included in the welcome message before that confirmation.

## Browser/server contract

`POST /api/intake` accepts `multipart/form-data`:

| Field | Value |
| --- | --- |
| `address` | U.S. phone in E.164 format |
| `details` | Up to 5,000 characters; required unless a bill is included |
| `zipCode` | ZIP or ZIP+4; mutually exclusive with `state` |
| `state` | U.S. state/territory code when ZIP is unknown |
| `bill` | Optional single PDF/JPEG/PNG/WebP/HEIC/HEIF file, at most 10 MB |
| `consent` | Literal string `true`, supplied only after agreement to messages and Gemini processing |

After saving and sending the connection message, return `201`:

```json
{
  "intakeId": "server-created-intake-id",
  "accessToken": "random-single-intake-token",
  "status": "pending",
  "messageText": "CONNECT <24-hex-character-code>",
  "expiresAt": "<ISO timestamp five minutes in the future>",
  "messagingAddress": null
}
```

`GET /api/intake/status` accepts `Authorization: Bearer <accessToken>` and returns
`{ "intakeId": "...", "status": "pending" | "connected" | "expired" }`.
Do not put tokens, phone numbers, or connection codes in URLs or browser storage.

The browser polls every two seconds and stops on confirmation, expiry, close,
navigation, or an error. POSTs are never automatically retried. Duplicate clicks
are disabled during submission. A network interruption can leave the delivery
outcome uncertain; the UI tells the visitor to check Messages before retrying.

The server uses the existing phone-based rate limit (three codes per five
minutes), validates type/signature, size, location, and consent, and stores bill
bytes in SQLite rather than creating files from uploaded filenames. File signature
checks are basic format checks; Gemini performs document analysis after verification.

Expired, unverified intakes have their phone, details, location, and bill cleared
on startup, status reads, new submissions, and a 60-second cleanup interval.
Only a status tombstone remains for 24 hours, then it is deleted. This is logical
database cleanup, not a guarantee of secure erasure from SQLite pages or backups.
Failed sends revoke the code and delete the unverified record. If the recipient
already confirmed during a transport error, the verified intake is preserved.
Connected intakes stay saved for the assistant. Reply STOP or UNSUBSCRIBE in the
verified chat to disconnect and remove the case, intake and assistant receipts
from the active database. A general retention schedule is not implemented.
Connection status confirms phone verification; check Messages for the analysis
or an explanation that the engine is unavailable.
An address already linked by the current backend returns `409`; this scope does
not change account recovery or allow a visitor to claim an existing connection.

## Local frontend configuration

`landing/dist/intake-api.js` defaults to `http://<local-hostname>:8080` when the
page is served from localhost/127.0.0.1 and otherwise uses its own origin.
For a separately hosted API, set `window.MORETIME_API_BASE_URL` to its HTTPS URL
before loading the script. Never place Photon credentials in the landing page.

## Running locally

Use Node 24+ and install backend dependencies with `npm run setup` from the
repository root. Configure `PROJECT_ID` and `PROJECT_SECRET` from the Photon
dashboard locally in `more-time/.env` (or provide them through the process
environment), and add `GEMINI_API_KEY` to enable the assistant. No `AUTH_*` settings are needed for guest intake. If you already
set `ALLOWED_ORIGINS`, include the exact landing-page origin, such as
`http://localhost:8000`. See `more-time/.env.example` for available settings.

Run `npm start` for the API on port 8080 and, in a second terminal:

```sh
python3 -m http.server 8000 --directory landing/dist
```

Open http://localhost:8000. On a Photon shared project, register demo recipients
in the Photon dashboard before sending. The backend must stay running to receive
the verification reply. Use one process with a persistent SQLite volume when
deploying, and HTTPS plus an exact allowed origin for a hosted frontend.

`npm run typecheck` and `npm test` verify the backend, including the guest flow
with a fake transport. Browser checks use fictional data and simulated responses;
they do not send real messages. Live delivery still needs configured Photon
credentials and an eligible test recipient.

## Handoff to the assistant

`LinkStore.connectionForSender(sender)` returns the verified `user_id`.
`IntakeStore.forConnection(connection.user_id)` returns the phone, text,
`zipCode` or `state`, and optional bill `{ name, type, bytes }`. Both stores must
open the same SQLite file. This read is server-only and returns no intake before
phone verification; the guest HTTP token grants status access only. The message
loop calls `createMessageHandler`, which reads the saved intake only after
verification, invokes Gemini, and saves bill facts and recent conversation in
`ConversationStore`. The HTTP status endpoint never returns bill contents or replies.

## Call follow-through after intake

The verified iMessage sender can use [call follow-through](../more-time/docs/call-follow-through.md) after the bill is analyzed. `CALL` prepares a script; `CALLED <notes>` and `CONFIRM CALL` save the user’s account of the outcome; `REMIND IN 2 DAYS` approves one reminder. This is separate from landing-page recurring check-ins and Gmail approval. STOP deletes call records and reminders from the active database.
