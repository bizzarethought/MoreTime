import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { researchWeb, publicQuery, safeWebUrl, citeResearch } from "../src/web-research.ts";
import { createGeminiEngine } from "../src/gemini.ts";
import type { BillFacts } from "../src/gemini.ts";
import { statementsFor } from "../src/case.ts";
import { response as fixtureResponse, bill as fixtureBill } from "./structured-fixtures.ts";

function modelOutput(value: any): string {
  if (value && typeof value === "object" && "reply" in value) {
    const response = { ...fixtureResponse({ question: null, answer: value.reply, needsDocument: value.needsDocument ?? false,
      needsPolicyLookup: value.needsPolicyLookup ?? false }),
      ...(value.sourceIds ? { sourceIds: value.sourceIds } : { researchQuery: value.researchQuery ?? null }) };
    value = value.bill ? { bill: { ...value.bill, statements: statementsFor(value.bill) }, response } : response;
  }
  return JSON.stringify(value);
}

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
      if (requests.length === 1) return { text: modelOutput({ reply: "Looking up contacts", needsDocument: false,
        needsPolicyLookup: true, researchQuery: "Example Electric official billing contact NJ" }) };
      if (requests.length === 2) return grounded;
      return { text: modelOutput({ reply: "Ask the billing office about payment options.", sourceIds: [1] }) };
    },
  });
  const reply = await engine.answer(input);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1]!.config?.tools, [{ googleSearch: {} }]);
  assert.equal(requests[1]!.model, "research-model");
  assert.equal(requests[1]!.config?.httpOptions?.timeout, 5000);
  assert.equal(requests[1]!.config?.responseJsonSchema, undefined, "search uses text independently of the chat schema");
  const lookup = modelOutput(requests[1]);
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
    if (++stage === 1) return { text: modelOutput({ reply: "Researching", needsDocument: false,
      needsPolicyLookup: true, researchQuery: "Meaning of debt validation under US federal law" }) };
    if (stage === 2) { assert.match(String(request.config?.systemInstruction), /ZIP code does not prove legal jurisdiction/); return grounded; }
    assert.match(String(request.config?.systemInstruction), /Match the biller and jurisdiction/);
    return { text: modelOutput({ reply: "Confirm the service location before applying local rules.", sourceIds: [1] }) };
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
    if (++stage === 1) return { text: modelOutput({ reply: "Researching", needsDocument: false, needsPolicyLookup: true, researchQuery: "Official contact" }) };
    if (stage === 2) throw new Error("Private API failure");
    assert.match(String(request.config?.systemInstruction), /unavailable/);
    return { text: modelOutput({ reply: "I couldn’t verify the current contact. Could you share the official biller website?", sourceIds: [] }) };
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
    const response = calls === 1 ? { text: modelOutput({ reply: "Researching", needsDocument: false, needsPolicyLookup: true, researchQuery: "Official billing contact" }) }
      : calls === 2 ? grounded : { text: modelOutput({ reply: "Contact billing to ask about options.", sourceIds: [1] }) };
    if (calls === 2) assert.deepEqual(payload?.tools, [{ googleSearch: {} }]);
    return new Response(modelOutput({ candidates: [{ ...response.candidates?.[0], finishReason: "STOP", content: { role: "model", parts: [{ text: response.text }] } }] }),
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
    if (++stage === 1) return { text: modelOutput({ bill: { ...bill, biller: null, amountDue: null, currency: null },
      reply: "Researching", needsPolicyLookup: true, researchQuery: "Utility billing assistance NJ" }) };
    if (stage === 2) return grounded;
    return { text: modelOutput({ reply: "Confirm the provider name before using this billing contact.", sourceIds: [1] }) };
  } });
  const result = await engine.analyze(input);
  assert.match(result.reply, /Sources/);
  assert.equal(result.bill.biller, null);
  assert.equal(stage, 3);
});

test("a public lookup also rereads and saves document facts without sending them to Search", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    if (++stage === 1) return { text: modelOutput({ reply: "Researching", needsDocument: true, needsPolicyLookup: true, researchQuery: "Official late fee policy" }) };
    if (stage === 2) {
      assert.ok(modelOutput(request).includes("inlineData"));
      return { text: modelOutput({ bill: fixtureBill(), reply: "Read the notice" }) };
    }
    if (stage === 3) { assert.ok(!modelOutput(request).includes("inlineData")); return grounded; }
    assert.ok(!modelOutput(request).includes("inlineData"));
    return { text: modelOutput({ reply: "Confirm the late fee with billing.", sourceIds: [1] }) };
  } });
  const result = await engine.respond!(input);
  assert.match(result.reply, /Sources/);
  assert.equal(result.bill.statements?.[0]?.amountDue, 180);
  assert.equal(stage, 4);
});

