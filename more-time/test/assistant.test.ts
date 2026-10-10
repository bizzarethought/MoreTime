import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Content } from "spectrum-ts";
import { createMessageHandler } from "../src/assistant.ts";
import { ConversationStore } from "../src/conversation-store.ts";
import { IntakeStore, intakeIdentity } from "../src/intake-store.ts";
import { LinkStore } from "../src/store.ts";
import { readMessageDocument } from "../src/photon.ts";
import type { AssistantInput, BillEngine, BillFacts } from "../src/gemini.ts";

const bill: BillFacts = {
  biller: "Fictional Electric", billType: "utility", noticeType: "overdue", amountDue: 180,
  currency: "USD", dueDate: "2026-10-20", shutoffDate: null, summary: "Fictional electric bill",
  lineItems: [], evidence: [], uncertainties: [],
};

function harness(t: TestContext, engine?: BillEngine) {
  const dir = mkdtempSync(join(tmpdir(), "moretime-assistant-test-"));
  const path = join(dir, "state.sqlite");
  const store = new LinkStore(path), intakes = new IntakeStore(path), conversations = new ConversationStore(path);
  t.after(() => { conversations.close(); intakes.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const identity = intakeIdentity();
  const sender = "+12015550123";
  const challenge = store.issue(identity.userId, sender);
  intakes.save(identity, challenge.expiresAt, { address: sender, details: "My bill is overdue", zipCode: "07102", state: null,
    bill: { name: "bill.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4\nFictional bill") } });
  const handle = createMessageHandler({ store, intakes, conversations, engine });
  const message = (id: string, text: string, address = sender) => ({ id, text, sender: address, spaceId: "dm:test", line: "shared" });
  return { path, store, intakes, conversations, identity, sender, handle, message, code: `CONNECT ${challenge.code}` };
}

test("phone verification triggers bill analysis, then follow-ups use persisted context and deduplicate", async (t) => {
  const calls: { kind: string; input: AssistantInput }[] = [];
  const h = harness(t, {
    async analyze(input) { calls.push({ kind: "analyze", input }); return { bill, reply: "I see $180 due October 20. Can you confirm?" }; },
    async answer(input) { calls.push({ kind: "answer", input }); return "What amount could you manage each month?"; },
  });
  await h.handle(h.message("unverified", "Please read my bill"));
  await h.handle(h.message("wrong-number", h.code, "+12015550999"));
  assert.equal(calls.length, 0, "no Gemini call before actual sender verification");
  const first = await h.handle(h.message("connect", h.code));
  assert.match(first.reply, /connected to MoreTime/); assert.match(first.reply, /\$180/);
  assert.equal(calls[0]!.input.zipCode, "07102");
  assert.match(Buffer.from(calls[0]!.input.document!.bytes).toString(), /Fictional bill/);
  assert.ok(!JSON.stringify(calls[0]!.input).includes(h.code), "connection codes are never model input");
  assert.equal((await h.handle(h.message("connect", h.code))).reply, first.reply);
  assert.equal(calls.length, 1, "pending duplicate reuses generated response");
  h.store.markReplySent("connect");
  assert.equal((await h.handle(h.message("connect", h.code))).alreadySent, true);
  const question = h.message("question", "Can I ask for a payment plan?");
  const [a, b] = await Promise.all([h.handle(question), h.handle(question)]);
  assert.equal(a.reply, b.reply); assert.equal(calls.length, 2);
  assert.equal(calls[1]!.kind, "answer");
  assert.match(calls[1]!.input.history[0]!.reply, /\$180/);
  const reopened = new ConversationStore(h.path);
  try {
    assert.equal(reopened.session(h.identity.userId)?.bill.amountDue, 180);
    assert.equal(reopened.history(h.identity.userId).length, 2);
    assert.equal(reopened.session("someone-else"), undefined);
    assert.deepEqual(reopened.history("someone-else"), []);
    assert.equal(reopened.reply("question", "someone-else"), undefined);
  } finally { reopened.close(); }
});

test("missing Gemini configuration connects honestly without claiming the bill was analyzed", async (t) => {
  const h = harness(t);
  const result = await h.handle(h.message("connect", h.code));
  assert.match(result.reply, /connected to MoreTime/);
  assert.match(result.reply, /isn’t configured/); assert.match(result.reply, /can’t analyze/);
  assert.equal(h.conversations.session(h.identity.userId), undefined);
});

test("model failures permit a new-message retry, preserve intake and never invent a successful action", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (text: string) => { logs.push(text); });
  let calls = 0;
  const h = harness(t, {
    async analyze() { if (++calls === 1) throw new Error("Fake SDK failure with sensitive contents"); return { bill, reply: "Please confirm the due date." }; },
    async answer() { return "A reply"; },
  });
  const failure = await h.handle(h.message("connect", h.code));
  assert.match(failure.reply, /couldn’t finish/); assert.match(failure.reply, /haven’t contacted your biller/);
  assert.ok(!failure.reply.includes("sensitive contents"));
  assert.deepEqual(logs, ["Bill assistant request failed: stage=analyze_bill code=unknown_error. No private error details logged."]);
  assert.equal(h.conversations.session(h.identity.userId), undefined);
  assert.ok(h.intakes.forConnection(h.identity.userId)?.bill);
  assert.match((await h.handle(h.message("retry", "Try again"))).reply, /confirm the due date/);
  assert.equal(calls, 2);
});

