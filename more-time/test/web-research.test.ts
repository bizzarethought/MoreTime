import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { researchWeb, publicQuery, safeWebUrl, citeResearch } from "../src/web-research.ts";
import { createGeminiEngine } from "../src/gemini.ts";
import type { BillFacts } from "../src/gemini.ts";

const bill: BillFacts = { biller: "Example Electric", billType: "utility", noticeType: "regular_bill", amountDue: 180,
  currency: "USD", dueDate: null, shutoffDate: null, summary: "Private case summary", lineItems: [], evidence: [], uncertainties: [] };
const input = { bill, details: "Private medical details", state: "NJ", zipCode: "07102", question: "Who should I contact?",
  history: [{ question: "My account is SECRET123", reply: "Private history" }],
  document: { name: "private.pdf", type: "application/pdf", bytes: Buffer.from("private document") } };
const grounded = {
  text: "Example Electric billing can review payment options.", candidates: [{ finishReason: FinishReason.STOP,
    groundingMetadata: {
      groundingChunks: [{ web: { title: "Example Electric billing", uri: "https://example.org/billing" } },
        { web: { title: "Uncited result", uri: "https://example.org/uncited" } }],
      groundingSupports: [{ segment: { text: "Example Electric billing can review payment options." }, groundingChunkIndices: [0] }],
      webSearchQueries: ["Example Electric official billing NJ"], searchEntryPoint: { renderedContent: "<div>Google suggestions</div>" },
    },
  }],
};
const options = { model: "research-model", timeoutMs: 5000, query: "Official billing contact", biller: bill.biller, state: "NJ", zipCode: "07102" };

test("contact lookup routes to Search then structured synthesis and app-owned citations", async () => {
  const requests: GenerateContentParameters[] = [];
  const engine = createGeminiEngine({ apiKey: "fixture", researchModel: "research-model", researchTimeoutMs: 5000,
    generate: async request => {
      requests.push(request);
      if (requests.length === 1) return { text: JSON.stringify({ reply: "Looking up contacts", needsDocument: false,
        needsPolicyLookup: true, researchQuery: "Example Electric official billing contact NJ" }) };
      if (requests.length === 2) return grounded;
      return { text: JSON.stringify({ reply: "Ask the billing office about payment options.", sourceIds: [1] }) };
    },
  });
  const reply = await engine.answer(input);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1]!.config?.tools, [{ googleSearch: {} }]);
  assert.equal(requests[1]!.model, "research-model");
  assert.equal(requests[1]!.config?.httpOptions?.timeout, 5000);
  assert.equal(requests[1]!.config?.responseJsonSchema, undefined, "search uses text independently of the chat schema");
  const lookup = JSON.stringify(requests[1]);
  for (const privateText of ["Private medical", "SECRET123", "Private history", "inlineData", "Private case summary", "180"]) assert.ok(!lookup.includes(privateText));
  const synthesis = String(requests[2]!.config?.systemInstruction);
  assert.match(synthesis, /Example Electric billing can review payment options/);
  assert.ok(!synthesis.includes("Uncited result"));
  assert.match(reply, /Sources \(checked \d{4}-\d{2}-\d{2}\)/);
  assert.match(reply, /https:\/\/example.org\/billing/);
  assert.ok(!reply.includes("uncited"));
});

test("legal lookup preserves source attribution and jurisdiction instructions", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    if (++stage === 1) return { text: JSON.stringify({ reply: "Researching", needsDocument: false,
      needsPolicyLookup: true, researchQuery: "Meaning of debt validation under US federal law" }) };
    if (stage === 2) { assert.match(String(request.config?.systemInstruction), /ZIP code does not prove legal jurisdiction/); return grounded; }
    assert.match(String(request.config?.systemInstruction), /Match the biller and jurisdiction/);
    return { text: JSON.stringify({ reply: "Confirm the service location before applying local rules.", sourceIds: [1] }) };
  } });
  assert.match(await engine.answer({ ...input, question: "What does debt validation mean?" }), /Sources/);
});

test("lookup with no attributed sources, unsafe URLs or blocked/truncated results is unverified", async () => {
  const responses = [
    { text: "A made-up contact" },
    { ...grounded, candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.org" } }] } }] },
    { ...grounded, candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "javascript:alert(1)" } }],
      groundingSupports: [{ segment: { text: "Bad" }, groundingChunkIndices: [0] }] } }] },
    { ...grounded, promptFeedback: { blockReason: "SAFETY" as never } },
    { ...grounded, candidates: [{ finishReason: FinishReason.MAX_TOKENS }] },
  ];
  for (const response of responses) {
    const result = await researchWeb({ ...options, generate: async () => response });
    assert.equal(result.status, "unverified"); assert.deepEqual(result.sources, []);
  }
});

