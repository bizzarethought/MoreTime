# Gemini bill extraction and iMessage chat

The backend uses the official `@google/genai` JavaScript SDK. Gemini is the main
engine for extracting bill facts and answering questions. The default model is
`gemini-3.8-flash` for bill analysis and source-document questions, and
`gemini-3.5-flash-lite` with minimal thinking for routine chat. `GEMINI_MODEL` and
`GEMINI_CHAT_MODEL` can select other available models for those respective tasks.

## Enable it

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. In your **existing** `more-time/.env`, add these settings locally. Keep your
   existing Photon credentials and other settings. Never put the key in the
   landing page or commit it.

   ```dotenv
   GEMINI_API_KEY=your-key-here
   GEMINI_MODEL=gemini-3.8-flash
   ```

3. From `/Users/rishikeshsrivatsan/MoreTime`, with Node 24+:

   ```sh
   npm run setup
   npm run typecheck
   npm test
   npm start
   ```

   Startup prints `Gemini bill analysis and chat are enabled.` when a key is
   configured. This confirms configuration, not that Google accepted the key.
   Restart the backend after changing environment settings.

4. Serve the landing page in a second terminal:

   ```sh
   python3 -m http.server 8000 --directory landing/dist
   ```

5. Open http://localhost:8000, submit a fictional bill or description, check the
   consent box, and reply with the `CONNECT ...` code in iMessage. On shared Photon
   projects, register your demo recipient in the Photon dashboard first. Gemini
   runs after verification and replies in the same chat. Try “What is due and
   when?”, “Can you help draft a payment-plan request?”, or send a clearer image.

If you've already connected, ask a question in that existing chat after restarting.
The first question starts analysis if no bill facts have been saved yet. The intake
endpoint rejects a new intake for an already connected number; send an updated
bill in the existing chat, or reply STOP before starting a new case.

## Check Gemini independently

This command makes a **real Gemini API request**, using a fictional text example.
It prints extraction and a reply; it does not open Photon or send any iMessages:

```sh
npm run gemini:check
```

To test the repository's fictional PDF, run this from the repository root. The
forwarded npm command runs inside `more-time/`, hence the `../landing/` path:

```sh
npm run gemini:check -- ../landing/dist/assets/example-utility-bill.pdf
```

Add `--follow-up` to test analysis followed by “Can I pay in installments?” using
the saved facts and conversation. This still sends no iMessages:

```sh
npm run gemini:check -- --follow-up ../landing/dist/assets/example-utility-bill.pdf
```

To check three successive chat replies without waiting for another extraction:

```sh
npm run gemini:check -- --chat-only
```

This uses fixed fictional facts and prints elapsed milliseconds for each reply.

If this fails, check key validity, model access, API quota/billing, the file, and
network access. Pick a supported model in AI Studio and set `GEMINI_MODEL` if the
default model is unavailable to your project. Do not paste your key into chat.

## If Gemini passes but iMessage fails

Stop the running backend with Ctrl+C and restart `npm start` from the repository
root. Environment changes are loaded on startup. Ask a new question in the existing
connected chat; you do not need another CONNECT code.

Confirm startup prints `Gemini runtime: version=3 prompt=structured-web-v1 saved_facts_first=true` with
`chat_timeout_ms=30000` (unless explicitly configured otherwise). This identifies
the new process and its effective timeout without exposing credentials.

The backend prints a safe diagnostic such as
`Bill assistant request failed: stage=analyze_bill code=invalid_model_output`.
Stages distinguish loading a saved case or attachment, bill analysis, answering a
question, and saving the reply. Codes identify API access denial, unavailable models,
quota/rate limits, rejected requests, timeouts, invalid JSON or bill facts, missing
evidence, and incomplete responses. Share this diagnostic line for troubleshooting;
it contains no API key, phone number, or bill contents. `unknown_error` means the
cause remains unclassified, rather than proving a Gemini configuration problem.

A successful text-only check does not test PDF/image processing. Use the fictional
PDF command above to check that path separately. The `echo:` replies are not sent by
this backend. If you see them, check other terminals or deployments for the original
Photon echo demo and stop that demo; keep one MoreTime backend running.

## What happens

- The existing guest intake remains unchanged: the website submits the file,
  description, phone and location; Photon sends a verification code.
- No bill data is passed to Gemini before the real sender verifies the code.
- Gemini receives document bytes inline, plus description and location. PDFs,
  JPEG, PNG, WebP, HEIC and HEIF are supported, up to 10 MB. iMessage attachments
  use the SDK's bounded stream and only the new content of threaded replies.
  Send one file per message. Text-only submissions also work.
- The first request returns structured facts **and** a conversational reply.
  Facts include biller, bill/notice type, amount, currency, separate due and
  shutoff dates, line items, source quotes and uncertainties. Unknown values
  remain null. Runtime validation rejects malformed output, impossible dates,
  unsupported critical facts, and incomplete responses. Extraction still needs
  user confirmation; source quotes are model-generated, not independent OCR proof.
- Follow-ups first use saved facts, persistent user case memory and the most recent ten conversation turns.
  Gemini can request the original/latest document when it needs source details
  absent from that context. The server then makes a second request with the retained
  document inline. General questions avoid reprocessing large packets every turn.
