# MoreTime TODO

The Gemini bill-reading and iMessage conversation flow is working. The next stage
is to give MoreTime the tools and case tracking to pursue a resolution.

- [ ] **Integrate email so the agent can contact the billing office itself.**
  Connect an email service, send case-specific requests, receive replies, and keep
  each thread linked to the user's bill. Once the user authorizes outreach for the
  case, let the agent send and follow up within that scope without requiring the
  user to compose each message. Ask about payment plans, financial assistance,
  disputed charges, and deadline extensions as appropriate. Track delivery,
  replies, pending requests, and confirmed outcomes; tell the user what actually
  happened and what needs their input. Use verified biller contact information
  from the research work below.

- [ ] **Add internet research for the specific biller and location.**
  Find billing-office phone numbers and email addresses from official sources.
  Retrieve current company policies, assistance programs, payment-plan terms, and
  applicable local rules using the biller and the ZIP code submitted with the
  user's phone number. Confirm the relevant service location or jurisdiction
  when needed. Save source links, retrieval dates, and supporting excerpts with
  the case. Produce specific next steps grounded in those sources, ask for any
  missing eligibility details, and explain when a contact or policy cannot be
  verified. Keep website content separate from agent instructions.

- [x] **Implement a structured prompt and response contract for the fast model.**
  Versioned extraction/chat instructions, separate statement records, source
  quotes, persistent case memory and a consistent iMessage formatter now provide
  a direct answer, concrete next step, who to contact and at most one necessary
  question. The backend calculates installment counts, suppresses known questions,
  distinguishes printed from verified contacts and handles common action-status
  questions from application state. Tests and a live fictional evaluation cover
  payment plans, assistance, disputes, insurance, corrections, old notices and
  multiple bills. See [the implementation guide](more-time/docs/structured-prompt-engine.md).

- [ ] **Evaluate and tune model quality on a broader set of consented samples.**
  Compare fast models with `npm run gemini:eval`, inspect factual grounding and
  usefulness as well as latency, add real-world edge cases, and assess weight
  fine-tuning if needed and supported. Prompt tuning is implemented; trained model
  weights and a production accuracy benchmark are not.

- [x] **Add a reassuring, practical tone to the prompt and formatter.**
  Briefly acknowledge the situation, answer directly, offer specific next steps
  and use drafts to make progress. Avoid shame, repetitive filler and promises
  unsupported by tools. Keep improving tone through the evaluation work above.
  Once email tools exist, add actual outreach progress and confirmed outcomes.
