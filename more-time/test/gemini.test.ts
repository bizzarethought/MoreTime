import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason, ThinkingLevel } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { createGeminiEngine, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_CHAT_MODEL, DEFAULT_GEMINI_TIMEOUT_MS, DEFAULT_GEMINI_CHAT_TIMEOUT_MS, geminiFromEnvironment, MAX_DOCUMENT_BYTES } from "../src/gemini.ts";
import type { AssistantInput, BillFacts } from "../src/gemini.ts";

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
const input: AssistantInput = {
  details: "My bill doubled", state: "NJ", zipCode: null, history: [],
  document: { name: "sample.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4\nFictional sample") },
  question: "What does this bill say?",
};

test("Gemini uses inline documents and a validated JSON schema on the configured model", async () => {
  let captured: GenerateContentParameters | undefined;
  const engine = createGeminiEngine({ apiKey: "test-only-not-a-real-key", generate: async request => {
    captured = request;
    return { text: JSON.stringify({ bill: facts, reply: "I see $286 due October 20. Can you confirm that?" }) };
  } });
  assert.deepEqual((await engine.analyze(input)).bill, facts);
  assert.equal(captured!.model, DEFAULT_GEMINI_MODEL);
  assert.equal(captured!.config?.responseMimeType, "application/json");
  assert.ok(captured!.config?.responseJsonSchema);
  assert.equal(captured!.config?.httpOptions?.timeout, DEFAULT_GEMINI_TIMEOUT_MS);
  const contents = captured!.contents as { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
  const document = contents[0]!.parts.find(part => part.inlineData)?.inlineData;
  assert.equal(document?.mimeType, "application/pdf");
  assert.equal(Buffer.from(document!.data, "base64").toString(), "%PDF-1.4\nFictional sample");
  assert.ok(!JSON.stringify(captured).includes("test-only-not-a-real-key"));
});

test("follow-up requests include the bill, location and recent history without phone or account identity", async () => {
  let captured: GenerateContentParameters | undefined;
  const engine = createGeminiEngine({ apiKey: "fixture", chatModel: "custom-gemini-model", generate: async request => {
    captured = request; return { text: JSON.stringify({ reply: "You can ask for a review of the estimated reading.", needsDocument: false }) };
  } });
  const history = Array.from({ length: 15 }, (_, index) => ({ question: `Question ${index}`, reply: `Reply ${index}` }));
  assert.match(await engine.answer({ ...input, bill: facts, history }), /estimated reading/);
  assert.equal(captured!.model, "custom-gemini-model");
  const text = JSON.stringify(captured);
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
    return { text: JSON.stringify(requests.length === 1
      ? { reply: "I need to read the source.", needsDocument: true }
      : { reply: "The document shows an estimated reading. Please confirm with your biller." }) };
  } });
  assert.match(await engine.answer({ ...input, bill: facts, question: "What does the meter-reading section say?" }), /document shows/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.model, DEFAULT_GEMINI_CHAT_MODEL);
  assert.equal(requests[0]!.config?.thinkingConfig?.thinkingLevel, ThinkingLevel.MINIMAL);
  assert.equal(requests[0]!.config?.httpOptions?.timeout, DEFAULT_GEMINI_CHAT_TIMEOUT_MS);
  assert.equal(requests[1]!.model, DEFAULT_GEMINI_MODEL);
  assert.ok(!JSON.stringify(requests[0]).includes('"inlineData"'));
  assert.ok(JSON.stringify(requests[1]).includes('"inlineData"'));
  assert.equal(requests[1]!.config?.httpOptions?.timeout, 90_000);
});

test("missing originals cannot trigger a document request and timeout settings are validated", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    calls++; return { text: JSON.stringify({ reply: "Please upload the statement.", needsDocument: true }) };
  } });
  assert.equal(await engine.answer({ ...input, document: null, bill: facts }), "Please upload the statement.");
  assert.equal(calls, 1);
  for (const value of ["NaN", "0", "300001", "1.5"]) {
    assert.throws(() => geminiFromEnvironment({ GEMINI_API_KEY: "fixture", GEMINI_TIMEOUT_MS: value }), /GEMINI_TIMEOUT_MS/);
    assert.throws(() => geminiFromEnvironment({ GEMINI_API_KEY: "fixture", GEMINI_CHAT_TIMEOUT_MS: value }), /GEMINI_CHAT_TIMEOUT_MS/);
  }
});

test("malformed, unsupported and unfinished model outputs are rejected", async () => {
  const invalid = [
    "not JSON",
    JSON.stringify({ bill: { ...facts, amountDue: "286" }, reply: "Wrong type" }),
    JSON.stringify({ bill: { ...facts, dueDate: "2026-02-30" }, reply: "Impossible date" }),
    JSON.stringify({ bill: { ...facts, evidence: [] }, reply: "No evidence" }),
    JSON.stringify({ bill: facts, reply: "" }),
    JSON.stringify({ bill: facts, reply: "x".repeat(2401) }),
  ];
  for (const text of invalid) {
    const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text }) });
    await assert.rejects(engine.analyze(input));
  }
  const empty = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: undefined }) });
  await assert.rejects(empty.analyze(input), /gemini_incomplete_response/);
  const truncated = createGeminiEngine({ apiKey: "fixture", generate: async () => ({
    text: JSON.stringify({ bill: facts, reply: "A partial response" }),
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
    text: JSON.stringify({ bill: unknown, reply: "How much is due, and when?" }),
  }) });
  assert.equal((await engine.analyze({ ...input, document: null })).bill.dueDate, null);
  const fabricated = createGeminiEngine({ apiKey: "fixture", generate: async () => ({
    text: JSON.stringify({ bill: facts, reply: "Wrong source" }),
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
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: {
      role: "model", parts: [{ text: JSON.stringify({ bill: facts, reply: "Please confirm the bill amount." }) }],
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
    if (++calls === 1) return new Response(JSON.stringify({ error: { code: 503, message: "Fictional service failure" } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: {
      role: "model", parts: [{ text: JSON.stringify({ reply: "Ask your biller to confirm installment terms.", needsDocument: false }) }],
    } }] }), { headers: { "content-type": "application/json" } });
  });
  const engine = createGeminiEngine({ apiKey: "not-a-real-api-key" });
  assert.match(await engine.answer({ ...input, bill: facts }), /confirm installment/);
  assert.equal(calls, 2);
});

test("the real SDK caps transient retries and never retries access errors", async (t) => {
  let calls = 0; let status = 503;
  t.mock.method(globalThis, "fetch", async () => {
    calls++; return new Response(JSON.stringify({ error: { code: status, message: "Fictional failure" } }), { status });
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
