# Combined structured prompt and web research testing

Tested October 10, 2026 on local branch `test/combined-websearch-structureprompt`.
Worktree: `/Users/rishikeshsrivatsan/MoreTime/.worktrees/combined-test`.

Integrated commits:

- `2ab8f9e`: structured prompt/case engine.
- `ccf0c11`: Gemini Google Search grounding.

The integration preserves structured extraction, persistent case memory, statement
selection, document contact provenance, deterministic installment calculations and
application-controlled action status. It adds public research routing to both
analysis and follow-up responses, with validated source IDs and cited contact
passages. Routing fields are kept separate from document contacts. Failed research
returns a fixed application response rather than asking the model for legal or
policy claims from memory.

## Automated checks

- TypeScript typechecking passed.
- All 92 tests passed: 88 backend/integration tests and 4 runner tests.
- Conflict marker scan and `git diff --check` passed.
- Integration coverage includes simultaneous document rereading and public research,
  preserving a user's updated budget through research/synthesis, rejecting contact
  details absent from cited passages, and handling failed legal lookups without
  unsourced synthesis.

## Synthetic live checks

No real bills, case databases or Photon messages were used. Existing runtime
configuration was loaded only after explicit user authorization; credentials
were not printed or copied.

- Saved $30 budget: the structured response calculated six payments toward the
  fictional $180 balance and treated the plan as a proposal.
- Contact lookup: Gemini 2.5 Flash returned web grounding; the answer included
  public source links and contact details supported by cited passages.
- Legal-term lookup: Gemini 2.5 Flash returned a sourced explanation, with
  jurisdiction/applicability context and a government source link.

These passed in individual live runs. Earlier runs also exposed quota limits,
transient Google service errors, and citation/contact validation failures. The
suite verifies safe failure behavior; these checks are not a comprehensive
assessment of model accuracy or repeatability. Research was materially slower
than routine structured chat in these runs.

Gemini 3.8 Flash and 3.5 Flash-Lite Search calls returned quota/rate-limit errors;
2.5 Flash-Lite was unavailable to the configured project. The combined branch
therefore defaults only the research step to `gemini-2.5-flash`. Existing extraction
and chat model selections remain unchanged. `GEMINI_RESEARCH_MODEL` overrides it.
Google currently lists a free-tier grounding allowance for 2.5 Flash; check the
project's active limits in AI Studio before relying on that allowance.

References: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Google rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Repeat the checks

From the combined worktree:

```sh
npm run typecheck
npm test
```

With a Gemini API key exported into the runtime environment:

```sh
npm --prefix more-time run gemini:combined-check
npm --prefix more-time run gemini:combined-check -- official-contact legal-term
```

The live command does not start the app or send iMessages. No branch was pushed,
and main and the two original feature branches were not changed by integration.
