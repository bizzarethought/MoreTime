import type { MessagingTransport } from "./api.ts";
import { ApiError } from "./errors.ts";
import { IntakeStore, intakeIdentity } from "./intake-store.ts";
import type { IntakeDetails } from "./intake-store.ts";
import type { LinkStore } from "./store.ts";

export const MAX_BILL_BYTES = 10 * 1024 * 1024;
export const MAX_INTAKE_BYTES = MAX_BILL_BYTES + 64 * 1024;
const states = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" "));
const fields = new Set(["address", "details", "zipCode", "state", "bill", "consent"]);

async function parseIntake(request: Request): Promise<IntakeDetails> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ApiError(415, "invalid_content_type", "Use multipart/form-data.");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_INTAKE_BYTES) throw new ApiError(413, "body_too_large", "The intake is too large.");
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
  catch { throw new ApiError(400, "invalid_form", "Provide a valid multipart form."); }
  for (const key of form.keys()) {
    if (!fields.has(key) || form.getAll(key).length !== 1) {
      throw new ApiError(400, "unexpected_field", "Provide each supported field only once.");
    }
  }
  const value = (key: string): string => {
    const field = form.get(key);
    if (field !== null && typeof field !== "string") throw new ApiError(400, "invalid_field", "Text fields must contain text.");
    return field?.trim() ?? "";
  };
  if (value("consent") !== "true") throw new ApiError(400, "consent_required", "Consent is required to send a connection message.");
  const address = value("address");
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(address)) throw new ApiError(400, "invalid_address", "Provide a U.S. phone number with +1.");
  const details = value("details");
  if (details.length > 5000) throw new ApiError(400, "details_too_long", "Details must be 5,000 characters or fewer.");
  const zipCode = value("zipCode") || null;
  const state = value("state") || null;
  if (form.has("zipCode") === form.has("state") || (zipCode ? !/^\d{5}(-\d{4})?$/.test(zipCode) : !state || !states.has(state))) {
    throw new ApiError(400, "invalid_location", "Provide a ZIP code or state, but not both.");
  }
  const file = form.get("bill");
  let bill: IntakeDetails["bill"] = null;
  if (file !== null) {
    if (!(file instanceof File) || !file.size) throw new ApiError(400, "invalid_bill", "Attach a non-empty bill file.");
    if (file.size > MAX_BILL_BYTES) throw new ApiError(413, "bill_too_large", "The bill must be 10 MB or smaller.");
    const name = file.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
    const extension = name.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
    const type = extension ? types[extension] : undefined;
    if (!type || (file.type && file.type !== "application/octet-stream" && file.type !== type)) {
      throw new ApiError(415, "invalid_bill_type", "Attach a PDF, JPEG, PNG, WebP, HEIC or HEIF file.");
    }
    const content = new Uint8Array(await file.arrayBuffer());
    const prefix = (text: string, offset = 0) => [...text].every((char, index) => content[offset + index] === char.charCodeAt(0));
    const signatureMatches = type === "application/pdf" ? prefix("%PDF-")
      : type === "image/jpeg" ? content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      : type === "image/png" ? prefix("\x89PNG\r\n\x1a\n")
      : type === "image/webp" ? prefix("RIFF") && prefix("WEBP", 8)
      : prefix("ftyp", 4) && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) => prefix(brand, 8));
    if (!signatureMatches) throw new ApiError(415, "invalid_bill_type", "The attachment does not match its file type.");
    bill = { name, type, bytes: content };
  }
  if (!details && !bill) throw new ApiError(400, "missing_details", "Add a bill or describe what is happening.");
  return { address, details, zipCode, state, bill };
}

export function createIntakeApi(options: {
  store: LinkStore;
  intakes: IntakeStore;
  transport: MessagingTransport;
  allowedOrigins: string[];
  fallback: (request: Request) => Promise<Response>;
}) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== "/api/intake" && path !== "/api/intake/status") return options.fallback(request);
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin" });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins.includes(origin)) return json(403, { error: "origin_not_allowed" });
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (path === "/api/intake/status" && request.method === "GET") {
        const token = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
        const status = token ? options.intakes.status(token) : undefined;
        if (!status) throw new ApiError(401, "invalid_token", "This connection request is no longer available.");
        return json(200, status);
      }
      if (path !== "/api/intake" || request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const input = await parseIntake(request);
      options.intakes.prune();
      const identity = intakeIdentity();
      const challenge = options.store.issue(identity.userId, input.address);
      try { options.intakes.save(identity, challenge.expiresAt, input); }
      catch (error) { options.store.revokeCode(challenge.code); throw error; }
      let destination: { messagingAddress: string | null };
      try {
        destination = await options.transport.welcome(input.address,
          `You requested a MoreTime conversation. Reply CONNECT ${challenge.code} within 5 minutes to confirm your number. Only do this if you just chose Send & connect on the MoreTime website. Otherwise, ignore this message. The bill-resolution assistant is still in development.`);
      } catch {
        // The provider may fail after delivery. Invalidate this code and discard
        // the unverified intake; never retry the outgoing message automatically.
        options.store.revokeCode(challenge.code);
        if (options.store.connectionForUser(identity.userId)) {
          destination = { messagingAddress: null };
        } else {
          options.intakes.remove(identity.intakeId);
          throw new ApiError(502, "messaging_unavailable", "Could not confirm delivery. This connection code was cancelled; try again after checking Photon project access.");
        }
      }
      return json(201, { intakeId: identity.intakeId, accessToken: identity.accessToken,
        status: "pending", messageText: `CONNECT ${challenge.code}`, expiresAt: challenge.expiresAt,
        messagingAddress: destination.messagingAddress });
    } catch (error) {
      if (error instanceof ApiError) return json(error.status, { error: error.code, message: error.message });
      console.error("Guest intake request failed.");
      return json(500, { error: "internal_error" });
    }
  };
}
