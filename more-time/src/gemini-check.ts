import { readFile, stat } from "node:fs/promises";
import { extname, basename } from "node:path";
import { geminiFromEnvironment, MAX_DOCUMENT_BYTES } from "./gemini.ts";
import type { BillDocument, BillFacts, ChatTurn } from "./gemini.ts";
import { assistantErrorCode } from "./assistant-error.ts";

// Run manually to check Gemini without opening Photon or sending any messages.
let stage = "configuration";
let stageStarted = performance.now();
try {
  const engine = geminiFromEnvironment(process.env);
  if (!engine) {
    console.error("Set GEMINI_API_KEY locally in more-time/.env or your process environment first.");
    process.exitCode = 1;
  } else {
    const args = process.argv.slice(2);
    const chatOnly = args.includes("--chat-only");
    const followUp = args.includes("--follow-up") || chatOnly;
    const path = args.find(arg => arg !== "--follow-up" && arg !== "--chat-only");
    if (chatOnly && path) throw new Error("invalid_document");
    stage = "load_document";
    let document: BillDocument | null = null;
    if (path) {
      const types: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" };
      const type = types[extname(path).toLowerCase()];
      if (!type || (await stat(path)).size > MAX_DOCUMENT_BYTES) throw new Error("invalid_document");
      document = { name: basename(path), type, bytes: await readFile(path) };
    }
    const input = {
      document, state: "NJ", zipCode: null, history: [],
      details: document ? "This is a fictional sample bill for a demo." : "Fictional example: Example Electric says USD 180 is overdue, due October 20, 2026. I can’t afford the whole bill. There is no stated shutoff date.",
      question: "Help me understand the bill and tell me what information you need next.",
    };
    stage = "analyze_bill";
    stageStarted = performance.now();
    const fixture: BillFacts = { biller: "Example Electric", billType: "utility", noticeType: "overdue",
      amountDue: 180, currency: "USD", dueDate: "2026-10-20", shutoffDate: null,
      summary: "Fictional overdue electricity bill.", lineItems: [],
      evidence: [], uncertainties: ["Installment terms have not been provided."] };
    const result = chatOnly ? { bill: fixture, reply: "Please confirm the $180 overdue balance." } : await engine.analyze(input);
    if (!chatOnly) {
      console.error(`Gemini check: stage=${stage} elapsed_ms=${Math.round(performance.now() - stageStarted)}.`);
      console.log(JSON.stringify(result, null, 2));
    }
    if (followUp) {
      stage = "answer_question";
      const history: ChatTurn[] = [{ question: input.question, reply: result.reply }];
      const questions = chatOnly ? ["Can I pay in installments?", "I can afford $30 per month. What should I ask for?", "Draft a short message asking for that payment plan."] : ["Can I pay in installments?"];
      for (const question of questions) {
        stageStarted = performance.now();
        const reply = await engine.answer({ ...input, bill: result.bill, question, history });
        console.error(`Gemini check: stage=${stage} elapsed_ms=${Math.round(performance.now() - stageStarted)}.`);
        console.log(JSON.stringify({ question, reply }, null, 2));
        history.push({ question, reply });
      }
    }
  }
} catch (error) {
  console.error(`Gemini check failed: stage=${stage} code=${assistantErrorCode(error)} elapsed_ms=${Math.round(performance.now() - stageStarted)}. Check your API key, model access, quota, connection, and sample file. No messages were sent.`);
  process.exitCode = 1;
}
