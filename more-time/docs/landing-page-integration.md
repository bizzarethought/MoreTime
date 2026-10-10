# Connecting the MoreTime landing page to iMessage

The landing page now uses the [guest intake API](../../landing/INTAKE_INTEGRATION.md),
which accepts bill details and uploads without sign-in. This document describes
the separate signed-in account API; its JWT requirements are unchanged.

The backend and Photon bridge run together. Website authentication is configurable
because the landing page's auth provider has not been chosen yet. The connection
API refuses account operations with `503 auth_not_configured` until configured;
it never trusts a browser-supplied user ID or an unverified JWT.

## Backend setup

Use Node 24 or newer. From the repository root:

```sh
npm run setup
npm run typecheck
npm test
npm start
```

The existing `more-time/.env` is loaded at startup. Edit it locally to add these
settings; do not replace it, share it, or commit it. `.env.example` lists the keys.

| Setting | Value your landing-page teammate supplies |
| --- | --- |
| `AUTH_JWKS_URL` | Auth provider's HTTPS public signing-key endpoint |
| `AUTH_ISSUER` | Exact expected JWT issuer, including any trailing slash |
| `AUTH_AUDIENCE` | Audience of the JWT issued for the MoreTime backend |
| `ALLOWED_ORIGINS` | Exact landing-page origins, comma-separated |
| `HOST` | `127.0.0.1` locally; usually `0.0.0.0` in a deployed service |
| `PORT` | Backend port; defaults to `8080` |
| `DATABASE_PATH` | SQLite file on a persistent volume; defaults to `data/moretime.sqlite` |

Keep the existing `PROJECT_ID` and `PROJECT_SECRET` for Photon. The backend
also accepts `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`.

The auth provider must issue a JWT verifiable through JWKS with `RS256` or `ES256`.
Tokens require `sub`, `exp`, `iss`, and `aud`; user identity comes from verified
`sub`. Use the JWT meant for this API, rather than an arbitrary OAuth token. If
the chosen provider uses opaque tokens or only cookie sessions, add the provider's
server-side session/token verification before connecting the frontend; do not
work around it by accepting a browser-supplied user ID. Configure issuer/audience
according to the selected provider. Provider-specific setup is still pending.

Deploy as a long-running Node process with a persistent SQLite volume. The Photon
stream requires an active process; short-lived serverless functions are unsuitable
for this entry point. Run one process/replica for this hackathon implementation.
Use a public HTTPS backend URL for the deployed landing page. The HTTP server is
intended to sit behind your hosting provider's HTTPS termination.

## Connection flow

1. The visitor signs in to the website.
2. Collect their iMessage address (E.164 phone, e.g. `+15551234567`, or Apple ID email).
3. Display explicit consent: “Send a MoreTime connection message to this iMessage address.”
4. On their click/consent, call `POST /api/messaging/link` using the sign-in JWT.
5. The backend sends a welcome iMessage containing a single-use connection code.
6. The user replies `CONNECT <code>` in that conversation from the address they entered.
7. Poll `GET /api/messaging/status` about every two seconds until connected or the code expires.
8. Display the connected sender address and provide a Disconnect button.

Free/Pro Photon projects require test recipients to be registered as project users
before outreach. Complete that setup in the Photon dashboard for the demo.
Registering someone in Photon is not proof of iMessage ownership; the incoming
connection reply establishes the account association. Self-service Photon user
registration is not implemented here.

On shared-number plans the installed SDK reports `space.phone` as `shared`, not
the actual number. `messagingAddress` is therefore `null` and the UI must instruct
the user to reply to the welcome message. Do not build a Messages link addressed
to `shared` or use one global number. A dedicated line can return its actual
number. The welcome-message path works with either allocation.

## API contract

All account endpoints require:

```http
Authorization: Bearer <signed-in-user-JWT>
```

No cookies are used for API authentication. The frontend never receives the
Photon project secret. Responses are marked `Cache-Control: no-store`.

### Create a connection request

```http
POST /api/messaging/link
Content-Type: application/json

{"address":"+15551234567","consent":true}
```

