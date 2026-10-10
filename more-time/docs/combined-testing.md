# Integrated structured replies and web research

Both features are merged into main. Validation on October 10, 2026 passed TypeScript checks and 108 tests (104 backend/integration tests and four runner tests). Contact repair was committed as `6b8c186`. These counts describe that revision, not an automatically maintained benchmark.

Coverage includes persistent budget/case memory, statement selection, simultaneous document rereading and public lookup, citations, contact normalization, one bounded repair attempt, unsupported-contact fallback, and public research when the model omitted its lookup flag. Invented contacts remain rejected by the validator. Failed research does not ask a model to fill legal claims from memory.

Synthetic live tests returned sourced contact and legal-term answers using Gemini 2.5 Flash; a contact lookup passed again after the contact repair. Saved-budget checks produced six proposed payments toward a fictional $180 balance at $30 monthly. No real bills or Photon messages were used. Earlier runs encountered quota limits and transient service failures; live success does not establish repeatability or legal accuracy.

## Repeat validation

From the repository root:

```sh
./run.sh --check
cd more-time
node --env-file-if-exists=.env --import tsx src/gemini-combined-check.ts
# Selected cases:
node --env-file-if-exists=.env --import tsx src/gemini-combined-check.ts official-contact legal-term
```

The live command loads existing runtime configuration without displaying secrets, makes Gemini API calls and prints fictional replies/public source links. It does not send iMessages or access real case databases. Research defaults to `gemini-2.5-flash`, independently of extraction/chat. Access and quota depend on the configured project. Review wording, jurisdiction, source authority and department role even when checks pass.

See [Gemini setup](gemini-setup.md), [structured response behavior](structured-prompt-engine.md), and [demo walkthrough](demo.md).
