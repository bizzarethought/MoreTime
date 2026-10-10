# MoreTime

MoreTime is a hackathon project for people dealing with overdue bills, utility shutoff notices, and other essential-service problems. We want to help people understand protections and relief they might not know about, then help them ask for more time or resolve a disputed charge.

## What works so far

- Upload a PDF or bill image up to 10 MB, or describe the problem. Add a U.S. phone number and ZIP code or state. No account needed.
- Save those details and connect the conversation through Photon’s iMessage integration by replying with a verification code.
- After verification, Gemini reads the saved bill and answers follow-up questions in the same chat, using saved bill facts and the last ten conversation turns. This requires a configured Gemini API key.
- Send an updated bill directly in iMessage, or reply STOP to disconnect and remove the saved case from the active database.
- Try the landing page’s sample conversations about shutoffs, payment plans, and disputed bills.

The sample conversations are scripted New Jersey examples. The live Gemini assistant can explain bills and draft requests; policy retrieval, contacting billers, and automatic follow-ups are still being built.

## Tech stack

| Part | Technology |
| --- | --- |
| Frontend | HTML, CSS, and JavaScript |
| Backend | TypeScript on Node.js 24+, using Node’s HTTP server |
| Messaging | Photon Spectrum (`spectrum-ts`) for iMessage |
| Bill reading and chat | Google Gemini through `@google/genai` |
| Database | SQLite through Node’s built-in `node:sqlite` |
| Model output validation | Zod |
| Account authentication | JWT/JWKS verification with `jose` for account endpoints; guest intake needs no sign-in |
| Development and tests | npm, `tsx`, TypeScript, and Node’s test runner |

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

Add `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) to enable the assistant. Bill reading uses `GEMINI_MODEL` (default `gemini-3.8-flash`); routine chat uses `GEMINI_CHAT_MODEL` (default `gemini-3.5-flash-lite`). Without a Gemini key, phone verification still works, but bill analysis and chat are disabled.

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

SQLite creates `more-time/data/moretime.sqlite` when the backend starts. It stores intake details, uploaded bills, extracted facts, and conversation history. There’s no separate database service to set up; deployment needs persistent storage for that file.

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

## Next

The [TODO list](TODO.md) tracks agentic email outreach, internet research for biller
contacts and local policies, consistent output from fast models, and a helpful,
action-oriented tone. Bill extraction and conversational replies are connected
through Gemini; facts still need user confirmation.

See the [intake integration guide](landing/INTAKE_INTEGRATION.md) for the API and storage details, and [content sources](landing/CONTENT_SOURCES.md) for the sample conversations.