test("a requested lookup with no public query is rejected before Search", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    calls++; return { text: modelOutput({ reply: "Looking up", needsDocument: false, needsPolicyLookup: true, researchQuery: null }) };
  } });
  await assert.rejects(engine.answer(input), /missing_research_query/);
  assert.equal(calls, 1);
});


test("research preserves structured user memory and accepts supported public contacts", async () => {
  let stage = 0;
  const evidence = "Example Electric billing: (201) 555-0123 or billing@example.org.";
  const supported = { ...grounded, text: evidence, candidates: [{ ...grounded.candidates[0], groundingMetadata: {
    ...grounded.candidates[0]!.groundingMetadata,
    groundingSupports: [{ segment: { text: evidence }, groundingChunkIndices: [0] }],
  } }] };
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    if (++stage === 1) return { text: JSON.stringify({ ...fixtureResponse({
      needsPolicyLookup: true, caseUpdates: [{ field: "monthlyBudget", value: 30, quote: "$30", source: "user_message", statementId: null }],
    }), researchQuery: "Example Electric billing contact NJ" }) };
    if (stage === 2) return supported;
    assert.match(JSON.stringify(request.contents), /monthlyBudget/);
    return { text: modelOutput({ reply: "Call (201) 555-0123 or email billing@example.org to propose installments.", sourceIds: [1] }) };
  } });
  const result = await engine.respond!({ ...input, bill: fixtureBill(), question: "I can pay $30 monthly; who do I contact?" });
  assert.equal(result.caseState?.facts[0]?.value, 30);
  assert.match(result.reply, /6 payments/);
  assert.match(result.reply, /billing@example.org/);
  assert.match(result.reply, /Sources/);
  assert.doesNotMatch(result.reply, /haven’t verified a current number/);
  assert.equal(result.response?.needsPolicyLookup, false);
});

test("research cannot authorize contacts absent from cited passages", async () => {
  let stage = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    if (++stage === 1) return { text: modelOutput({ reply: "Researching", needsPolicyLookup: true, researchQuery: "Billing contact NJ" }) };
    if (stage === 2) return grounded;
    return { text: modelOutput({ reply: "Call (201) 555-9999 to discuss your bill.", sourceIds: [1] }) };
  } });
  await assert.rejects(engine.respond!(input), /unsupported_contact_detail/);
});

test("failed research never asks synthesis to fill in legal claims from memory", async () => {
  let calls = 0;
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => {
    if (++calls === 1) return { text: modelOutput({ reply: "Researching", needsPolicyLookup: true, researchQuery: "Federal debt validation rules" }) };
    if (calls === 2) throw Object.assign(new Error("Private quota details"), { status: 429 });
    throw new Error("A failed lookup must not ask for unsourced legal synthesis");
  } });
  const result = await engine.respond!({ ...input, question: "What is debt validation?" });
  assert.equal(calls, 2);
  assert.match(result.reply, /couldn’t verify current public sources/);
  assert.doesNotMatch(result.reply, /30 days|Fair Debt Collection|Private quota/);
  assert.equal(result.response?.needsPolicyLookup, true);
});

test("free-tier research default remains independent of extraction and chat model choices", async () => {
  const requests: GenerateContentParameters[] = [];
  const engine = createGeminiEngine({ apiKey: "fixture", model: "custom-extraction", chatModel: "custom-chat", generate: async request => {
    requests.push(request);
    if (requests.length === 1) return { text: modelOutput({ reply: "Researching", needsPolicyLookup: true, researchQuery: "Official billing contact" }) };
    if (requests.length === 2) return grounded;
    return { text: modelOutput({ reply: "Ask billing about available payment options.", sourceIds: [1] }) };
  } });
  await engine.respond!(input);
  assert.equal(requests[0]?.model, "custom-chat");
  assert.equal(requests[1]?.model, "gemini-2.5-flash");
  assert.equal(requests[2]?.model, "custom-chat");
});
