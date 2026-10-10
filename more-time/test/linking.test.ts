import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createApi } from "../src/api.ts";
import { createJwtAuthenticator, authenticationFromEnvironment } from "../src/auth.ts";
import { LinkStore, normalizeAddress } from "../src/store.ts";
import { incomingContent } from "../src/photon.ts";
import type { Content } from "spectrum-ts";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "test-key";
const issuer = "https://auth.moretime.test/";
const audience = "moretime-api";
const authenticate = createJwtAuthenticator({ issuer, audience, keys: createLocalJWKSet({ keys: [jwk] }) });

async function token(userId: string, opts: { issuer?: string; audience?: string; expiresAt?: number; key?: typeof privateKey } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? issuer).setAudience(opts.audience ?? audience)
    .setSubject(userId).setIssuedAt().setExpirationTime(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 300)
    .sign(opts.key ?? privateKey);
}

function request(path: string, method = "GET", bearer?: string, body?: unknown, origin = "http://localhost:3000") {
  return new Request(`http://moretime.test${path}`, {
    method,
    headers: {
      origin,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function harness(now?: () => number) {
  const store = new LinkStore(":memory:", now);
  const sent: { address: string; text: string }[] = [];
  const api = createApi({
    store, authenticate,
    allowedOrigins: ["http://localhost:3000"],
    transport: { async welcome(address, text) { sent.push({ address, text }); return { messagingAddress: null }; } },
  });
  return { store, sent, api };
}

test("full signed-in flow connects the actual sender, isolates accounts, and disconnects", async (t) => {
  const { store, sent, api } = harness(); t.after(() => store.close());
  const alice = await token("alice"); const bob = await token("bob");
  const issued = await api(request("/api/messaging/link", "POST", alice, { address: "+15551234567", consent: true }));
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const body = await issued.json();
  assert.equal(body.messagingAddress, null, "shared must never be presented as a phone number");
  assert.equal(sent.length, 1); assert.equal(sent[0]!.address, "+15551234567");
  assert.ok(sent[0]!.text.includes(body.code));
  assert.equal((await (await api(request("/api/messaging/status", "GET", alice))).json()).connected, false);
  const incoming = { id: "imessage:one", sender: "+15551234567", spaceId: "dm:alice", line: "shared", text: body.messageText };
  assert.match(store.prepareReply(incoming).reply, /connected to MoreTime/);
  store.markReplySent(incoming.id);
  assert.equal(store.prepareReply(incoming).alreadySent, true, "duplicate deliveries do not reapply updates");
  const status = await (await api(request("/api/messaging/status", "GET", alice))).json();
  assert.equal(status.connected, true); assert.equal(status.senderAddress, incoming.sender);
  assert.deepEqual(await (await api(request("/api/messaging/status", "GET", bob))).json(), { connected: false });
  assert.equal((await api(request("/api/messaging/link", "DELETE", bob))).status, 204);
  assert.ok(store.connectionForUser("alice"), "another account cannot disconnect Alice");
  assert.equal((await api(request("/api/messaging/link", "DELETE", alice))).status, 204);
  assert.equal(store.connectionForSender(incoming.sender), undefined);
  assert.match(store.prepareReply({ ...incoming, id: "imessage:replay" }).reply, /invalid, expired/);
  assert.equal(store.connectionForUser("alice"), undefined, "a consumed code cannot reconnect after disconnect");
});

test("JWT boundary rejects missing, forged, wrong-issuer, wrong-audience and expired tokens", async (t) => {
  const { store, sent, api } = harness(); t.after(() => store.close());
  const { privateKey: badKey } = await generateKeyPair("RS256");
  for (const bearer of [undefined, "not-a-jwt", await token("alice", { issuer: "https://evil.test" }),
    await token("alice", { audience: "wrong-api" }), await token("alice", { expiresAt: 1 }),
    await token("alice", { key: badKey })]) {
    const response = await api(request("/api/messaging/link", "POST", bearer, { address: "+15551234567", consent: true }));
    assert.equal(response.status, 401);
  }
  assert.equal(sent.length, 0);
});

test("authentication without configuration fails closed", async (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  const api = createApi({ store, authenticate: authenticationFromEnvironment({}), allowedOrigins: [], transport: {
    async welcome() { throw new Error("Must not be called"); },
  } });
  const response = await api(new Request("http://test/api/messaging/status", { headers: { authorization: "Bearer anything" } }));
  assert.equal(response.status, 503);
});

test("JWKS configuration rejects HTTP key servers", () => {
  assert.throws(() => authenticationFromEnvironment({ AUTH_JWKS_URL: "http://evil.test/keys", AUTH_ISSUER: issuer, AUTH_AUDIENCE: audience }), /HTTPS/);
});

test("codes expire and cannot be redeemed by a different sender", (t) => {
  let now = Date.now(); const store = new LinkStore(":memory:", () => now); t.after(() => store.close());
  const code = store.issue("alice", "+15551234567").code;
  const base = { id: "bad-sender", sender: "+15557654321", spaceId: "dm", line: "shared", text: `CONNECT ${code}` };
  assert.match(store.prepareReply(base).reply, /different iMessage address/);
  assert.equal(store.connectionForUser("alice"), undefined);
  now += 5 * 60_000;
  assert.match(store.prepareReply({ ...base, id: "expired", sender: "+15551234567" }).reply, /invalid, expired/);
  assert.equal(store.connectionForUser("alice"), undefined);
});

test("latest code replaces previous code and disconnect invalidates pending codes", (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  const oldCode = store.issue("alice", "+15551234567").code;
  const newCode = store.issue("alice", "+15551234567").code;
  const base = { id: "old", sender: "+15551234567", spaceId: "dm", line: "shared", text: `CONNECT ${oldCode}` };
  assert.match(store.prepareReply(base).reply, /invalid, expired/);
  store.disconnect("alice");
  assert.match(store.prepareReply({ ...base, id: "revoked", text: `CONNECT ${newCode}` }).reply, /invalid, expired/);
});

test("an iMessage address cannot be claimed by two website accounts", (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  const a = store.issue("alice", "+15551234567").code;
  const b = store.issue("bob", "+15551234567").code;
  const base = { id: "alice", sender: "+15551234567", spaceId: "dm", line: "shared", text: `CONNECT ${a}` };
  store.prepareReply(base);
  assert.match(store.prepareReply({ ...base, id: "bob", text: `CONNECT ${b}` }).reply, /already connected/);
  assert.equal(store.connectionForSender(base.sender)?.user_id, "alice");
  assert.equal(store.connectionForUser("bob"), undefined);
});

test("code issuance is limited and resets after five minutes", async (t) => {
  let now = Date.now(); const { store, sent, api } = harness(() => now); t.after(() => store.close());
  const bearer = await token("alice");
  for (let i = 0; i < 3; i++) assert.equal((await api(request("/api/messaging/link", "POST", bearer, { address: "+15551234567", consent: true }))).status, 201);
  for (let i = 0; i < 2; i++) assert.equal((await api(request("/api/messaging/link", "POST", bearer, { address: "+15551234567", consent: true }))).status, 429);
  assert.equal(sent.length, 3);
  now += 5 * 60_000;
  assert.equal((await api(request("/api/messaging/link", "POST", bearer, { address: "+15551234567", consent: true }))).status, 201);
});

test("redemption attempts are limited without destroying a valid pending code", (t) => {
  let now = Date.now(); const store = new LinkStore(":memory:", () => now); t.after(() => store.close());
  const code = store.issue("alice", "+15551234567").code;
  const base = { id: "", sender: "+15551234567", spaceId: "dm", line: "shared", text: "CONNECT invalid" };
  for (let i = 0; i < 5; i++) store.prepareReply({ ...base, id: `bad-${i}` });
  assert.match(store.prepareReply({ ...base, id: "limited", text: `CONNECT ${code}` }).reply, /Too many/);
  assert.equal(store.connectionForUser("alice"), undefined);
  now += 60_000;
  assert.match(store.prepareReply({ ...base, id: "good", text: `CONNECT ${code}` }).reply, /connected to MoreTime/);
});

test("failed welcome delivery revokes the code", async (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  let attempted = "";
  const api = createApi({ store, authenticate, allowedOrigins: ["http://localhost:3000"], transport: {
    async welcome(_address, text) { attempted = text; throw new Error("Target not allowed"); },
  } });
  const response = await api(request("/api/messaging/link", "POST", await token("alice"), { address: "+15551234567", consent: true }));
  assert.equal(response.status, 502);
  const code = /CONNECT ([A-F0-9]{24})/.exec(attempted)![1];
  assert.match(store.prepareReply({ id: "revoked", sender: "+15551234567", spaceId: "dm", line: "shared", text: `CONNECT ${code}` }).reply, /invalid, expired/);
});

test("untrusted origins, missing consent, invalid addresses and caller-supplied identities are rejected", async (t) => {
  const { store, sent, api } = harness(); t.after(() => store.close()); const bearer = await token("alice");
  assert.equal((await api(request("/api/messaging/link", "POST", bearer, { address: "+15551234567", consent: true }, "https://evil.test"))).status, 403);
  for (const body of [{ address: "+15551234567" }, { address: "123", consent: true },
    { address: "+15551234567", consent: true, userId: "bob" }, []]) {
    assert.equal((await api(request("/api/messaging/link", "POST", bearer, body))).status, 400);
  }
  assert.equal(sent.length, 0);
  const preflight = await api(request("/api/messaging/link", "OPTIONS"));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("malformed and oversized request bodies never send a message", async (t) => {
  const { store, sent, api } = harness(); t.after(() => store.close()); const bearer = await token("alice");
  const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  assert.equal((await api(new Request("http://test/api/messaging/link", { method: "POST", headers, body: "{" }))).status, 400);
  assert.equal((await api(new Request("http://test/api/messaging/link", { method: "POST", headers, body: " ".repeat(8193) }))).status, 413);
  assert.equal(sent.length, 0);
});

test("persistent links and deduplication survive restart; raw codes are not stored", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "moretime-link-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite"); let store = new LinkStore(path);
  const { code } = store.issue("alice", "+15551234567");
  const message = { id: "persistent", sender: "+15551234567", spaceId: "dm", line: "shared", text: `CONNECT ${code}` };
  store.prepareReply(message); store.markReplySent(message.id); store.close();
  store = new LinkStore(path);
  assert.equal(store.connectionForUser("alice")?.sender_address, message.sender);
  assert.equal(store.prepareReply(message).alreadySent, true);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(code)), false);
});

test("iMessage emails are normalized and missing-account attachments are not treated as bills", (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  const sender = normalizeAddress(" Person@Example.com "); assert.equal(sender, "person@example.com");
  const code = store.issue("alice", sender).code;
  const base = { id: "email", sender, spaceId: "dm:email", line: "shared", text: `connect ${code.toLowerCase()}` };
  assert.match(store.prepareReply(base).reply, /connected to MoreTime/);
  assert.match(store.prepareReply({ id: "attachment", sender, spaceId: base.spaceId, line: base.line, attachment: true }).reply, /has not been analyzed or saved/);
  assert.match(store.prepareReply({ id: "unknown", sender: "+15559999999", spaceId: "dm:other", line: "shared", attachment: true }).reply, /sign in on the website/);
});

test("a failed reply may be retried without reapplying the connection", (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  const code = store.issue("alice", "+15551234567").code;
  const message = { id: "retry", sender: "+15551234567", spaceId: "dm", line: "shared", text: `CONNECT ${code}` };
  const first = store.prepareReply(message);
  const retry = store.prepareReply(message);
  assert.equal(retry.reply, first.reply); assert.equal(retry.alreadySent, false);
  store.markReplySent(message.id);
  assert.equal(store.prepareReply(message).alreadySent, true);
});

test("threaded replies process new content and never redeem a quoted code", () => {
  const reply = {
    type: "reply", content: { type: "text", text: "Thanks" },
    target: { content: { type: "text", text: "CONNECT ABCDEF123456ABCDEF123456" } },
  } as Content;
  assert.deepEqual(incomingContent(reply), { text: "Thanks" });
  const connectReply = { ...reply, content: { type: "text", text: "CONNECT ABCDEF123456ABCDEF123456" } } as Content;
  assert.deepEqual(incomingContent(connectReply), { text: "CONNECT ABCDEF123456ABCDEF123456" });
});

test("a photo with a caption is recognized as multi-part message content", () => {
  const group = { type: "group", items: [
    { content: { type: "text", text: "My bill" } },
    { content: { type: "attachment", mimeType: "image/jpeg", name: "bill.jpg" } },
  ] } as Content;
  assert.deepEqual(incomingContent(group), { text: "My bill", attachment: true });
});

test("code requests are also limited per target across different sign-in accounts", (t) => {
  const store = new LinkStore(":memory:"); t.after(() => store.close());
  for (let i = 0; i < 3; i++) store.issue(`user-${i}`, "+15551234567");
  assert.throws(() => store.issue("fourth-user", "+15551234567"), /three connection codes/);
});
