# Approved follow-ups and Gmail

After verifying a phone number in the landing-page intake dialog, the visitor can choose a first check-in in their local time and approve weekly iMessage check-ins for up to 90 days. The first time must be within 30 days. These check-ins persist in SQLite and run each minute while the server is running. They ask about the uploaded case; they do not infer or change a payment deadline. Restarting the server retains schedules. Downtime sends one overdue check-in rather than a backlog.

Commands: `FOLLOWUPS OFF` or `RESOLVED` pause check-ins and email alerts; `SNOOZE 1` through `SNOOZE 30` defer both; `EMAIL OFF` removes Gmail access locally; `STOP` removes both integrations and the existing saved case. These commands work without Gemini. User approval is separate from ordinary messaging consent.

## Gmail setup

Enable Gmail API in a Google Cloud project. Configure an OAuth web application and add the exact callback URI. Use Google OAuth testing mode and explicitly allow demo users during development. Public Gmail read access may require Google's restricted-scope verification; see https://developers.google.com/workspace/gmail/api/auth/web-server and https://developers.google.com/workspace/gmail/api/auth/scopes.

Configure these variables through your deployment secret manager (never commit credentials):

- `GOOGLE_EMAIL_CLIENT_ID`
- `GOOGLE_EMAIL_CLIENT_SECRET`
- `GOOGLE_EMAIL_REDIRECT_URI`, for example `http://localhost:8080/api/email/callback` locally; HTTPS in production
- `EMAIL_TOKEN_KEY`, a random 32-byte key encoded as 64 hex characters. Keep this stable across restarts; changing it makes existing saved email tokens unreadable.

The landing page reports that Gmail setup is pending until all variables are configured. OAuth uses state, PKCE, a short-lived HttpOnly browser-binding cookie, and a verified intake capability. Refresh tokens are encrypted with AES-256-GCM and account-bound authenticated data. Connecting email does not enable check-ins automatically. Only read-only Gmail scope is requested; sending email is not implemented.

While approved check-ins are enabled and not snoozed, Gmail is checked every ten minutes for subject matches for bill, payment, overdue, shutoff, or disconnection. Only mail arriving after connection and within the last seven days is eligible. At most one alert per account per 24 hours is attempted. Alerts call matches possible notices and ask the user to review their inbox and share a notice. They do not assert amounts/deadlines or feed email contents to a model. Mail search can have false positives and miss notices. OAuth errors are logged without credentials or email content; users can reconnect if access was revoked. Long downtime beyond seven days may miss notices.

Delivery is reserved before sending to avoid duplicate outreach after ambiguous provider failures. Attempts are recorded as sent, uncertain, or cancelled for scheduled check-ins. An uncertain delivery is not automatically retried. The worker must remain running; this is an in-process worker, not an external scheduled service. SQLite reservations prevent simultaneous replicas sharing one database from duplicating alerts. Gmail disconnect removes local access; users can also revoke Google access in their Google account settings.

Serve the landing page and API on the same site (localhost ports are fine in development) so the HttpOnly SameSite=Lax OAuth binding cookie is accepted. Cross-site hosting needs a same-site API proxy. OAuth links cannot set their own browser-binding cookie; the originating authenticated POST sets it.

The browser capability remains in memory for the current intake dialog. Closing it ends that browser session. Choose **Already connected? Manage connection** on the landing page to reopen settings: enter the connected number, request a verification iMessage, and reply `MANAGE <code>` within five minutes. This grants a 20-minute browser session tied to the existing account without changing the saved case. Codes and browser tokens are hashed, sender-bound and rate-limited. STOP revokes management sessions. Messages commands remain available. Existing signed-in linking APIs are not the email management interface in this version.

## One-time call reminders

[Call follow-through](call-follow-through.md) adds bill-specific scripts, user-confirmed call notes and explicitly approved one-time reminders in Messages. `REMIND IN 2 DAYS` approves only that call reminder; it does not enable weekly check-ins or Gmail. `REMIND OFF` cancels only call reminders. `FOLLOWUPS OFF` and `RESOLVED` also cancel call reminders. `SNOOZE 1` through `SNOOZE 30` moves a scheduled call reminder as well as deferring active recurring check-ins and Gmail alerts. `STOP` and `UNSUBSCRIBE` delete call records, schedules and command receipts from the active database.
