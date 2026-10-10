import { imessage } from "spectrum-ts/providers/imessage";
import type { Content, SpectrumInstance } from "spectrum-ts";
import type { MessagingTransport } from "./api.ts";
import { LinkStore, normalizeAddress } from "./store.ts";
import type { IncomingMessage } from "./store.ts";
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "./gemini.ts";
import type { BillDocument } from "./gemini.ts";

export async function readMessageDocument(content: Content): Promise<BillDocument | null> {
  const attachments: Extract<Content, { type: "attachment" }>[] = [];
  const collect = (part: Content, depth = 0) => {
    if (depth > 8) return;
    if (part.type === "attachment") attachments.push(part);
    else if (part.type === "reply") collect(part.content, depth + 1);
    else if (part.type === "group") for (const item of part.items.slice(0, 32)) collect(item.content, depth + 1);
  };
  collect(content);
  if (attachments.length !== 1) return null;
  const attachment = attachments[0]!;
  const type = attachment.mimeType === "image/jpg" ? "image/jpeg" : attachment.mimeType;
  if (!DOCUMENT_TYPES.has(type) || (attachment.size !== undefined && attachment.size > MAX_DOCUMENT_BYTES)) return null;
  // Use the SDK's stream, not user-supplied URLs, and cap bytes even when size is absent.
  const reader = (await attachment.stream()).getReader();
  const deadline = AbortSignal.timeout(15_000);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  deadline.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (deadline.aborted) throw new Error("attachment_timeout");
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) return null;
      size += next.value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) return null;
      chunks.push(Buffer.from(next.value));
    }
    if (!size) return null;
    return { name: attachment.name, type, bytes: Buffer.concat(chunks) };
  } finally {
    deadline.removeEventListener("abort", cancel);
    cancel();
  }
}

export function incomingContent(content: Content, depth = 0): { text?: string; attachment?: boolean } | undefined {
  if (depth > 8) return undefined;
  if (content.type === "text") return { text: content.text };
  if (content.type === "attachment") return { attachment: true };
  // Inspect only the reply's new content, never its quoted target message.
  if (content.type === "reply") return incomingContent(content.content, depth + 1);
  // Spectrum groups the parts of one multi-part message. This is distinct
  // from a group chat, which is rejected by the space check below.
  if (content.type === "group") {
    const parts = content.items.slice(0, 32).map((item) => incomingContent(item.content, depth + 1)).filter((item) => item !== undefined);
    if (!parts.length) return undefined;
    const text = parts.flatMap((part) => part.text ? [part.text] : []).join("\n");
    return { ...(text ? { text } : {}), ...(parts.some((part) => part.attachment) ? { attachment: true } : {}) };
  }
  return undefined;
}

export function photonTransport(app: SpectrumInstance): MessagingTransport {
  return {
    async welcome(address, text) {
      const provider = imessage(app);
      const space = await provider.space.create(await provider.user(address));
      const delivered = await space.send(text);
      if (!delivered) throw new Error("No outbound message returned by Photon.");
      // Spectrum 12.10.1 uses a sentinel in shared-pool mode. It is not a
      // phone number and must not be exposed as a Messages-link destination.
      return { messagingAddress: /^\+[1-9]\d{7,14}$/.test(space.phone) ? space.phone : null };
    },
  };
}

export async function runMessageLoop(app: SpectrumInstance, store: LinkStore,
  handle?: (message: IncomingMessage, loadDocument: () => Promise<BillDocument | null>) => Promise<{ reply: string; alreadySent: boolean }>,
): Promise<void> {
  for await (const [space, message] of app.messages) {
    if (message.direction !== "inbound" || message.platform !== "imessage") continue;
    const content = incomingContent(message.content);
    if (!content) continue;
    const nativeSpace = imessage(space);
    // Account linking and bill chats are private DMs, never group chats.
    if (nativeSpace.type !== "dm" || !message.sender || !message.id) continue;
    try {
      const nativeMessage = imessage(message);
      const sender = normalizeAddress(nativeMessage.sender?.address ?? message.sender.id);
      const id = `imessage:${message.id}`;
      const incoming = {
        id, sender, spaceId: space.id, line: nativeSpace.phone,
        ...content,
      };
      const result = handle ? await handle(incoming, () => readMessageDocument(message.content)) : store.prepareReply(incoming);
      if (result.alreadySent) continue;
      const delivered = await space.send(result.reply);
      if (!delivered) throw new Error("No outbound message returned by Photon.");
      store.markReplySent(id);
    } catch {
      console.error("Could not handle an incoming iMessage. Check Photon access and connectivity.");
    }
  }
}
