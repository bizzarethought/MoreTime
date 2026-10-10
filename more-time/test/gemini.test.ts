import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason, ThinkingLevel } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { createGeminiEngine, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_CHAT_MODEL, DEFAULT_GEMINI_TIMEOUT_MS, DEFAULT_GEMINI_CHAT_TIMEOUT_MS, geminiFromEnvironment, MAX_DOCUMENT_BYTES } from "../src/gemini.ts";
import { statementsFor } from "../src/case.ts";
import type { AssistantInput, BillFacts } from "../src/gemini.ts";
import { bill as structuredBill, statement, response, budgetCase } from "./structured-fixtures.ts";

const facts: BillFacts = {
  biller: "Example Electric", billType: "utility", noticeType: "regular_bill",
  amountDue: 286, currency: "USD", dueDate: "2026-10-20", shutoffDate: null,
  summary: "Electricity bill with an estimated reading.",
  lineItems: [{ description: "Electricity", amount: 286 }],
  evidence: [
    { field: "biller", quote: "Example Electric", source: "document" },
    { field: "amountDue", quote: "$286", source: "document" },
    { field: "currency", quote: "USD", source: "document" },
    { field: "dueDate", quote: "October 20, 2026", source: "document" },
  ],
  uncertainties: ["An estimated reading does not establish an error."],
};
// Adapt the legacy fixture wording to the new structured model contract.
function modelOutput(value: any): string {
  if (value && typeof value === "object" && "reply" in value) {
    const response = { intent: "understand", answer: value.reply, concern: null,
      supportingStatementIds: ["bill_1"], nextStep: { kind: "clarify_bill", text: "Ask the billing office to clarify the statement." },
      contact: { statementId: "bill_1", contactIndex: null, department: "billing" },
      question: null, draft: null, needsDocument: value.needsDocument ?? false,
      needsPolicyLookup: false, caseUpdates: [] };
    value = value.bill ? { bill: { ...value.bill, statements: statementsFor(value.bill) }, response } : response;
  }
  return JSON.stringify(value);
}

const input: AssistantInput = {
  details: "My bill doubled", state: "NJ", zipCode: null, history: [],
  document: { name: "sample.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4\nFictional sample") },
  question: "What does this bill say?",
};

