import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/conversation-store.ts";
import { emptyCase, statementsFor } from "../src/case.ts";
import { bill, budgetCase } from "./structured-fixtures.ts";

test("case memory survives history truncation and a restart; duplicate delivery cannot roll it back", t => {
  const dir = mkdtempSync(join(tmpdir(), "moretime-case-test-"));
  const path = join(dir, "case.sqlite");
  let store = new ConversationStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let index = 0; index < 15; index++) store.complete({ userId: "alice", messageId: `message-${index}`,
    question: `Question ${index}`, reply: `Reply ${index}`, bill: bill(), document: null, caseState: budgetCase(index === 0 ? 10 : 30) });
  store.complete({ userId: "alice", messageId: "message-0", question: "Old question", reply: "Old reply", bill: bill(), document: null, caseState: budgetCase(10) });
  store.close(); store = new ConversationStore(path);
  assert.equal(store.history("alice").length, 10);
  assert.equal(store.session("alice")?.caseState.facts[0]?.value, 30);
  assert.equal(store.session("bob"), undefined);
  assert.equal(store.reply("message-14", "bob"), undefined);
  store.remove("alice");
  assert.equal(store.session("alice"), undefined);
  assert.deepEqual(store.history("alice"), []);
});

test("legacy sessions migrate to empty memory without losing the saved bill or document", t => {
  const dir = mkdtempSync(join(tmpdir(), "moretime-legacy-case-test-"));
  const path = join(dir, "old.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE bill_sessions (user_id TEXT PRIMARY KEY, bill_json TEXT NOT NULL, document_name TEXT, document_type TEXT, document_bytes BLOB)");
  const { statements: _unused, ...oldBill } = bill();
  legacy.prepare("INSERT INTO bill_sessions VALUES (?, ?, ?, ?, ?)").run("alice", JSON.stringify(oldBill), "sample.pdf", "application/pdf", Buffer.from("fictional"));
  legacy.close();
  const store = new ConversationStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.session("alice")!;
  assert.deepEqual(session.caseState, emptyCase());
  assert.equal(session.bill.amountDue, 180); assert.equal(session.document?.name, "sample.pdf");
  assert.equal(statementsFor(session.bill)[0]?.id, "bill_1");
  store.complete({ userId: "alice", messageId: "new", question: "$30", reply: "Proposal", bill: session.bill, document: session.document, caseState: budgetCase() });
  assert.equal(store.session("alice")?.caseState.facts[0]?.value, 30);
});
