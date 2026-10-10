# MoreTime

Tentative name: **MoreTime**  
Pitch: **Text us the bill you can't afford. We help you understand your options, prepare your request, and follow the case toward resolution.**

## Current status

MoreTime is in the planning stage for a 24-hour hackathon. This repository currently contains the project README; application code, dependencies, messaging integration, datasets, and model training have not been added yet. The architecture and features below describe the intended build.

## Getting started

Start with the MVP scope, build order, and open decisions below. There are no installation or application run commands yet. Setup instructions will be added when the backend and its dependencies are implemented.

To review local changes from the repository directory:

```sh
git status
git diff -- README.md
```

## Concept

MoreTime is a conversational notice-resolution assistant delivered through iMessage. A user sends a bill or notice, describes their circumstances, and receives grounded guidance and help preparing their next action. The assistant remembers the case and adapts when the user reports a refusal, an offer, a missing document, or a new deadline.

The aim is to build a useful agent with a credible ML evaluation and a strong live demonstration, while avoiding custom web frontend work.

## Hackathon MVP

- Support one notice category initially: choose medical bills or utility overdue notices.
- Receive a photo or PDF and follow-up texts through a messaging integration.
- Extract the sender, balance, notice type, and separately identified deadlines.
- Confirm critical or uncertain facts with the user.
- Ask about affordability and relevant circumstances.
- Retrieve options from a small, verified set of policy documents.
- Explain supported options and draft a call script or written request.
- Track offers, refusals, requested documents, actions, and confirmed dates.
- Present the next step within the conversation.

Initial scope is helping the user take action. Direct negotiation with providers, payments, and broad legal coverage are future directions.

## Interface and architecture

**iMessage → messaging webhook → Python backend → models and tools → case database → reply**

- **Messaging:** Evaluate Photon first because it was suggested for the project. Verify current API access, incoming attachments, outgoing replies, and webhook behavior before committing. Provider suitability is not yet established.
- **Backend:** A small Python service handles incoming events and coordinates processing. Handle duplicate events so repeated delivery does not create duplicate case updates.
- **Document processing:** A vision-capable model or OCR plus extraction produces structured facts. Preserve document evidence and distinguish missing information from inferred information.
- **Resolution agent:** An LLM asks questions, retrieves policy evidence, explains options, and drafts messages.
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

- Medical bills or utility overdue notices?
- Messaging provider and attachment support?
- Event classifier plus extraction, or generative structured-update fine-tuning?
- Compute availability and team responsibilities within the 24-hour hackathon?
- Who will own blind-test preparation and keep the answer keys hidden?
