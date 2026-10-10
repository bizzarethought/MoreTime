import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpServer } from "../src/server.ts";

test("HTTP adapter preserves authorization/body and rejects oversized requests", async (t) => {
  const server = createHttpServer(async (request) => new Response(JSON.stringify({
    path: new URL(request.url).pathname,
    authorization: request.headers.get("authorization"),
    body: await request.json(),
  }), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/messaging/link`;
  const response = await fetch(url, {
    method: "POST", headers: { authorization: "Bearer test-fixture", "content-type": "application/json" },
    body: JSON.stringify({ address: "+15551234567", consent: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    path: "/api/messaging/link", authorization: "Bearer test-fixture", body: { address: "+15551234567", consent: true },
  });
  const oversized = await fetch(url, { method: "POST", body: " ".repeat(8193) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, "body_too_large");
});
