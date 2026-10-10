# MoreTime

MoreTime is a hackathon project for people dealing with overdue bills, utility shutoff notices, and other essential-service problems. We want to help people understand protections and relief they might not know about, then help them ask for more time or resolve a disputed charge.

## What works so far

- Upload a bill or describe the problem, then add a phone number and ZIP code or state. No account needed.
- Save those details and connect the conversation through Photon’s iMessage integration by replying with a verification code.
- Try the landing page’s sample conversations about shutoffs, payment plans, and disputed bills.

The sample conversations are scripted New Jersey examples. Bill analysis and the AI assistant are still being built.

## Run locally

You’ll need Node.js 24+, npm, and Python 3. Run these commands from the repository root.

Install the backend dependencies:

```sh
npm run setup
```

Set up `more-time/.env` using [the example configuration](more-time/.env.example). Add your Photon `PROJECT_ID` and `PROJECT_SECRET`, keeping any existing settings. Your Photon project needs iMessage access and an eligible demo recipient. Guest intake does not need a sign-in provider.

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

The frontend is plain HTML, CSS, and JavaScript in `landing/dist`. The backend is TypeScript in `more-time/src`, using Photon Spectrum for messaging and SQLite for storage.

SQLite creates `more-time/data/moretime.sqlite` when the backend starts. There’s no separate database service to set up. Connected intake details stay saved; deployment needs persistent storage for that file.

Run the backend checks:

```sh
npm run typecheck
npm test
```

Use `npm run dev` to restart the backend automatically as you edit it.

## Next

Connect the resolution agent and Gemini, extract the important details from bills, and use verified local sources to help people understand their options and draft requests. Bills uploaded through the website are saved now; processing attachments sent directly through iMessage is still to come.

See the [intake integration guide](landing/INTAKE_INTEGRATION.md) for the API and storage details, and [content sources](landing/CONTENT_SOURCES.md) for the sample conversations.
