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

- [ ] **Standardize useful output from a fast model.**
  Define a structured response contract and a consistent iMessage presentation:
  what we understand, the relevant verified option, the next action, its status,
  and at most one or two necessary questions. Show only the parts that matter for
  that turn. Preserve amounts, deadlines, source references, uncertainty, and
  action status across model choices. Build examples and evaluation cases for
  payment plans, assistance, disputes, old notices, and multiple bills; tune the
  prompts and assess model fine-tuning if needed and supported. Measure latency
  and usefulness together so fast responses remain specific and actionable.

- [ ] **Make the tone helpful, eager, and focused on resolving the issue.**
  Acknowledge the user's situation briefly, use clear conversational language,
  offer a concrete next step, and take ownership of work the agent can perform.
  Prefer “I can ask the billing office about a payment plan” once that tool is
  available. Give concise progress updates and distinguish a proposed action,
  a sent request, and an agreement confirmed by the biller. Avoid repetitive
  disclaimers, generic advice, and promises unsupported by actual actions.
