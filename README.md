# MoreTime

MoreTime is a hackathon project for people dealing with overdue bills, utility shutoff notices, and other essential-service problems. We want to help people understand protections and relief they might not know about, then help them ask for more time or resolve a disputed charge.

## What works so far

- Upload a PDF or bill image up to 10 MB, or describe the problem. Add a U.S. phone number and ZIP code or state. No account needed.
- Save those details and connect the conversation through Photon’s iMessage integration by replying with a verification code.
- After verification, Gemini reads the saved bill and answers follow-up questions in the same chat, using saved bill facts, persistent case memory and the last ten conversation turns. Structured replies include a next step and contact guidance, with printed contacts labeled as unverified current. This requires a configured Gemini API key.
- Send an updated bill directly in iMessage, or reply STOP to disconnect and remove the saved case from the active database.
- Try the landing page’s sample conversations about shutoffs, payment plans, and disputed bills.
- Match ZIP-based location and bill type to curated official assistance resources, then generate source-linked guidance with snapshot verification dates. Initial state-specific coverage is New Jersey, with national energy and hospital-assistance fallbacks.
- Research public biller contacts, assistance, policies and legal terms through Gemini Google Search, with cited sources and a checked date.
- Approve scheduled iMessage check-ins and optionally connect read-only Gmail for possible payment-notice alerts. Existing users can reopen settings through **Already connected? Manage connection**.

The landing-page sample conversations are scripted New Jersey examples. Live answers run in iMessage. The assistant prepares drafts; sending email to billers and negotiating agreements are still planned. See the [demo walkthrough](more-time/docs/demo.md) and [check-in/Gmail setup](more-time/docs/follow-ups-and-email.md).

## How assistance guidance is grounded

MoreTime combines bill extraction and payment calculations with ZIP-based matching to verified assistance resources, then generates source-linked guidance. This is a curated knowledge layer with deterministic resource matching and grounded generation. It does not implement a document RAG pipeline: there is no document indexing, chunking, embedding store or semantic search.

The backend resolves a ZIP through a bundled Census ZIP-area lookup, filters official resource records by state and bill type, and supplies the matching facts to Gemini. It validates resource IDs and appends official links with verification dates. Existing Google Search research handles current provider contacts, policies and legal questions separately.

A match identifies an assistance route; it does not establish eligibility or a payment hold. Census ZIP areas approximate postal ZIPs, and unknown or ambiguous locations need confirmation. See [resource coverage, implementation and maintenance](more-time/docs/assistance-resources.md).

## Tech stack

![HTML](https://img.shields.io/badge/HTML-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS-663399?style=for-the-badge&logo=css&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Photon Spectrum](https://img.shields.io/badge/Photon_Spectrum-111827?style=for-the-badge)
![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge&logo=zod&logoColor=white)
![npm](https://img.shields.io/badge/npm-CB3837?style=for-the-badge&logo=npm&logoColor=white)

Photon Spectrum handles iMessage, Gemini reads bills and answers questions, and
Zod validates model output. The backend uses Node’s HTTP server and built-in SQLite.
Account endpoints use `jose` for JWT verification; guest intake needs no sign-in.
Development uses `tsx` and Node’s test runner.

## Run locally

You’ll need Node.js 24+, npm, and Python 3. Run these commands from the repository root.

For one-command startup, use:

```sh
./run.sh
```

The launcher installs dependencies only if they are missing or differ from the
lockfile, then gates startup on TypeScript checks and tests. It starts the backend
and landing page together; Ctrl+C stops both and their child processes. Existing
environment settings are loaded by the backend as usual.

Use `./run.sh --dev` for automatic backend reloads, or `./run.sh --check` to run
the gates without starting services. `npm run run` is an equivalent npm shortcut.
The landing page defaults to port 8000; `--port 8001` selects another port (also
update your backend's `ALLOWED_ORIGINS` locally if you change it). If a service is
already running on the selected port, stop that existing service first. The
launcher works when invoked by its absolute path from another directory.

The individual commands below remain available for manual startup.

Install the backend dependencies:

```sh
npm run setup
```

Set up `more-time/.env` using [the example configuration](more-time/.env.example). Add your Photon `PROJECT_ID` and `PROJECT_SECRET`, keeping any existing settings. Your Photon project needs iMessage access and an eligible demo recipient. Guest intake does not need a sign-in provider.

Add `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) to enable the assistant. Bill reading uses `GEMINI_MODEL` (default `gemini-3.8-flash`); routine chat uses `GEMINI_CHAT_MODEL` (default `gemini-3.5-flash-lite`). Public Search uses `GEMINI_RESEARCH_MODEL` (default `gemini-2.5-flash`) and the same key; no additional search key is needed. Without a Gemini key, phone verification still works, but bill analysis and chat are disabled.

Start the backend:

```sh
npm start
```

In a second terminal, serve the landing page:

```sh
python3 -m http.server 8000 --directory landing/dist
```

Open [localhost:8000](http://localhost:8000). The API runs on port 8080. If you’ve set `ALLOWED_ORIGINS`, include `http://localhost:8000`.

To look at the page and sample conversations without connecting Photon, just run the Python command.

## Development

Frontend files are in `landing/dist`, backend code is in `more-time/src`, and tests are in `more-time/test`. Python serves the static page locally and generates the sample bill assets.

SQLite creates `more-time/data/moretime.sqlite` when the backend starts. It stores intake details, uploaded bills, extracted facts, conversation history, call notes, and approved reminder schedules. There’s no separate database service to set up; deployment needs persistent storage for that file.

Run the backend checks:

```sh
npm run typecheck
npm test
```

Tests use simulated Photon and Gemini responses and do not require API credentials.

Use `npm run dev` to restart the backend automatically as you edit it.

Check Gemini independently with `npm run gemini:check`. This sends a fictional
text example to Gemini and prints extracted facts and a reply, without opening
Photon or sending an iMessage. See [Gemini setup](more-time/docs/gemini-setup.md)
for the sample PDF command, storage behavior, and current limits.
Read the [structured prompt guide](more-time/docs/structured-prompt-engine.md) for
case memory, tone, output rules and the fictional `npm run gemini:eval` benchmark.

## Next

The [TODO list](TODO.md) tracks an editable email-send form, automatically inferred deadline check-ins, durable research evidence storage, and broader model evaluation. Structured replies, persistent case memory, public web research, approved check-ins, call follow-through and optional Gmail notice monitoring are implemented; extracted facts still need user confirmation.

See the [intake integration guide](landing/INTAKE_INTEGRATION.md) for the API and storage details, and [content sources](landing/CONTENT_SOURCES.md) for the sample conversations.

## Call follow-through

In the connected iMessage chat, reply `CALL` for a bill-specific script. After calling, send `CALLED` followed by your notes, then `CONFIRM CALL`. Approve one contextual check-in with `REMIND IN 2 DAYS`; use `CALL STATUS` to review it or `REMIND OFF` to cancel. This needs no Gmail connection or recurring check-in subscription. Notes are your account of the call, not independently verified terms. See [the commands and delivery limits](more-time/docs/call-follow-through.md).
