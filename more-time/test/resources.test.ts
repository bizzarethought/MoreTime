import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocation } from "../src/location.ts";
import { matchResources, resourceEvidence, resources } from "../src/resource-matcher.ts";
import { createGeminiEngine } from "../src/gemini.ts";
import type { AssistantInput } from "../src/gemini.ts";
import { bill, statement, response } from "./structured-fixtures.ts";
const input: AssistantInput = { details: "", state: null, zipCode: "07102", document: null, history: [], question: "Can I get assistance?", currentDate: "2026-10-11" };
test("location preserves leading zeroes, accepts ZIP+4 and rejects unknown or conflicting locations", () => {
  assert.equal(resolveLocation(null, "07102").state, "NJ");
  assert.equal(resolveLocation(null, "07102-1234").state, "NJ");
  assert.equal(resolveLocation(null, "7102").status, "unresolved");
  assert.equal(resolveLocation(null, "00000").state, null);
  assert.equal(resolveLocation("CA", "07102").status, "conflict");
  assert.equal(resolveLocation("CA", null).state, "CA");
  assert.equal(resolveLocation(null, "42223").status, "ambiguous");
});
test("resources match state and bill type, with national fallback and no eligibility inference", () => {
  assert.deepEqual(matchResources(input, bill()).resources.map(r => r.id), ["nj-energy", "us-energy-directory"]);
  assert.deepEqual(matchResources({ ...input, zipCode: "90210" }, bill()).resources.map(r => r.id), ["us-energy-directory"]);
  const medical = bill([statement({ billType: "medical" })]);
  assert.deepEqual(matchResources(input, medical).resources.map(r => r.id), ["nj-charity-care", "us-hospital-assistance"]);
  assert.deepEqual(matchResources(input, bill([statement({ billType: "rent" })])).resources, []);
  assert.deepEqual(matchResources(input, bill([statement(), statement({ id: "bill_2", billType: "medical" })])).resources, []);
  assert.throws(() => resourceEvidence(input, bill(), ["nj-charity-care"]), /invalid_resource_reference/);
  assert.throws(() => resourceEvidence(input, bill(), ["invented"]), /invalid_resource_reference/);
});
test("outdated snapshots and corrected locations cannot reuse stale state matches", () => {
  assert.deepEqual(matchResources({ ...input, currentDate: "2027-03-01" }, bill()).resources, []);
  const corrected = { ...input, caseState: { facts: [{ field: "serviceLocation" as const, value: "California", quote: "California", source: "user_message" as const, statementId: null }], lastQuestion: null } };
  assert.equal(matchResources(corrected, bill()).location.state, null);
  assert.deepEqual(matchResources(corrected, bill()).resources.map(r => r.id), ["us-energy-directory"]);
  for (const resource of resources) { assert.equal(new URL(resource.url).protocol, "https:"); assert.ok(resource.facts.length && resource.missing.length); }
});
test("generation gets matched evidence and renders validated source dates and links", async () => {
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async request => {
    assert.match(JSON.stringify(request.contents), /nj-energy/);
    return { text: JSON.stringify({ ...response({ intent: "assistance", question: null }), resourceIds: ["nj-energy"] }) };
  } });
  const result = await engine.respond!({ ...input, bill: bill() });
  assert.match(result.reply, /verified 2026-10-11/);
  assert.match(result.reply, /https:\/\/www.nj.gov\/bpu\/assistance\/programs\//);
  const invalid = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: JSON.stringify({ ...response(), resourceIds: ["nj-charity-care"] }) }) });
  await assert.rejects(invalid.respond!({ ...input, bill: bill() }), /invalid_resource_reference/);
});

test("ambiguous location asks for the service state in application code", async () => {
  const engine = createGeminiEngine({ apiKey: "fixture", generate: async () => ({ text: JSON.stringify(response({ intent: "assistance", question: null })) }) });
  const result = await engine.respond!({ ...input, zipCode: "42223", bill: bill() });
  assert.match(result.reply, /Which state is the service or hospital in/);
  assert.doesNotMatch(result.reply, /New Jersey/);
  const corrected = { ...input, caseState: { facts: [{ field: "serviceLocation" as const, value: "CA", quote: "CA", source: "user_message" as const, statementId: null }], lastQuestion: null } };
  assert.equal(matchResources(corrected, bill()).location.state, "CA");
});