test("search errors allow an honest final response with no fabricated sources", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    if (++stage === 1) return { text: JSON.stringify({ reply: "Researching", needsDocument: false, needsPolicyLookup: true, researchQuery: "Official contact" }) };
    if (stage === 2) throw new Error("Private API failure");
    assert.match(String(request.config?.systemInstruction), /unavailable/);
    return { text: JSON.stringify({ reply: "I couldn’t verify the current contact. Could you share the official biller website?", sourceIds: [] }) };
  } });
  const reply = await engine.answer(input);
  assert.match(reply, /couldn’t verify/); assert.ok(!reply.includes("Sources")); assert.ok(!reply.includes("Private API failure"));
});

test("source IDs must reference actual attributed sources and successful lookup requires citations", async () => {
  const result = await researchWeb({ ...options, generate: async () => grounded });
  assert.throws(() => citeResearch("Fabricated", [2], result), /invalid_research_source/);
  assert.throws(() => citeResearch("Uncited", [], result), /missing_research_source/);
  assert.equal(result.sources.length, 1);
  assert.equal(result.searchSuggestionsHtml, "<div>Google suggestions</div>");
});

test("public query scrubs common sensitive identifiers and source links accept HTTPS only", () => {
  const query = publicQuery("Contact for account SECRET123, me@example.org, +1 (201) 555-0123 and 123-45-6789");
  for (const value of ["SECRET123", "me@example.org", "555-0123", "123-45-6789"]) assert.ok(!query.includes(value));
  for (const url of ["http://example.org", "javascript:alert(1)", "https://user:password@example.org", "invalid"]) assert.equal(safeWebUrl(url), undefined);
  assert.equal(safeWebUrl("https://example.org/page"), "https://example.org/page");
});

test("real Google SDK serializes Google Search and decodes grounding metadata", async t => {
  let payload: Record<string, unknown> | undefined;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_request: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    calls++;
    const response = calls === 1 ? { text: JSON.stringify({ reply: "Researching", needsDocument: false, needsPolicyLookup: true, researchQuery: "Official billing contact" }) }
      : calls === 2 ? grounded : { text: JSON.stringify({ reply: "Contact billing to ask about options.", sourceIds: [1] }) };
    if (calls === 2) assert.deepEqual(payload?.tools, [{ googleSearch: {} }]);
    return new Response(JSON.stringify({ candidates: [{ ...response.candidates?.[0], finishReason: "STOP", content: { role: "model", parts: [{ text: response.text }] } }] }),
      { headers: { "content-type": "application/json" } });
  });
  assert.match(await createGeminiEngine({ apiKey: "not-real" }).answer(input), /https:\/\/example.org\/billing/);
  assert.equal(calls, 3);
});

test("research model timeout is validated separately", () => {
  for (const researchTimeoutMs of [0, NaN, 1.5, 300001]) assert.throws(() => createGeminiEngine({ apiKey: "fixture", researchTimeoutMs }), /GEMINI_RESEARCH_TIMEOUT_MS/);
});

test("a contact question during first bill analysis also researches the web", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    if (++stage === 1) return { text: JSON.stringify({ bill: { ...bill, biller: null, amountDue: null, currency: null },
      reply: "Researching", needsPolicyLookup: true, researchQuery: "Utility billing assistance NJ" }) };
    if (stage === 2) return grounded;
    return { text: JSON.stringify({ reply: "Confirm the provider name before using this billing contact.", sourceIds: [1] }) };
  } });
  const result = await engine.analyze(input);
  assert.match(result.reply, /Sources/);
  assert.equal(result.bill.biller, null);
  assert.equal(stage, 3);
});

test("a public lookup can also reread the document without sending it to Search", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    if (++stage === 1) return { text: JSON.stringify({ reply: "Researching", needsDocument: true, needsPolicyLookup: true, researchQuery: "Official late fee policy" }) };
    if (stage === 2) { assert.ok(!JSON.stringify(request).includes("inlineData")); return grounded; }
    assert.ok(JSON.stringify(request).includes("inlineData"));
    return { text: JSON.stringify({ reply: "Confirm the late fee with billing.", sourceIds: [1] }) };
  } });
  assert.match(await engine.answer(input), /Sources/);
});

test("a requested lookup with no public query is rejected before Search", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    calls++; return { text: JSON.stringify({ reply: "Looking up", needsDocument: false, needsPolicyLookup: true, researchQuery: null }) };
  } });
  await assert.rejects(engine.answer(input), /missing_research_query/);
  assert.equal(calls, 1);
});
