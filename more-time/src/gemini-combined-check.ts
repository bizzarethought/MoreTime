import { GoogleGenAI } from "@google/genai";
import { createGeminiEngine } from "./gemini.ts";
import { assistantErrorCode } from "./assistant-error.ts";
import { bill as fixtureBill, statement, budgetCase } from "../test/structured-fixtures.ts";

// Synthetic case only. Does not access case databases, Photon or real bills.
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Combined check: no Gemini API key configured.");
  process.exitCode = 1;
} else {
  const client = new GoogleGenAI({ apiKey });
  let searches = 0;
  let publicEvidence: Record<number, string[]> = {};
  const engine = createGeminiEngine({
    apiKey, model: process.env.GEMINI_MODEL, chatModel: process.env.GEMINI_CHAT_MODEL,
    researchModel: process.env.GEMINI_RESEARCH_MODEL,
    generate: async request => {
      if (request.config?.tools?.some(tool => "googleSearch" in tool && tool.googleSearch)) searches++;
      try {
        const result = await client.models.generateContent(request);
        if (request.config?.tools?.some(tool => "googleSearch" in tool && tool.googleSearch)) {
          const metadata = result.candidates?.[0]?.groundingMetadata;
          publicEvidence = {};
          for (const support of metadata?.groundingSupports ?? []) for (const id of support.groundingChunkIndices ?? []) {
            (publicEvidence[id + 1] ??= []).push(support.segment?.text ?? "");
          }
        }
        if (request.config?.tools?.some(tool => "googleSearch" in tool && tool.googleSearch)) console.log(JSON.stringify({ stage: "research", model: request.model,
          finishReason: result.candidates?.[0]?.finishReason, sources: result.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0,
          supports: result.candidates?.[0]?.groundingMetadata?.groundingSupports?.length ?? 0 }));
        if (request.config?.responseJsonSchema && "sourceIds" in ((request.config.responseJsonSchema as { properties?: object }).properties ?? {})) {
          try { const output = JSON.parse(result.text ?? "{}"); console.log(JSON.stringify({ stage: "synthesis", sourceIds: Array.isArray(output.sourceIds) ? output.sourceIds.filter((id: unknown) => Number.isInteger(id)) : [],
            ...(process.env.MORETIME_SMOKE_DEBUG === "1" ? { answer: output.answer, nextStep: output.nextStep, draft: output.draft,
              citedEvidence: Object.fromEntries((output.sourceIds ?? []).map((id: number) => [id, publicEvidence[id]])) } : {}) })); } catch {}
        }
        return result;
      } catch (error) {
        if (request.config?.tools?.some(tool => "googleSearch" in tool && tool.googleSearch)) console.log(JSON.stringify({ stage: "research", model: request.model, code: assistantErrorCode(error) }));
        throw error;
      }
    },
  });
  const bill = { ...fixtureBill([statement({ biller: "PSE&G", summary: "Synthetic utility bill for testing, not a real account." })]), biller: "PSE&G" };
  let caseState = budgetCase(30);
  const history: { question: string; reply: string }[] = [];
  const samples = [
    { id: "remembered-budget", question: "Using my saved $30 monthly budget, what payment proposal could I prepare?", web: false },
    { id: "official-contact", question: "Who should I contact at PSE&G in New Jersey about a utility payment arrangement? Find the current official contact.", web: true },
    { id: "legal-term", question: "What does debt validation mean under US federal debt collection law? Find an official source and explain whether it necessarily applies to a utility bill.", web: true },
  ];
  let passed = 0;
  for (const sample of samples.filter(sample => !process.argv.slice(2).length || process.argv.slice(2).includes(sample.id))) {
    const started = performance.now();
    const before = searches;
    try {
      const result = await engine.respond!({ bill, caseState, history, question: sample.question,
        document: null, details: "Fictional test scenario only.", state: "NJ", zipCode: "07102", currentDate: "2026-10-10" });
      const ok = Boolean(result.response && /Next step:/.test(result.reply) && /Who to contact:/.test(result.reply)
        && (sample.web ? searches > before && /Sources \(checked/.test(result.reply) : /6 payments/.test(result.reply)));
      caseState = result.caseState ?? caseState;
      history.push({ question: sample.question, reply: result.reply });
      console.log(JSON.stringify({ case: sample.id, passed: ok, searchRequests: searches - before,
        elapsedMs: Math.round(performance.now() - started), reply: result.reply }));
      if (ok) passed++;
    } catch (error) {
      console.log(JSON.stringify({ case: sample.id, passed: false, searchRequests: searches - before,
        elapsedMs: Math.round(performance.now() - started), code: assistantErrorCode(error) }));
    }
  }
  const total = samples.filter(sample => !process.argv.slice(2).length || process.argv.slice(2).includes(sample.id)).length;
  console.log(JSON.stringify({ passed, total, note: "Synthetic live smoke checks; model wording still requires review." }));
  if (passed !== total) process.exitCode = 1;
}