test("Gemini uses inline documents and a validated JSON schema on the configured model", async () => {
  let captured: GenerateContentParameters | undefined;
  const engine = createGeminiEngine({ apiKey: "test-only-not-a-real-key", generate: async request => {
    captured = request;
    return { text: modelOutput({ bill: facts, reply: "I see $286 due October 20. Can you confirm that?" }) };
  } });
  assert.deepEqual((await engine.analyze(input)).bill, { ...facts, statements: statementsFor(facts) });
  assert.equal(captured!.model, DEFAULT_GEMINI_MODEL);
  assert.equal(captured!.config?.responseMimeType, "application/json");
  assert.ok(captured!.config?.responseJsonSchema);
  assert.doesNotMatch(JSON.stringify(captured!.config?.responseJsonSchema), /maxItems|maxLength|pattern/);
  assert.match(JSON.stringify(captured!.config?.responseJsonSchema), /required|properties|enum/);
  assert.equal(captured!.config?.httpOptions?.timeout, DEFAULT_GEMINI_TIMEOUT_MS);
  const contents = captured!.contents as { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
  const document = contents[0]!.parts.find(part => part.inlineData)?.inlineData;
  assert.equal(document?.mimeType, "application/pdf");
  assert.equal(Buffer.from(document!.data, "base64").toString(), "%PDF-1.4\nFictional sample");
  assert.ok(!modelOutput(captured).includes("test-only-not-a-real-key"));
});

test("follow-up requests include the bill, location and recent history without phone or account identity", async () => {
  let captured: GenerateContentParameters | undefined;
  const engine = createGeminiEngine({ apiKey: "fixture", chatModel: "custom-gemini-model", generate: async request => {
    captured = request; return { text: modelOutput({ reply: "You can ask for a review of the estimated reading.", needsDocument: false }) };
  } });
  const history = Array.from({ length: 15 }, (_, index) => ({ question: `Question ${index}`, reply: `Reply ${index}` }));
  assert.match(await engine.answer({ ...input, bill: facts, history }), /estimated reading/);
  assert.equal(captured!.model, "custom-gemini-model");
  const text = modelOutput(captured);
  assert.ok(text.includes("Example Electric")); assert.ok(text.includes('\\"state\\":\\"NJ\\"'));
  assert.ok(!text.includes('Question 0"')); assert.ok(text.includes("Question 14"));
  assert.match(String(captured!.config?.systemInstruction), /NO tools to call/);
  assert.match(String(captured!.config?.systemInstruction), /No policy-retrieval tool exists/);
  assert.ok(!text.includes('"inlineData"'), "general questions do not resend the original packet");
});

test("follow-ups retrieve the original document when source details are needed", async () => {
  const requests: GenerateContentParameters[] = [];
  const engine = createGeminiEngine({ apiKey: "fixture", timeoutMs: 90_000, generate: async request => {
    requests.push(request);
    return { text: modelOutput(requests.length === 1
      ? { reply: "I need to read the source.", needsDocument: true }
      : { bill: facts, reply: "The document shows an estimated reading. Please confirm with your biller." }) };
  } });
  assert.match(await engine.answer({ ...input, bill: facts, question: "What does the meter-reading section say?" }), /document shows/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.model, DEFAULT_GEMINI_CHAT_MODEL);
  assert.equal(requests[0]!.config?.thinkingConfig?.thinkingLevel, ThinkingLevel.MINIMAL);
  assert.equal(requests[0]!.config?.httpOptions?.timeout, DEFAULT_GEMINI_CHAT_TIMEOUT_MS);
  assert.equal(requests[1]!.model, DEFAULT_GEMINI_MODEL);
  assert.ok(!modelOutput(requests[0]).includes('"inlineData"'));
  assert.ok(modelOutput(requests[1]).includes('"inlineData"'));
  assert.equal(requests[1]!.config?.httpOptions?.timeout, 90_000);
});

test("missing originals cannot trigger a document request and timeout settings are validated", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    calls++; return { text: modelOutput({ reply: "Please upload the statement.", needsDocument: true }) };
  } });
  assert.match(await engine.answer({ ...input, document: null, bill: facts }), /^Please upload the statement\./);
  assert.equal(calls, 1);
  for (const value of ["NaN", "0", "300001", "1.5"]) {
    assert.throws(() => geminiFromEnvironment({ GEMINI_API_KEY: "fixture", GEMINI_TIMEOUT_MS: value }), /GEMINI_TIMEOUT_MS/);
    assert.throws(() => geminiFromEnvironment({ GEMINI_API_KEY: "fixture", GEMINI_CHAT_TIMEOUT_MS: value }), /GEMINI_CHAT_TIMEOUT_MS/);
  }
});

test("malformed, unsupported and unfinished model outputs are rejected", async () => {
  const invalid = [
    "not JSON",
    modelOutput({ bill: { ...facts, amountDue: "286" }, reply: "Wrong type" }),
    modelOutput({ bill: { ...facts, dueDate: "2026-02-30" }, reply: "Impossible date" }),
    modelOutput({ bill: { ...facts, evidence: [] }, reply: "No evidence" }),
    modelOutput({ bill: facts, reply: "" }),
    modelOutput({ bill: facts, reply: "x".repeat(2401) }),
  ];
  for (const text of invalid) {
    const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text }) });
    await assert.rejects(engine.analyze(input));
  }
  const empty = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: undefined }) });
  await assert.rejects(empty.analyze(input), /gemini_incomplete_response/);
  const truncated = createGeminiEngine({ apiKey: "fixture", generate: async () => ({
    text: modelOutput({ bill: facts, reply: "A partial response" }),
    candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
  }) });
  await assert.rejects(truncated.analyze(input), /gemini_incomplete_response/);
});

