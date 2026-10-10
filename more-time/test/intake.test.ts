import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApi } from "../src/api.ts";
import { authenticationFromEnvironment } from "../src/auth.ts";
import { createIntakeApi, MAX_BILL_BYTES, MAX_INTAKE_BYTES } from "../src/intake-api.ts";
import { IntakeStore } from "../src/intake-store.ts";
import { LinkStore } from "../src/store.ts";
import { createHttpServer } from "../src/server.ts";

const origin = "http://localhost:8000";
const phone = "+12015550123";
const pdf = new File(["%PDF-1.4\nFictional utility bill\n%%EOF"], "bill.pdf", { type: "application/pdf" });
function form(overrides: Record<string, string | File | null> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({ address: phone, details: "My power bill is overdue.", zipCode: "07102", consent: "true", ...overrides })) {
    if (value !== null) result.set(key, value);
  }
  return result;
}
const post = (body = form(), from = origin) => new Request("http://test/api/intake", { method: "POST", body, headers: { origin: from } });
const status = (token: string) => new Request("http://test/api/intake/status", { headers: { origin, authorization: `Bearer ${token}` } });

function harness(t: TestContext, now = Date.now, fail = false) {
  const directory = mkdtempSync(join(tmpdir(), "moretime-intake-test-"));
  const path = join(directory, "test.sqlite");
  const store = new LinkStore(path, now);
  const intakes = new IntakeStore(path, now);
  const sent: { address: string; text: string }[] = [];
  const transport = { async welcome(address: string, text: string) {
    sent.push({ address, text });
    if (fail) throw new Error("Fictional provider failure");
    return { messagingAddress: null };
  } };
  const fallback = createApi({ store, transport, authenticate: authenticationFromEnvironment({}), allowedOrigins: [origin] });
  const api = createIntakeApi({ store, intakes, transport, fallback, allowedOrigins: [origin] });
  t.after(() => { intakes.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connect = (messageText: string, sender = phone, id = "imessage:test") => store.prepareReply({ id, sender, spaceId: "dm:test", line: "shared", text: messageText });
  return { api, store, intakes, sent, connect, path };
}

test("guest uploads persist and link to the verified sender through the existing code handler", async (t) => {
  let now = Date.now();
  const h = harness(t, () => now);
  const response = await h.api(post(form({ bill: pdf })));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const issued = await response.json();
  assert.match(issued.accessToken, /^[a-f0-9]{64}$/);
  assert.match(issued.messageText, /^CONNECT [A-F0-9]{24}$/);
  assert.equal(issued.messagingAddress, null);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.address, phone);
  assert.ok(h.sent[0]!.text.includes(issued.messageText));
  assert.ok(!h.sent[0]!.text.includes("My power bill"), "no bill details sent before phone verification");
  assert.deepEqual(await (await h.api(status(issued.accessToken))).json(), { intakeId: issued.intakeId, status: "pending" });
  const userId = `guest-intake:${issued.intakeId}`;
  assert.equal(h.intakes.forConnection(userId), undefined);
  assert.match(h.connect(issued.messageText, "+12015550999", "imessage:wrong").reply, /different iMessage address/);
  assert.equal(h.store.connectionForUser(userId), undefined);
  assert.match(h.connect(issued.messageText).reply, /connected to MoreTime/);
  // Closing the browser and skipping polling cannot lose verified details.
  now += 10 * 60_000;
  h.store.prune(); h.intakes.prune();
  assert.deepEqual(await (await h.api(status(issued.accessToken))).json(), { intakeId: issued.intakeId, status: "connected" });
  const reopened = new IntakeStore(h.path, () => now);
  try {
    const saved = reopened.forConnection(userId)!;
    assert.equal(saved.address, phone);
    assert.equal(saved.details, "My power bill is overdue.");
    assert.equal(saved.zipCode, "07102");
    assert.equal(saved.bill?.name, "bill.pdf");
    assert.equal(saved.bill?.type, "application/pdf");
    assert.deepEqual(saved.bill?.bytes, new Uint8Array(await pdf.arrayBuffer()));
  } finally { reopened.close(); }
  const db = new DatabaseSync(h.path);
  try {
    const row = db.prepare("SELECT token_hash FROM guest_intakes").get()!;
    assert.notEqual(row.token_hash, issued.accessToken, "only a token hash is stored");
  } finally { db.close(); }
});

test("attachment-only intake and state fallback work without JWT configuration", async (t) => {
  const h = harness(t);
  const response = await h.api(post(form({ bill: pdf, details: "", zipCode: null, state: "NJ" })));
  assert.equal(response.status, 201);
  const issued = await response.json();
  h.connect(issued.messageText);
  const saved = h.intakes.forConnection(`guest-intake:${issued.intakeId}`)!;
  assert.equal(saved.state, "NJ"); assert.equal(saved.zipCode, null); assert.equal(saved.details, "");
});

test("invalid intake fields are rejected before sending or saving", async (t) => {
  const h = harness(t);
  const cases: Record<string, string | File | null>[] = [
    { details: "   " }, { consent: null }, { consent: "false" }, { address: "alice@example.test" },
    { address: "+442015550123" }, { details: "x".repeat(5001) }, { zipCode: "bad" },
    { zipCode: null }, { state: "NJ" }, { zipCode: null, state: "XX" },
    { userId: "someone-else" }, { accessToken: "forged" }, { details: pdf },
    { bill: "not a file" }, { bill: new File([], "empty.pdf", { type: "application/pdf" }) },
  ];
  for (const input of cases) assert.equal((await h.api(post(form(input)))).status, 400, Object.keys(input).join(","));
  const duplicate = form(); duplicate.append("address", "+12015550999");
  assert.equal((await h.api(post(duplicate))).status, 400);
  assert.equal(h.sent.length, 0);
});

test("bill type, signatures, duplicates and 10 MB size boundary are enforced", async (t) => {
  const h = harness(t);
  for (const bill of [
    new File(["run"], "bill.exe", { type: "application/octet-stream" }),
    new File(["<script>bad()</script>"], "bill.pdf", { type: "application/pdf" }),
    new File(["%PDF-1.4"], "bill.png", { type: "image/png" }),
    new File(["%PDF-1.4"], "bill.pdf", { type: "image/jpeg" }),
  ]) assert.equal((await h.api(post(form({ bill })))).status, 415);
  const duplicate = form({ bill: pdf }); duplicate.append("bill", pdf);
  assert.equal((await h.api(post(duplicate))).status, 400);
  const bytes = new Uint8Array(MAX_BILL_BYTES); bytes.set(new TextEncoder().encode("%PDF-1.4"));
  assert.equal((await h.api(post(form({ bill: new File([bytes, "x"], "bill.pdf") })))).status, 413);
  assert.equal((await h.api(post(form({ bill: new File([bytes], "bill.pdf") })))).status, 201);
  assert.equal(h.sent.length, 1);
});

test("failed message delivery invalidates the code and removes pending details", async (t) => {
  const h = harness(t, Date.now, true);
  assert.equal((await h.api(post(form({ bill: pdf })))).status, 502);
  const code = /CONNECT [A-F0-9]{24}/.exec(h.sent[0]!.text)![0];
  assert.match(h.connect(code).reply, /invalid, expired/);
  const db = new DatabaseSync(h.path);
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM guest_intakes").get()!.count, 0); }
  finally { db.close(); }
});

test("expired pending details and attachments are removed, with a temporary status tombstone", async (t) => {
  let now = Date.now(); const h = harness(t, () => now);
  const issued = await (await h.api(post(form({ bill: pdf })))).json();
  now += 5 * 60_000;
  assert.deepEqual(await (await h.api(status(issued.accessToken))).json(), { intakeId: issued.intakeId, status: "expired" });
  const db = new DatabaseSync(h.path);
  try {
    const row = db.prepare("SELECT address, details, zip_code, state, bill_name, bill_type, bill_bytes FROM guest_intakes").get()!;
    assert.ok(Object.values(row).every(value => value === null));
  } finally { db.close(); }
  assert.match(h.connect(issued.messageText).reply, /invalid, expired/);
  now += 24 * 60 * 60_000;
  assert.equal((await h.api(status(issued.accessToken))).status, 401);
});

test("guest tokens are status-only, isolated, and cannot bypass account authentication", async (t) => {
  const h = harness(t);
  const a = await (await h.api(post())).json();
  const b = await (await h.api(post(form({ address: "+12015550999" })))).json();
  h.connect(a.messageText);
  assert.deepEqual(await (await h.api(status(b.accessToken))).json(), { intakeId: b.intakeId, status: "pending" });
  for (const token of ["", "forged", "0".repeat(64)]) assert.equal((await h.api(status(token))).status, 401);
  assert.equal((await h.api(new Request(`http://test/api/intake/status?accessToken=${a.accessToken}`))).status, 401);
  assert.equal((await h.api(new Request("http://test/api/messaging/status", { headers: { authorization: `Bearer ${a.accessToken}` } }))).status, 503);
  assert.equal((await h.api(new Request("http://test/api/intake/status", { method: "DELETE" }))).status, 405);
  assert.equal((await h.api(new Request("http://test/health"))).status, 200);
});

test("guest requests reuse phone rate limits and cannot claim an existing connection", async (t) => {
  let now = Date.now(); const h = harness(t, () => now);
  for (let i = 0; i < 3; i++) assert.equal((await h.api(post())).status, 201);
  assert.equal((await h.api(post())).status, 429);
  assert.equal(h.sent.length, 3);
  now += 5 * 60_000;
  const issued = await (await h.api(post())).json();
  h.connect(issued.messageText);
  assert.equal((await h.api(post())).status, 409);
  assert.equal(h.sent.length, 4);
});

test("CORS only allows configured origins and malformed multipart fails closed", async (t) => {
  const h = harness(t);
  const denied = await h.api(post(form(), "https://untrusted.test"));
  assert.equal(denied.status, 403); assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const preflight = await h.api(new Request("http://test/api/intake/status", { method: "OPTIONS", headers: { origin } }));
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get("access-control-allow-headers")!.includes("Authorization"));
  assert.equal((await h.api(new Request("http://test/api/intake", { method: "POST", body: "{}" }))).status, 415);
  assert.equal((await h.api(new Request("http://test/api/intake", { method: "POST", body: "bad", headers: { "content-type": "multipart/form-data; boundary=missing" } }))).status, 400);
  assert.equal(h.sent.length, 0);
});

test("real HTTP adapter accepts multipart intake, enforces its bound and preserves the account limit", async (t) => {
  const h = harness(t);
  const server = createHttpServer(h.api);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${url}/api/intake`, { method: "POST", body: form({ bill: new File(["%PDF-1.4", new Uint8Array(20_000)], "bill.pdf") }), headers: { origin } });
  assert.equal(response.status, 201);
  const issued = await response.json();
  const check = await fetch(`${url}/api/intake/status`, { headers: { authorization: `Bearer ${issued.accessToken}`, origin } });
  assert.equal((await check.json()).status, "pending");
  assert.equal((await fetch(`${url}/api/messaging/link`, { method: "POST", body: "x".repeat(8193) })).status, 413);
  assert.equal((await fetch(`${url}/api/intake`, { method: "POST", body: new Uint8Array(MAX_INTAKE_BYTES + 1) })).status, 413);
});
