import { createServer } from "node:http";
import { MAX_INTAKE_BYTES } from "./intake-api.ts";

// The API uses Web Request/Response objects so its boundary is testable without
// opening a port or connecting to Photon.
export function createHttpServer(handle: (request: Request) => Promise<Response>) {
  return createServer(async (incoming, outgoing) => {
    try {
      const method = incoming.method ?? "GET";
      const path = incoming.url ?? "/";
      const limit = method === "POST" && new URL(`http://localhost${path}`).pathname === "/api/intake" ? MAX_INTAKE_BYTES : 8192;
      let size = 0;
      const chunks: Buffer[] = [];
      const body = await new Promise<Buffer>((resolve, reject) => {
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            chunks.length = 0;
            reject(new Error("body_too_large"));
          } else {
            chunks.push(chunk);
          }
        });
        incoming.on("end", () => resolve(Buffer.concat(chunks)));
        incoming.on("error", reject);
        incoming.on("aborted", () => reject(new Error("aborted")));
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      // Fixed internal origin: never use a caller's Host header for routing.
      const request = new Request(`http://localhost${path}`, {
        method, headers,
        ...(method !== "GET" && method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.headersSent) { outgoing.end(); return; }
      const tooLarge = error instanceof Error && error.message === "body_too_large";
      outgoing.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: tooLarge ? "body_too_large" : "invalid_request" }));
    }
  });
}