test("text-only extraction accepts missing fields and rejects fabricated document evidence", async () => {
  const unknown: BillFacts = {
    ...facts, biller: null, amountDue: null, currency: null, dueDate: null, evidence: [], lineItems: [],
    summary: "The user describes an unaffordable bill; amount and date are unknown.",
  };
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({
    text: modelOutput({ bill: unknown, reply: "How much is due, and when?" }),
  }) });
  assert.equal((await engine.analyze({ ...input, document: null })).bill.dueDate, null);
  const fabricated = createGeminiEngine({ apiKey: "fixture", generate: async () => ({
    text: modelOutput({ bill: facts, reply: "Wrong source" }),
  }) });
  await assert.rejects(fabricated.analyze({ ...input, document: null }), /invalid_evidence_source/);
});

test("unsupported or oversized documents never reach Gemini and absent keys leave the assistant disabled", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => { calls++; return { text: "{}" }; } });
  await assert.rejects(engine.analyze({ ...input, document: { ...input.document!, type: "text/html" } }));
  await assert.rejects(engine.analyze({ ...input, document: { ...input.document!, bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) } }));
  assert.equal(calls, 0);
  assert.equal(geminiFromEnvironment({}), undefined);
  assert.throws(() => createGeminiEngine({ apiKey: " " }), /GEMINI_API_KEY/);
});

test("the real Google SDK builds a generateContent request and decodes structured output", async (t) => {
  let payload: Record<string, unknown> | undefined;
  let destination = "";
  t.mock.method(globalThis, "fetch", async (request: string | URL | Request, init?: RequestInit) => {
    destination = request instanceof Request ? request.url : String(request);
    payload = JSON.parse(String(init?.body));
    return new Response(modelOutput({ candidates: [{ finishReason: "STOP", content: {
      role: "model", parts: [{ text: modelOutput({ bill: facts, reply: "Please confirm the bill amount." }) }],
    } }] }), { headers: { "content-type": "application/json" } });
  });
  // An explicit fake key and mocked fetch guarantee this makes no real API call.
  const engine = createGeminiEngine({ apiKey: "not-a-real-api-key" });
  assert.equal((await engine.analyze(input)).bill.amountDue, 286);
  assert.match(destination, /generativelanguage\.googleapis\.com/);
  assert.match(destination, /gemini-3\.8-flash:generateContent/);
  assert.ok(payload?.contents); assert.ok(payload?.generationConfig);
});

test("the real SDK retries a temporary service failure and returns the chat answer", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return new Response(modelOutput({ error: { code: 503, message: "Fictional service failure" } }), { status: 503 });
    return new Response(modelOutput({ candidates: [{ finishReason: "STOP", content: {
      role: "model", parts: [{ text: modelOutput({ reply: "Ask your biller to confirm installment terms.", needsDocument: false }) }],
    } }] }), { headers: { "content-type": "application/json" } });
  });
  const engine = createGeminiEngine({ apiKey: "not-a-real-api-key" });
  assert.match(await engine.answer({ ...input, bill: facts }), /confirm installment/);
  assert.equal(calls, 2);
});

test("the real SDK caps transient retries and never retries access errors", async (t) => {
  let calls = 0; let status = 503;
  t.mock.method(globalThis, "fetch", async () => {
    calls++; return new Response(modelOutput({ error: { code: status, message: "Fictional failure" } }), { status });
  });
  const engine = createGeminiEngine({ apiKey: "not-a-real-api-key" });
  await assert.rejects(engine.answer({ ...input, bill: facts }), (error: unknown) =>
    Boolean(error && typeof error === "object" && "status" in error && error.status === 503));
  assert.equal(calls, 2);
  status = 403; calls = 0;
  await assert.rejects(engine.answer({ ...input, bill: facts }));
  assert.equal(calls, 1);
});

