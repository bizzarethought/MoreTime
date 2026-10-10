import assert from "node:assert/strict";
import { test } from "node:test";
import { assessUrgency, caseForNewDocument, effectiveStatements, emptyCase, mergeCase, renderResponse, responseSchema, selectedStatement, validateResponse } from "../src/case.ts";
import { bill, statement, response, budgetCase } from "./structured-fixtures.ts";
const today = "2026-10-10";

test("a saved budget produces deterministic installment math and removes the repeated question", () => {
  const result = renderResponse(response(), bill(), budgetCase(), { today });
  assert.match(result.reply, /6 payments, before fees or new charges/);
  assert.match(result.reply, /biller needs to accept/);
  assert.match(result.reply, /Next step:/); assert.match(result.reply, /Who to contact:/);
  assert.doesNotMatch(result.reply, /What monthly amount/);
  assert.equal(result.caseState.lastQuestion, null);
  const fractional = renderResponse(response(), bill([statement({ amountDue: 100.01 })]), budgetCase(25), { today });
  assert.match(fractional.reply, /5 payments/);
  assert.doesNotMatch(renderResponse(response(), bill(), budgetCase(0), { today }).reply, /Infinity|payments, before/);
});

test("multiple statements are not combined or silently selected for a payment plan", () => {
  const packet = bill([statement(), statement({ id: "bill_2", amountDue: 267.54 })]);
  assert.equal(selectedStatement(packet, budgetCase()), undefined);
  const rendered = renderResponse(response({ answer: "Combine both accounts", draft: "Combine my accounts into one payment plan" }), packet, budgetCase(), { today });
  assert.match(rendered.reply, /Which statement/); assert.match(rendered.reply, /haven’t added/);
  assert.doesNotMatch(rendered.reply, /would take/);
  assert.doesNotMatch(rendered.reply, /Combine|Draft you can send/);
  const selected = mergeCase(budgetCase(), [{ field: "selectedStatementId", value: "bill_2", quote: "the second notice", source: "user_message", statementId: null }], { question: "Use the second notice", details: "" }, packet);
  assert.equal(selectedStatement(packet, selected)?.amountDue, 267.54);
  assert.match(renderResponse(response(), packet, selected, { today }).reply, /9 payments/);
});

test("an EOB does not become a payable installment balance", () => {
  const eob = bill([statement({ billType: "medical", documentType: "eob" })]);
  assert.doesNotMatch(renderResponse(response(), eob, budgetCase(), { today }).reply, /would take/);
});

test("an amount question about a packet lists individual balances without requiring a selection or adding a total", () => {
  const packet = bill([statement(), statement({ id: "bill_2", amountDue: 267.54 })]);
  const output = renderResponse(response({ intent: "amount", answer: "You owe a total of $447.54.",
    question: { key: "select_bill", text: "Which statement?", statementId: null } }), packet, emptyCase(), { today });
  assert.match(output.reply, /USD 180.00/); assert.match(output.reply, /USD 267.54/);
  assert.doesNotMatch(output.reply, /447.54|Which statement/);
  assert.equal(output.caseState.lastQuestion, null);
});

