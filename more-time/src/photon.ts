import { imessage } from "spectrum-ts/providers/imessage";
import type { Content, SpectrumInstance } from "spectrum-ts";
import type { MessagingTransport } from "./api.ts";
import { LinkStore, normalizeAddress } from "./store.ts";

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

export async function runMessageLoop(app: SpectrumInstance, store: LinkStore): Promise<void> {
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
      const result = store.prepareReply({
        id, sender, spaceId: space.id, line: nativeSpace.phone,
        ...content,
      });
      if (result.alreadySent) continue;
      const delivered = await space.send(result.reply);
      if (!delivered) throw new Error("No outbound message returned by Photon.");
      store.markReplySent(id);
    } catch {
      console.error("Could not handle an incoming iMessage. Check Photon access and connectivity.");
    }
  }
}