test("a timed-out chat request aborts without extending its deadline through retries", async (t) => {
  let calls = 0; let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_request: unknown, init?: RequestInit) => {
    calls++; signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
  });
  const engine = createGeminiEngine({ apiKey: "not-a-real-api-key", chatTimeoutMs: 1000 });
  await assert.rejects(engine.answer({ ...input, bill: facts }));
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("memory updates persist independently of recent conversation and control repeated questions", async () => {
  let captured: GenerateContentParameters | undefined;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    captured = request;
    return { text: JSON.stringify(response({ caseUpdates: [{ field: "monthlyBudget", value: 30, quote: "$30", source: "user_message", statementId: "bill_1" }] })) };
  } });
  const result = await engine.respond!({ ...input, bill: structuredBill(), question: "I can pay $30 a month", history: [], caseState: budgetCase(10) });
  assert.equal(result.caseState?.facts[0]?.value, 30);
  assert.match(result.reply, /6 payments/); assert.doesNotMatch(result.reply, /What monthly amount/);
  assert.match(JSON.stringify(captured), /caseMemory/);
  assert.match(String(captured?.config?.systemInstruction), /next step AND who to contact/);
});

test("action-status questions bypass Gemini and return honest application state", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => { calls++; throw new Error("Should not call model"); } });
  for (const question of ["Have you contacted the billing office yet?", "Did you send the email?", "Has the biller replied?", "What have you done?"]) {
    const result = await engine.respond!({ ...input, bill: structuredBill(), question });
    assert.equal(result.response?.intent, "status");
    assert.match(result.reply, /haven’t contacted the biller/);
  }
  assert.equal(calls, 0);
});

test("document rereading saves newly extracted contacts and retains first-pass user updates", async () => {
  let calls = 0;
  const refreshed = structuredBill([statement({ contacts: [{ label: "Billing", method: "email", value: "billing@example.com", quote: "Email billing@example.com", page: 1, source: "document" }] })]);
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: JSON.stringify(++calls === 1
    ? response({ needsDocument: true, caseUpdates: [{ field: "monthlyBudget", value: 30, quote: "$30", source: "user_message", statementId: null }] })
    : { bill: refreshed, response: response({ contact: { statementId: "bill_1", contactIndex: 0, department: "billing" } }) }) }) });
  const result = await engine.respond!({ ...input, bill: structuredBill(), question: "I can pay $30; who should I email?" });
  assert.equal(calls, 2); assert.equal(result.bill.statements![0]?.contacts[0]?.value, "billing@example.com");
  assert.equal(result.caseState?.facts[0]?.value, 30);
  assert.match(result.reply, /billing@example.com/); assert.match(result.reply, /6 payments/);
});

test("extraction rejects invented source contacts and critical fields without statement evidence", async () => {
  const samples = [
    structuredBill([statement({ evidence: [] })]),
    structuredBill([statement({ contacts: [{ label: "Billing", method: "email", value: "fake@example.com", quote: "Contact billing", page: 1, source: "document" }] })]),
    structuredBill([statement({ contacts: [{ label: "Billing", method: "phone", value: "123", quote: "123", page: 1, source: "document" }] })]),
  ];
  for (const bill of samples) {
    const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: JSON.stringify({ bill, response: response() }) }) });
    await assert.rejects(engine.analyze(input));
  }
  const printed = structuredBill([statement({ contacts: [{ label: "Billing website", method: "website", value: "www.example.com/billing", quote: "Visit www.example.com/billing", page: 1, source: "document" }] })]);
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: JSON.stringify({ bill: printed, response: response() }) }) });
  assert.equal((await engine.analyze(input)).bill.statements![0]?.contacts[0]?.value, "www.example.com/billing");
});