`201` response:

```json
{
  "code": "EXAMPLE_ONLY_USE_THE_RETURNED_CODE",
  "expiresAt": "2026-10-10T01:05:00.000Z",
  "messagingAddress": null,
  "messageText": "CONNECT EXAMPLE_ONLY_USE_THE_RETURNED_CODE",
  "instructions": "A welcome message was sent to your iMessage address. Reply to that conversation with the connection code."
}
```

The actual code is 24 hexadecimal characters, expires after five minutes, is
bound to the authenticated account and requested sender address, and is stored
only as a SHA-256 hash. Requesting a new code invalidates the previous code.
There are limits of three code requests per five minutes per account and target
address, and five redemption attempts per minute per sender.

### Read connection status

```http
GET /api/messaging/status
```

```json
{"connected":false}
```

Or:

```json
{"connected":true,"senderAddress":"+15551234567","connectedAt":"2026-10-10T01:04:00.000Z"}
```

Status is always scoped to the authenticated account. There is no endpoint that
lets the browser look up someone else's user ID.

### Disconnect

```http
DELETE /api/messaging/link
```

Returns `204` and invalidates pending codes. It removes the messaging association;
it does not delete the sign-in account or remove the user from Photon's allowlist.

### Errors

Errors are JSON objects with `error` and `message`:

| HTTP status | Meaning / UI behavior |
| --- | --- |
| `400` | Invalid address/body or missing consent; show the message |
| `401` | Missing, invalid, or expired sign-in JWT; refresh session or sign in |
| `403` | Landing-page origin not in `ALLOWED_ORIGINS` |
| `409` | Account/address already connected; disconnect first |
| `413` / `415` | Request too large / incorrect content type |
| `429` | Too many connection requests; wait five minutes |
| `502` | Photon delivery failed; check project recipient registration/access |
| `503` | Website authentication has not been configured |

## Frontend example

Call this from the Connect button only after the user explicitly agrees to receive
the welcome message. Obtain `accessToken` from the selected authentication SDK.

```ts
async function connectIMessage(apiUrl: string, accessToken: string, address: string) {
  const response = await fetch(`${apiUrl}/api/messaging/link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address, consent: true }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "Connection request failed");
  return result;
}

async function getMessagingStatus(apiUrl: string, accessToken: string) {
  const response = await fetch(`${apiUrl}/api/messaging/status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "Could not read connection status");
  return result;
}

async function disconnectIMessage(apiUrl: string, accessToken: string) {
  const response = await fetch(`${apiUrl}/api/messaging/link`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Could not disconnect iMessage");
}
```

Disable repeat Connect clicks while a request is in flight. Stop polling on
connection, expiration, sign-out, page unmount, or an error requiring user action.
Keep connection codes in component memory, rather than URLs, analytics, or logs.

## Verification and limits

Automated tests cover real JWT signature/claim validation using local test keys,
the linking flow, sender mismatch, expiry, replay, account isolation, rate limits,
disconnects, delivery failure, and persisted links/duplicate receipts after restart.
Tests use an injected messaging transport; they do not send real messages or
read real credentials. Live website/Photon testing remains to be done once the
auth provider and deployment are configured.

Connection changes and message receipts are committed together. Duplicate message
IDs do not reapply account changes. Unsent replies can be retried on redelivery;
a send accepted by Photon followed by a local crash can still produce a duplicate
reply. Receipts are retained for seven days. This is not an exactly-once outbound
delivery guarantee or a production outbox.

Only private inbound iMessage DMs are handled; group messages and outbound echoes
are ignored. Attachments are not downloaded or analyzed in this change. Connected
users receive an explicit “bill processing is not available yet” response. Case
intake, extraction, and the Python resolution-agent connection are the next build
stage. The SQLite database stores sender addresses, connection metadata, code
hashes, rate limits, and generic reply receipts; it does not store bill contents
or incoming conversation text.

References: [Photon quickstart](https://photon.codes/docs/spectrum-ts/getting-started),
[iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing),
[jose JWT verification](https://github.com/panva/jose).
