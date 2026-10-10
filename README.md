# MoreTime

Tentative name: **MoreTime**  
Pitch: **Text us the bill or shutoff notice. We help you discover protections, find available relief, and take the next step.**

## Current status

MoreTime is a hackathon prototype with a responsive landing page, scripted conversation previews, and a Node/TypeScript backend using Photon for iMessage. Visitors can submit a bill and/or text, phone number, and ZIP code or state without creating an account. The backend saves the intake and sends a verification message; replying with the code links the details to that conversation. Live delivery requires configured Photon credentials and an eligible recipient. The resolution agent, Gemini integration, document analysis, datasets, and model training are still future work.

## Getting started

The landing page uses plain HTML, CSS, and JavaScript with no dependencies. Serve it from the repository directory:

```sh
python3 -m http.server 8000 --directory landing/dist
```

Visit http://localhost:8000. “Start with a conversation” opens the intake form. Nothing is uploaded until the visitor reviews their details, agrees to receive a connection message, and chooses **Send & connect**. The next screen shows the code to reply with in Messages and checks for confirmation. Closing clears the browser form; confirmed intake details remain saved on the server for the future agent. Animation respects reduced-motion preferences and can also be paused in the navigation.

For intake submission, run the backend in another terminal with Node 24+:

```sh
npm run setup
npm run typecheck
npm test
npm start
```

Configure `PROJECT_ID` and `PROJECT_SECRET` locally in `more-time/.env` or the process environment first. If `ALLOWED_ORIGINS` is set, include `http://localhost:8000`. The API defaults to port 8080; guest intake needs no sign-in configuration. See the [intake integration guide](landing/INTAKE_INTEGRATION.md) for setup, the request contract, data retention, and the future agent handoff.

The separate guided preview still uses fictional situations: share details, explore a relevant option, and get a call script or written request. Earlier messages remain in the conversation, and finished drafts can be copied.

In “This bill can’t be right,” select **Attach the sample bill** to add a fictional PDF to the conversation. Open the attachment, confirm its details, and continue to a billing-review draft. The PDF and thumbnail are generated from `landing/sample-bill.json` with `python3 landing/scripts/generate-sample-bill.py`.

The examples focus on utility shutoff protection, deferred payment rights, and disputed charges. They use explicitly labeled New Jersey scenarios with links to official regulator guidance. New Jersey is the demonstration jurisdiction; the live MVP jurisdiction still needs to be selected. See [content sources](landing/CONTENT_SOURCES.md).

The headline, “Life’s bigger than a bill,” has an animated circle that redraws on hover. The artwork floats and responds to desktop pointer movement, while primary buttons slowly change color. Icons use locally hosted Material Symbols; their license and source details are in the asset notes.

Landing page files:

- `landing/dist/index.html` — content and page structure.
- `landing/dist/style.css` — responsive layouts and animations.
- `landing/dist/app.js` — scenario selection, continuation, replay, and motion controls.
- `landing/dist/intake.js`, `intake.css`, and `intake-api.js` — intake form, review, upload submission, and connection status.
- `landing/dist/assets/moretime-hero.png` — original generated illustration; see [asset notes](landing/ASSETS.md) for the generation prompt.

The page was visually reviewed in Chrome at desktop and 390-pixel mobile widths. Browser checks covered image loading, mobile overflow, all three conversation flows, replay, rapid scenario switching, keyboard focus, and reduced motion.

Sites hosting is configured in `landing/.openai/hosting.json`. Publication is pending; the Sites publishing helpers require Node.js, which is not installed in the current environment.

For backend details, see [more-time/README.md](more-time/README.md). The scope and build order below describe the remaining resolution-agent work.

To review local changes from the repository directory:

```sh
git status
git diff -- README.md
```

## Concept

MoreTime is a planned conversational notice-resolution assistant delivered through iMessage, focused on utilities and essential services. A user sends a bill or shutoff notice, shares their location and circumstances, and gets help discovering applicable consumer protections, assistance programs, and options for more time. The assistant helps prepare the next action and tracks the case through refusals, offers, missing documents, and new deadlines.

The core value is helping people discover rights and relief they may not know exist. Recommendations must connect the user's situation to a verified local rule or program, explain its conditions, and distinguish possible eligibility from confirmed protection. Eviction was an illustration of this broader idea; it is not the product's primary focus.

The aim is to build a useful agent with a credible ML evaluation and a strong live demonstration, while avoiding custom web frontend work.

## Hackathon MVP

- Start with utility overdue and shutoff notices; select one jurisdiction and utility service for the MVP.
- Receive a photo or PDF and follow-up texts through a messaging integration.
- Extract the sender, balance, notice type, and separately identified deadlines.
- Confirm critical or uncertain facts, including location, utility provider, service type, and notice dates.
- Ask about affordability and relevant circumstances.
- Retrieve protections and relief from a small, verified set of regulator guidance, applicable rules, assistance programs, and provider policies.
- Explain supported options and draft a call script or written request.
- Track offers, refusals, requested documents, actions, and confirmed dates.
- Present the next step within the conversation.

Initial scope is helping the user understand applicable utility protections and take action. Direct negotiation with providers, payments, legal representation, and coverage beyond the supported jurisdiction are outside the MVP.

## Interface and architecture

**Landing-page intake → Node/TypeScript API + SQLite → Photon iMessage verification → future resolution agent → reply**

