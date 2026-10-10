# MoreTime live demo

Run from `~/MoreTime`, the root checkout used for current development:

```sh
cd ~/MoreTime
./run.sh
```

Stop an existing launcher with Ctrl+C before restarting. Open http://localhost:8000 and keep Messages visible. Startup runs typechecking and tests. Use one backend process. Photon credentials, a configured Gemini key and an eligible demo recipient are required. The landing-page sample conversations are scripted; the following sequence uses the live iMessage assistant.

## Five-minute story

1. Show guest intake. Upload `landing/dist/assets/example-utility-bill.pdf`, or use this fictional description for a simple installment demo: “My PSE&G utility statement says $180 due October 20, 2026. I live in Newark, New Jersey. I need help proposing installments.” Use your own eligible phone number and ZIP 07102, consent and submit. This description is fictional and does not establish an actual PSE&G policy. Reply `CONNECT <code>` in Messages. If already connected, continue there; use a new bill attachment to replace the document, or STOP before fresh intake.
2. Confirm extracted facts when asked. Ask: “What do I owe and when should I act?” Show the direct answer, next step and contact guidance. Extraction must be checked against the sample.
3. Say: “I can afford $30 per month.” Then: “Draft a short payment-plan request using that budget.” For the $180 text example, expect six proposed payments before fees/new charges. For the PDF, the installment count uses its actual extracted balance. Show that the budget is remembered and the plan is a proposal needing biller acceptance.
4. Ask: “Who should I contact at PSE&G in New Jersey about payment arrangements? Search current sources and give me the right department.” Show cited links and checked date. Open a source and compare the detail and department. Search may take longer than routine chat. If a contact cannot be supported, show the source-link/department fallback honestly.
5. Ask: “What does debt validation mean for a debt collector? Search current official sources and explain when it applies.” Show sourced terminology and applicability context. This separate example does not imply the utility bill is in collections. Then ask: “Have you contacted the company or sent anything?” Show that drafts and research are distinguished from completed outreach.

## Optional check-ins and Gmail

Keep the verified intake dialog open, or use **Already connected? Manage connection** and reply `MANAGE <code>` from the connected number. Choose a first check-in at least two or three minutes ahead, approve it, and click **Enable check-ins**. Keep the server running; the worker checks each minute. The first check-in is followed weekly for up to 90 days. Demonstrate `SNOOZE 7` or `FOLLOWUPS OFF` after the first delivery. These controls work without Gemini.

Connect Gmail only if OAuth is configured and the demo account is allowed. Read-only access looks for possible payment notices and does not send email. Alerts require active check-in approval, run on a ten-minute polling cadence and are limited to one attempt per day; do not rely on immediate delivery for a short presentation. Show the connection/settings instead, or use a prerecorded alert. See [setup](follow-ups-and-email.md). `EMAIL OFF` disconnects Gmail locally. `STOP` removes the case and both integrations from the active database; use it last.

## Rehearsal and fallback

Rehearse the same sequence before presenting. Use a fictional case and your own demo number. Keep a screenshot or recording of a successful sourced reply in case Gemini quota/service availability interrupts the presentation. The latest contact fix passed 108 tests and a synthetic live contact lookup, but live wording and availability vary. No additional web-search API key is needed.

To test Gemini research without sending Messages:

```sh
cd ~/MoreTime/more-time
node --env-file-if-exists=.env --import tsx src/gemini-combined-check.ts official-contact legal-term
```

Frame the demo as: understand the bill, remember what the person can afford, find sourced next steps, prepare a request, and check back with permission. Sending requests to billers, negotiation, guaranteed legal protections, Gmail-body analysis and deadline-aware reminders remain outside the implemented flow.
