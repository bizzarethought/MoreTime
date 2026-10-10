import type { Authenticate } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { LinkStore, normalizeAddress } from "./store.ts";

export interface MessagingTransport {
  welcome(address: string, text: string): Promise<{ messagingAddress: string | null }>;
}

export function createApi(options: {
  store: LinkStore;
  authenticate: Authenticate;
  transport: MessagingTransport;
  allowedOrigins: string[];
}) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin" });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins.includes(origin)) {
      return json(403, { error: "origin_not_allowed", message: "This website origin is not allowed." });
    }
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return json(200, { status: "ok" });
    if (!["/api/messaging/link", "/api/messaging/status"].includes(path)) return json(404, { error: "not_found" });

    try {
      const userId = await options.authenticate(request);
      if (path === "/api/messaging/status" && request.method === "GET") {
        const connection = options.store.connectionForUser(userId);
        return json(200, connection ? {
          connected: true,
          senderAddress: connection.sender_address,
          connectedAt: new Date(connection.connected_at).toISOString(),
        } : { connected: false });
      }
      if (path === "/api/messaging/link" && request.method === "DELETE") {
        options.store.disconnect(userId);
        return new Response(null, { status: 204, headers });
      }
      if (path !== "/api/messaging/link" || request.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new ApiError(415, "invalid_content_type", "Use application/json.");
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 8192) throw new ApiError(413, "body_too_large", "The request body is too large.");
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new ApiError(400, "invalid_json", "The request body must be valid JSON."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_body", "Provide a JSON object.");
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["address", "consent"].includes(key))) {
        throw new ApiError(400, "unexpected_field", "Only address and consent are accepted; identity comes from your sign-in token.");
      }
      if (input.consent !== true) throw new ApiError(400, "consent_required", "Explicitly agree to receive a MoreTime connection message.");
      const address = normalizeAddress(input.address);
      const challenge = options.store.issue(userId, address);
      let destination: { messagingAddress: string | null };
      try {
        destination = await options.transport.welcome(address,
          `You requested to connect iMessage to MoreTime. Reply CONNECT ${challenge.code} within 5 minutes to finish. Only do this if you just clicked Connect iMessage on the MoreTime website. Otherwise, ignore this message.`);
      } catch {
        options.store.revokeCode(challenge.code);
        throw new ApiError(502, "messaging_unavailable", "Could not send the connection message. Check the address and Photon project access. On shared plans, the recipient must be registered as a project user.");
      }
      return json(201, {
        code: challenge.code,
        expiresAt: challenge.expiresAt,
        messagingAddress: destination.messagingAddress,
        messageText: `CONNECT ${challenge.code}`,
        instructions: "A welcome message was sent to your iMessage address. Reply to that conversation with the connection code.",
      });
    } catch (error) {
      if (error instanceof ApiError) return json(error.status, { error: error.code, message: error.message });
      console.error("Account-linking request failed.");
      return json(500, { error: "internal_error", message: "The request could not be completed." });
    }
  };
}