- **Messaging:** Photon Spectrum supplies the existing iMessage transport and incoming message loop. A sender must reply with their connection code before the intake is associated with that conversation. The loop deduplicates incoming messages; iMessage attachment downloading is still future work.
- **Backend:** A Node 24+ TypeScript service validates guest intake, stores details and uploaded bills in SQLite, and exposes connection status. Separate signed-in account endpoints retain their JWT authentication.
- **Document processing:** A vision-capable model or OCR plus extraction produces structured facts. Preserve document evidence and distinguish missing information from inferred information.
- **Resolution agent:** An LLM asks questions, retrieves evidence for the correct jurisdiction and provider, explains protections and relief, and drafts requests or disputes.
- **Case logic:** Code validates dates, calculates payments, and controls state transitions. Proposed changes are distinct from confirmed agreements.
- **Storage:** Persist case facts, messages, source documents, policy references, action history, and next steps.

Jev is optional for bounded classification or routing. It is not required for the MVP or the fine-tuning component.

## Fine-tuning component

Preferred task: **conversation context → structured case update**.

Example input: the user previously requested an affordable payment plan and now says, "They offered $120 a month starting November 3."

Expected update:

```json
{
  "event": "payment_plan_offered",
  "monthly_payment": 120,
  "start_date_text": "November 3",
  "agreement_confirmed": false,
  "needs_date_confirmation": true
}
```

Begin with a pretrained small text model for event classification. Add amount/date extraction if time permits; a classifier alone does not produce the full structured update. A small generative model fine-tuned on input/output pairs is another route, with greater training and validation complexity.

Useful events include extension offered, payment plan offered, request refused, documents requested, application submitted, awaiting response, and unclear. Support multiple events when a message contains more than one.

Compare the trained component against a prompted LLM baseline. Keep it if it improves accuracy, latency, or cost. Do not claim an improvement without measuring it. Current assistance policies should come from retrieval rather than being memorized through fine-tuning.

## Data and labels

Build case packets containing:

1. A notice image or PDF.
2. User circumstances and affordability.
3. A policy document or policy packet.
4. Follow-up conversation turns.
5. Expected extracted facts, supported options, required questions, and case updates.

For synthetic notices, generate structured facts first, render the document from those facts, and retain the source record as ground truth. Review the rendered documents for consistency. Use explicitly fictional providers and label simulated cases clearly.

For conversations, write varied examples and human-review the expected updates. Include ambiguous messages, corrections, multiple events, and incomplete dates. An LLM can draft examples, but its answers are not automatically ground truth.

Public sample notices and consented, redacted real documents can provide realism. Existing receipt/form datasets may help document extraction but do not supply the complete resolution-task labels.

## Evaluation and blind testing

- Maintain separate training, validation, and hidden test sets.
- Split by case/scenario family and notice template before creating paraphrases or scan variants.
- Keep every message, page, and augmentation from a case in the same split.
- Use validation data to tune prompts, checkpoints, and thresholds.
- Freeze the system before opening the blind test set.
- Have someone outside implementation prepare or retain the hidden cases and answer keys.
- Report synthetic and real-document performance separately.

Measure field-level amount/date accuracy, event classification, complete case-update accuracy, unsupported recommendations, appropriate clarification, and response latency. Compare against the baseline on identical inputs.

For strategy and scripts, use a reviewed rubric rather than a single exact answer. Each policy-dependent recommendation should be traceable to evidence. A simulated offer or successful draft is not proof that a real provider would agree.

## Demo story

1. A judge chooses an unseen case and sends its notice through iMessage.
2. MoreTime extracts and confirms the important facts.
3. The user says, "I can afford $50 a month."
4. MoreTime identifies options supported by the case's policy packet and prepares a request.
5. A hidden follow-up reveals a setback or an offer: "They offered $120 a month."
6. MoreTime preserves the $50 budget, records the offer, and drafts a counterrequest.
7. The user reports a revised agreement. MoreTime confirms the terms and updates the case.

Also test a case where the correct response is to ask for a clearer image or additional information. The demo should demonstrate adaptation and reliable case tracking, with a compact benchmark supporting the ML contribution.

## Build order

1. Choose the notice category and establish the case schema.
2. Prove the messaging integration: receive a photo and send a reply.
3. Build one complete case flow using a pretrained model and policy packet.
4. Add persistence, structured updates, validation, and evidence links.
5. Prepare labeled development cases and a separately held blind set.
6. Train and benchmark the selected ML component.
7. Rehearse the unseen-case workflow and prepare a clearly labeled backup recording.

## Possible directions

- **Assistance applications:** Turn verified requirements into a checklist and help users prepare missing information.
- **Long-term case management:** Track multiple notices, commitments, and user-authorized reminders.
- **Provider communication:** With explicit user authorization, send requests and track replies; distinguish drafts, submissions, and confirmed agreements.
- **Policy discovery:** Expand to verified provider-specific sources with freshness checks and source history.
- **Document comparison:** Identify changes between original and revised bills, policies, or offers.
- **Nonprofit partnerships:** Support counselors helping people manage cases, with review and appropriate access controls.
- **Multilingual support:** Explain notices and prepare requests in the user's preferred language, evaluated separately.

## Product boundaries

- Do not invent eligibility, rights, deadlines, provider policies, or successful outcomes.
- Confirm unclear dates and important commitments before storing them as final.
- Preserve the distinction between the user's report, document evidence, and model inference.
- Treat bills and conversations as sensitive data; use synthetic cases for the demo and minimize stored personal information.
- External messages, applications, and payments require explicit user authorization.

## Decisions still open

- Which jurisdiction, utility service, and providers should the live MVP support?
- Messaging provider and attachment support?
- Event classifier plus extraction, or generative structured-update fine-tuning?
- Compute availability and team responsibilities within the 24-hour hackathon?
- Who will own blind-test preparation and keep the answer keys hidden?
