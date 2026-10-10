import { geminiFromEnvironment } from "./gemini.ts";
import { assistantErrorCode } from "./assistant-error.ts";
import { evaluationCases } from "../test/evaluation-cases.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { setTimeout } from "node:timers/promises";

// Explicit, opt-in live benchmark. Sends synthetic saved cases only, no Photon
// messages, local database access or user documents. Normal API charges apply.
const engine = geminiFromEnvironment(process.env);
if (!engine?.respond) {
  console.error("Set GEMINI_API_KEY locally or in the process environment to run the fictional evaluation.");
  process.exitCode = 1;
} else {
  let passed = 0;
  const filter = process.argv.slice(2);
  const cases = filter.length ? evaluationCases.filter(sample => filter.includes(sample.id)) : evaluationCases;
  if (!cases.length) throw new Error("No matching fictional evaluation cases.");
  for (const [index, sample] of cases.entries()) {
    // Space requests for small development quotas; SDK retries remain bounded.
    if (index > 0) await setTimeout(4500);
    const started = performance.now();
    try {
      const result = await engine.respond({ bill: sample.bill, caseState: sample.caseState, question: sample.question,
        details: "", history: [], document: null, state: "NJ", zipCode: "07102", currentDate: "2026-10-10" });
      const ok = Boolean(result.response && (!sample.intents || sample.intents.includes(result.response.intent))
        && (!sample.check || sample.check(result)) && /Next step:/.test(result.reply) && /Who to contact:/.test(result.reply));
      if (ok) passed++;
      console.log(JSON.stringify({ case: sample.id, passed: ok, elapsedMs: Math.round(performance.now() - started),
        criterion: sample.criterion, question: sample.question, reply: result.reply, intent: result.response?.intent }));
    } catch (error) {
      console.log(JSON.stringify({ case: sample.id, passed: false, elapsedMs: Math.round(performance.now() - started), code: assistantErrorCode(error) }));
    }
  }
  console.log(JSON.stringify({ prompt: PROMPT_VERSION, passed, total: cases.length, note: "Structural and selected fact checks; review the wording against each criterion." }));
  if (passed !== cases.length) process.exitCode = 1;
}