test("diagnostics distinguish saving a generated response from a Gemini failure", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (text: string) => { logs.push(text); });
  const h = harness(t, { async analyze() { return { bill, reply: "Please confirm." }; }, async answer() { return "Reply"; } });
  t.mock.method(h.conversations, "complete", () => { throw new Error("Private database details"); });
  const result = await h.handle(h.message("connect", h.code));
  assert.match(result.reply, /couldn’t finish/);
  assert.deepEqual(logs, ["Bill assistant request failed: stage=save_reply code=unknown_error. No private error details logged."]);
});

test("STOP disconnects and removes saved bill data, conversation and sensitive reply receipts", async (t) => {
  let calls = 0;
  const h = harness(t, {
    async analyze() { calls++; return { bill, reply: "A private bill summary" }; },
    async answer() { calls++; return "A private answer"; },
  });
  await h.handle(h.message("connect", h.code));
  const result = await h.handle(h.message("stop", "STOP"));
  assert.match(result.reply, /disconnected/);
  assert.equal(h.store.connectionForSender(h.sender), undefined);
  assert.equal(h.conversations.session(h.identity.userId), undefined);
  assert.deepEqual(h.conversations.history(h.identity.userId), []);
  assert.equal(h.store.replyForMessage("connect"), undefined);
  assert.equal(h.intakes.status(h.identity.accessToken), undefined);
  await h.handle(h.message("later", "Hello")); assert.equal(calls, 1);
});

test("STOP before verification cancels pending codes and removes the unverified upload", async (t) => {
  let calls = 0;
  const h = harness(t, { async analyze() { calls++; return { bill, reply: "Reply" }; }, async answer() { calls++; return "Reply"; } });
  assert.match((await h.handle(h.message("stop-pending", "STOP"))).reply, /pending connection was cancelled/);
  assert.equal(h.intakes.status(h.identity.accessToken), undefined);
  assert.match((await h.handle(h.message("cancelled-code", h.code))).reply, /invalid, expired/);
  assert.equal(calls, 0);
});

test("a new iMessage bill is read only for a verified sender and replaces the document context", async (t) => {
  let reads = 0; const calls: AssistantInput[] = [];
  const h = harness(t, { async analyze(input) { calls.push(input); return { bill, reply: "Please confirm." }; }, async answer() { return "Reply"; } });
  const loader = async () => { reads++; return { name: "new.png", type: "image/png", bytes: Buffer.from("fake fixture PNG") }; };
  await h.handle({ ...h.message("unverified-photo", ""), attachment: true }, loader);
  assert.equal(reads, 0);
  await h.handle(h.message("connect", h.code));
  await h.handle({ ...h.message("verified-photo", "This is the new bill"), attachment: true }, loader);
  assert.equal(reads, 1); assert.equal(calls.length, 2);
  assert.equal(h.conversations.session(h.identity.userId)?.document?.name, "new.png");
});

test("disconnect during a Gemini request discards the generated private response", async (t) => {
  let h: ReturnType<typeof harness>;
  h = harness(t, { async analyze() { h.store.disconnect(h.identity.userId); return { bill, reply: "Private summary" }; }, async answer() { return "Reply"; } });
  const result = await h.handle(h.message("connect", h.code));
  assert.match(result.reply, /no longer connected/); assert.ok(!result.reply.includes("Private summary"));
  assert.equal(h.conversations.session(h.identity.userId), undefined);
});

function attachment(bytes: Uint8Array, options: { size?: number; mimeType?: string } = {}): Content {
  return { type: "attachment", id: "fixture", name: "bill.pdf", mimeType: options.mimeType ?? "application/pdf", size: options.size,
    read: async () => Buffer.from(bytes), stream: async () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  } as Content;
}

test("iMessage document streams are bounded and quoted attachments are never analyzed", async () => {
  const bytes = Buffer.from("%PDF-1.4\nFictional bill");
  assert.deepEqual(Buffer.from((await readMessageDocument(attachment(bytes)))!.bytes), bytes);
  assert.equal(await readMessageDocument(attachment(bytes, { size: 10 * 1024 * 1024 + 1 })), null);
  assert.equal(await readMessageDocument(attachment(new Uint8Array(10 * 1024 * 1024 + 1))), null);
  assert.equal(await readMessageDocument(attachment(bytes, { mimeType: "text/html" })), null);
  const reply = { type: "reply", content: { type: "text", text: "Thanks" }, target: { content: attachment(bytes) } } as Content;
  assert.equal(await readMessageDocument(reply), null);
  const multipart = { type: "group", items: [{ content: { type: "text", text: "My bill" } }, { content: attachment(bytes) }] } as Content;
  assert.ok(await readMessageDocument(multipart));
  const multiple = { type: "group", items: [{ content: attachment(bytes) }, { content: attachment(bytes) }] } as Content;
  assert.equal(await readMessageDocument(multiple), null);
});

test("existing four-column receipt databases migrate without losing replies", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "moretime-old-db-test-"));
  const path = join(dir, "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE message_receipts (message_id TEXT PRIMARY KEY,
    reply TEXT NOT NULL, reply_sent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO message_receipts VALUES ('old-message', 'Existing reply', 1, 1);`);
  old.close();
  const migrated = new LinkStore(path);
  t.after(() => { migrated.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(migrated.replyForMessage("old-message"), { reply: "Existing reply", alreadySent: true });
  migrated.cacheReply("new-message", "Private bill answer", "user");
  migrated.removeRepliesForUser("user");
  assert.equal(migrated.replyForMessage("new-message"), undefined);
  assert.equal(migrated.replyForMessage("old-message")?.reply, "Existing reply");
});