test("document contacts are rendered with provenance; missing contacts yield department guidance", () => {
  const contactBill = bill([statement({ contacts: [{ label: "Billing", method: "phone", value: "201-555-0100", quote: "Billing: 201-555-0100", page: 1, source: "document" }] })]);
  const result = renderResponse(response({ contact: { statementId: "bill_1", contactIndex: 0, department: "billing" } }), contactBill, emptyCase(), { today });
  assert.match(result.reply, /Billing — 201-555-0100 \(listed on the bill/);
  assert.match(result.reply, /current details still need verification/);
  const generic = renderResponse(response({ contact: { statementId: "bill_1", contactIndex: null, department: "financial_assistance" } }), bill(), emptyCase(), { today });
  assert.match(generic.reply, /financial assistance team/); assert.doesNotMatch(generic.reply, /555/);
  const insurer = renderResponse(response({ contact: { statementId: null, contactIndex: null, department: "insurance" } }), bill(), emptyCase(), { today });
  assert.match(insurer.reply, /your insurer’s member services/);
  assert.doesNotMatch(insurer.reply, /Example Electric’s insurer/);
});

test("invented contacts and unknown references are rejected in every displayed response field", () => {
  for (const answer of ["Call 201-555-9999", "Email help@example.com", "Go to https://made-up.example.com", "Go to made-up.example.com", "Call 2015559999"]) {
    assert.throws(() => validateResponse(response({ answer }), bill()), /unsupported_contact_detail/);
  }
  assert.throws(() => validateResponse(response({ draft: "Email fake@example.com" }), bill()), /unsupported_contact_detail/);
  assert.throws(() => validateResponse(response({ supportingStatementIds: ["bill_99"] }), bill()), /invalid_fact_reference/);
  assert.throws(() => validateResponse(response({ contact: { statementId: "bill_1", contactIndex: 0, department: "billing" } }), bill()), /invalid_contact_reference/);
  const sourced = bill([statement({ contacts: [{ label: "Billing", method: "email", value: "help@example.com", quote: "help@example.com", source: "document", page: 1 }] })]);
  assert.doesNotThrow(() => validateResponse(response({ draft: "Please email help@example.com." }), sourced));
});

test("outreach claims and promises are rejected, while an explicitly unsent user draft is allowed", () => {
  for (const answer of ["I have contacted the billing office", "I emailed the hospital", "I’ll email billing tomorrow", "I will call them", "Your payment plan is approved"]) {
    assert.throws(() => validateResponse(response({ answer }), bill()), /unsupported_action_claim/);
  }
  const result = renderResponse(response({ intent: "draft", draft: "I contacted your office last week and would like an updated statement." }), bill(), emptyCase(), { today });
  assert.match(result.reply, /Draft you can send:/);
  const status = renderResponse(response({ intent: "status", answer: "Things are moving along." }), bill(), emptyCase(), { today });
  assert.match(status.reply, /haven’t contacted the biller, sent an email, or secured/);
  assert.doesNotMatch(status.reply, /Things are moving/);
});

test("historical warnings require confirmation; a current imminent deadline gets priority", () => {
  const old = bill([statement({ statementDate: "2014-01-09", documentType: "collections_notice", collectionsDate: "2014-01-19" })]);
  assert.equal(assessUrgency(old, emptyCase(), today)[0]?.level, "verify_historical");
  assert.match(renderResponse(response(), old, emptyCase(), { today }).reply, /^These statements are dated more than 90 days ago/);
  const urgent = bill([statement({ documentType: "shutoff_notice", shutoffDate: "2026-10-12" })]);
  assert.equal(assessUrgency(urgent, emptyCase(), today)[0]?.level, "urgent");
  assert.match(renderResponse(response(), urgent, emptyCase(), { today, initial: true }).reply, /^The notice lists an action deadline within three days/);
  assert.match(renderResponse(response(), urgent, emptyCase(), { today }).reply, /request does not pause/);
  assert.equal(assessUrgency(bill([statement({ shutoffDate: "2026-10-09" })]), emptyCase(), today)[0]?.level, "verify_status");
});

test("user corrections are scoped and retain original evidence; a new upload drops old bill-specific facts", () => {
  const packet = bill([statement(), statement({ id: "bill_2", amountDue: 400 })]);
  const state = mergeCase(budgetCase(), [
    { field: "amountDueCorrection", value: 120, quote: "$120", source: "user_message", statementId: "bill_1" },
    { field: "selectedStatementId", value: "bill_1", quote: "$120", source: "user_message", statementId: null },
  ], { question: "The first balance is actually $120", details: "" }, packet);
  assert.equal(effectiveStatements(packet, state)[0]?.amountDue, 120);
  assert.equal(effectiveStatements(packet, state)[1]?.amountDue, 400);
  assert.equal(packet.statements![0]?.amountDue, 180); assert.match(packet.statements![0]!.evidence[1]!.quote, /180/);
  assert.deepEqual(caseForNewDocument(state), budgetCase());
  const cleared = mergeCase(state, [{ field: "amountDueCorrection", value: null, quote: "unknown", source: "user_message", statementId: "bill_1" }], { question: "The amount is unknown", details: "" }, packet);
  assert.equal(effectiveStatements(packet, cleared)[0]?.amountDue, null);
});

test("unsupported memory patches do not erase known facts or fail a useful response", () => {
  const state = budgetCase();
  const merged = mergeCase(state, [
    { field: "monthlyBudget", value: 99, quote: "I can afford $99", source: "user_message", statementId: null },
    { field: "amountDueCorrection", value: 999, quote: "Draft", source: "user_message", statementId: "bill_1" },
    { field: "goal", value: "prepare a request", quote: "Draft", source: "user_message", statementId: null },
  ], { question: "Draft a request", details: "" }, bill());
  assert.equal(merged.facts.find(fact => fact.field === "monthlyBudget")?.value, 30);
  assert.equal(merged.facts.find(fact => fact.field === "amountDueCorrection"), undefined);
  assert.equal(merged.facts.find(fact => fact.field === "goal")?.value, "prepare a request");
  const staleIntake = mergeCase(state, [{ field: "monthlyBudget", value: 10, quote: "$10", source: "user_description", statementId: null }], { question: "Draft", details: "Initially I could afford $10" }, bill());
  assert.equal(staleIntake.facts[0]?.value, 30);
  const normalized = mergeCase(emptyCase(), [{ field: "monthlyBudget", value: 30, quote: "$30", source: "user_message", statementId: "bill_1" }], { question: "$30 a month", details: "" }, bill());
  assert.equal(normalized.facts[0]?.value, 30);
  assert.equal(normalized.facts[0]?.statementId, null);
});

test("internal statement IDs cannot appear as account numbers in rendered drafts", () => {
  const output = renderResponse(response({ draft: "Please review account bill_1 and bill_2." }), bill(), emptyCase(), { today });
  assert.doesNotMatch(output.reply, /bill_\d/);
  assert.match(output.reply, /account \[your account reference\]/);
});

test("a ready-to-send draft does not end with a redundant offer to prepare the same request", () => {
  const output = renderResponse(response({ draft: "Please send your financial assistance application.",
    question: { key: "missing_information", text: "Would you like to ask about financial assistance?", statementId: null } }), bill(), emptyCase(), { today });
  assert.equal(output.caseState.lastQuestion, null);
  assert.doesNotMatch(output.reply, /Would you like/);
});

test("confirmation requires an actual matching previous question and statement", () => {
  const update = { field: "confirmedAmount" as const, value: true, quote: "Yes", source: "user_message" as const, statementId: "bill_1" };
  assert.deepEqual(mergeCase(emptyCase(), [update], { question: "Yes", details: "" }, bill()), emptyCase());
  const asked = { facts: [], lastQuestion: { key: "confirm_amount" as const, text: "Is $180 the current balance?", statementId: "bill_1" } };
  const confirmed = mergeCase(asked, [update], { question: "Yes", details: "" }, bill());
  assert.equal(confirmed.facts[0]?.value, true);
  assert.equal(renderResponse(response({ question: asked.lastQuestion }), bill(), confirmed, { today }).caseState.lastQuestion, null);
});

test("a user-reported action-date correction is remembered separately from the printed deadline", () => {
  const original = bill([statement({ shutoffDate: "2026-10-20" })]);
  const updated = mergeCase(emptyCase(), [{ field: "shutoffDateCorrection", value: "2026-10-12", quote: "2026-10-12", source: "user_message", statementId: "bill_1" }],
    { question: "The utility now says shutoff is 2026-10-12", details: "" }, original);
  assert.equal(original.statements![0]?.shutoffDate, "2026-10-20");
  assert.equal(effectiveStatements(original, updated)[0]?.shutoffDate, "2026-10-12");
  assert.equal(assessUrgency(original, updated, today)[0]?.level, "urgent");
});

test("policy answers keep a practical next step while distinguishing unverified rules", () => {
  const output = renderResponse(response({ intent: "policy", needsPolicyLookup: true, answer: "We need your service location and the current utility policy to check available protections." }), bill(), emptyCase(), { today });
  assert.match(output.reply, /Current company terms and local protections still need an official source/);
  assert.match(output.reply, /Next step:/); assert.match(output.reply, /Who to contact:/);
  assert.equal(responseSchema.safeParse({ ...response(), nextStep: null }).success, false);
  assert.equal(responseSchema.safeParse({ ...response(), contact: null }).success, false);
});


test("equivalent phone formatting is accepted while invented extensions stay rejected", () => {
  const sourced = bill([statement({ contacts: [{ label: "Billing", method: "phone", value: "201-555-0123", quote: "Billing", source: "document", page: 1 }] })]);
  for (const answer of ["Call +1 (201) 555-0123.", "Call 201–555–0123.", "Call 201 555 0123."]) {
    assert.doesNotThrow(() => validateResponse(response({ answer }), sourced));
  }
  assert.throws(() => validateResponse(response({ answer: "Call 201-555-0123 ext. 99." }), sourced), /unsupported_contact_detail/);
  assert.throws(() => validateResponse(response({ answer: "Call 201–555–9999." }), sourced), /unsupported_contact_detail/);
});