- Facts, documents, conversation and generated reply receipts persist in the existing
  gitignored SQLite database. Phone identities and verification codes are omitted
  from model context; documents can themselves contain personal information.
- Successful duplicate message deliveries reuse stored replies. If delivery fails,
  a redelivery can resend the cached reply without another model call. A crash after
  Photon accepted a send can still lead to a duplicate outward reply. Requests are
  serialized. Routine chat has a 30-second timeout (`GEMINI_CHAT_TIMEOUT_MS`);
  analysis and source-document calls have a 120-second timeout (`GEMINI_TIMEOUT_MS`).
  Both accept 1000–300000 milliseconds. Temporary HTTP errors can be retried once
  after a short delay; the same deadline bounds both attempts and the delay.
  Authentication and invalid-request errors are not retried. A question requiring the original
  document can make two calls. A crash before a completed
  response was stored can require another model call.
- Missing keys leave verification working and explain that analysis is disabled.
  Failed requests show a generic retry message and log a safe stage/error label; logs never include raw SDK errors,
  API keys or bill contents. Ask again in a new message to retry.
- `STOP` or `UNSUBSCRIBE` disconnects and deletes the case, intake and associated
  assistant reply receipts from the active database. This is not secure erasure
  of SQLite pages, backups, or Google's processing records. Other connected cases
  remain saved until STOP; a general retention schedule is not implemented.

## Limits and verification

This connector can explain a bill, answer questions and draft a request. It does
not contact billers, negotiate, submit assistance applications, change deadlines,
change account status. Separately, the application can send user-approved scheduled iMessage check-ins and optional Gmail notice alerts; see [the guide](follow-ups-and-email.md). Public web research is available for
contacts, policies, assistance programs and legal terms, with attributed source links.
The prompt forbids inventing eligibility, protections or completed actions.
Search grounding is source attribution, not independent verification or a guarantee
that a rule applies to the user. The assistant must confirm biller identity and
service jurisdiction before applying specific rules.

Automated tests inject fake model responses and cover schema validation, verification
gating, conversation isolation/persistence, duplicates, failures/retries, STOP,
disconnect during analysis, and bounded attachment streams. They do not establish
model accuracy. Live Gemini and Photon checks require your configured credentials.
See [the structured prompt guide](structured-prompt-engine.md) for the current
response contract, source/contact rules, tone, remembered case and live evaluation.

References: [Google GenAI SDK](https://ai.google.dev/gemini-api/docs/libraries),
[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite),
[document understanding](https://ai.google.dev/gemini-api/docs/generate-content/document-processing),
[structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).


## Public web research

Contact, policy, assistance and legal questions request a separate Gemini call with
`tools: [{ googleSearch: {} }]`. The integrated implementation on main defaults research to `gemini-2.5-flash`; extraction and chat keep their existing models. Project access and quotas must be checked in AI Studio. Optional settings:

```dotenv
GEMINI_RESEARCH_MODEL=gemini-2.5-flash
GEMINI_RESEARCH_TIMEOUT_MS=120000
```

No separate search API key is required. Your Gemini project must have access to the
model and Search grounding; Google's search billing/quota applies. See
[Google Search grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search).

The initial structured response requests research with `needsPolicyLookup` and a
`researchQuery` containing only public organization/topic/location information.
The public research request omits the uploaded document, private description,
balance and conversation history. Queries are model-composed with instructions to
omit personal details, plus best-effort redaction for common identifiers; this is
not a comprehensive data-loss prevention filter.

Only text passages with SDK grounding support and HTTPS source URLs are supplied
to the answer model. Search hits without attributed passages are excluded. The
answer selects `sourceIds`; application code validates them and appends source
links and a lookup date. URLs may be Google's grounding redirect links. Current
contacts and legal rules must not fall back to model memory when search fails or
returns no usable evidence. In that case the assistant explains the failed
verification and asks for an official page or missing organization/location.
Documents and arithmetic continue to use the normal flow without Search.

Research adds a Search request and a synthesis request after the initial routing
call. Each request has its own timeout; a research turn can take longer than a
routine chat turn. The final reply and source links use existing conversation
persistence and duplicate-delivery handling. Full research metadata is currently
transient, with `searchSuggestionsHtml` retained in the research result for HTML
clients; iMessage displays plain source links and cannot render the HTML widget.
Any future HTML client must follow Google's Search Suggestions display requirements.

Try: “Who do I contact about assistance?”, “What does debt validation mean?”, or
“What shutoff protections apply in my service location?” Missing identity or
jurisdiction should prompt clarification instead of selecting a similarly named
biller or assuming ZIP code alone establishes applicable law.

### Integrated checks on main

Both features are merged into main. From the repository root:

```sh
./run.sh --check
# Synthetic live calls; no Photon messages or real case/database access:
cd more-time
node --env-file-if-exists=.env --import tsx src/gemini-combined-check.ts
# Or select only research samples:
node --env-file-if-exists=.env --import tsx src/gemini-combined-check.ts official-contact legal-term
```

The combined-check npm script expects an already exported `GEMINI_API_KEY`; the commands above load local runtime configuration without printing credentials. Search quota is project/model dependent; successful routine chat does not prove Search access. In development, 3.8 Flash and 3.5 Flash-Lite Search returned 429, while 2.5 Flash returned grounding metadata. See [combined validation](combined-testing.md) and [demo steps](demo.md).
