import type { BillDocument, BillEngine } from "./gemini.ts";
import { ConversationStore } from "./conversation-store.ts";
import { IntakeStore } from "./intake-store.ts";
import { LinkStore } from "./store.ts";
import type { IncomingMessage } from "./store.ts";
import { assistantErrorCode } from "./assistant-error.ts";

export function createMessageHandler(options: {
  store: LinkStore;
  intakes: IntakeStore;
  conversations: ConversationStore;
  engine?: BillEngine;
}) {
  // Serialize each account, including duplicate deliveries during an LLM request.
  const pending = new Map<string, Promise<unknown>>();
  async function handle(message: IncomingMessage, loadDocument?: () => Promise<BillDocument | null>) {
    const cached = options.store.replyForMessage(message.id);
    if (cached?.alreadySent) return cached;
    let connection = options.store.connectionForSender(message.sender);
    if (/^(STOP|UNSUBSCRIBE)$/i.test(message.text?.trim() ?? "")) {
      if (connection) {
        options.conversations.remove(connection.user_id);
        options.intakes.removeForUser(connection.user_id);
        options.store.removeRepliesForUser(connection.user_id);
        options.store.disconnect(connection.user_id);
      }
      options.store.cancelChallengesForSender(message.sender);
      options.intakes.removeUnverifiedForSender(message.sender);
      return options.store.cacheReply(message.id, "You’re disconnected from MoreTime. Your saved bill and assistant conversation have been removed from the active database, and any pending connection was cancelled. Start a new request on the website if you want to reconnect.");
    }
    let connectionReply: string | undefined;
    const connecting = /^CONNECT(?:\s|$)/i.test(message.text?.trim() ?? "");
    if (connecting || !connection) {
      const result = cached ?? options.store.prepareReply(message);
      if (!result.reply.startsWith("Your iMessage is connected to MoreTime.")) return result;
      connectionReply = "Your iMessage is connected to MoreTime.";
      connection = options.store.connectionForSender(message.sender);
    }
    if (!connection) return options.store.prepareReply(message);
    const userId = connection.user_id;
    const savedReply = options.conversations.reply(message.id, userId);
    if (savedReply) return options.store.cacheReply(message.id, savedReply, userId);
    if (cached && !connectionReply) return cached;
    if (!options.engine) return options.store.cacheReply(message.id,
      (connectionReply ? connectionReply + "\n\n" : "") + "The AI assistant isn’t configured. I can’t analyze bills or answer questions right now. Please try again after the MoreTime team enables it.");
    if ((message.text?.length ?? 0) > 5000) return options.store.cacheReply(message.id, "Please send your question in 5,000 characters or fewer.");

    let stage = "load_case";
    try {
      const intake = options.intakes.forConnection(userId);
      const session = options.conversations.session(userId);
      stage = "load_attachment";
      const incomingDocument = message.attachment ? await loadDocument?.() : null;
      if (message.attachment && !incomingDocument) return options.store.cacheReply(message.id, "Please send one PDF or supported bill image at a time, up to 10 MB. This attachment has not been analyzed.");
      const document = incomingDocument ?? session?.document ?? intake?.bill ?? null;
      const question = connectionReply
        ? "Help me understand the bill I submitted. Confirm the important details and ask what you need to help me next."
        : message.text?.trim() || "Help me understand this bill and confirm the important details.";
      const input = {
        details: intake?.details ?? "", state: intake?.state ?? null, zipCode: intake?.zipCode ?? null,
        document, history: options.conversations.history(userId), question,
      };
      stage = !session || incomingDocument ? "analyze_bill" : "answer_question";
      const analysis = !session || incomingDocument
        ? await options.engine.analyze(input)
        : { bill: session.bill, reply: await options.engine.answer({ ...input, bill: session.bill }) };
      if (options.store.connectionForSender(message.sender)?.user_id !== userId) {
        return options.store.cacheReply(message.id, "This conversation is no longer connected. Start a new request on the website to reconnect.");
      }
      const reply = (connectionReply ? connectionReply + "\n\n" : "") + analysis.reply;
      stage = "save_reply";
      options.conversations.complete({ userId, messageId: message.id, question, reply, bill: analysis.bill, document });
      return options.store.cacheReply(message.id, reply, userId);
    } catch (error) {
      // Never log SDK errors: they may contain document text or credentials.
      console.error(`Bill assistant request failed: stage=${stage} code=${assistantErrorCode(error)}. No private error details logged.`);
      return options.store.cacheReply(message.id, (connectionReply ? connectionReply + "\n\n" : "") +
        "I couldn’t finish analyzing or answering right now. Please send your question again to retry. I haven’t contacted your biller or changed any deadline.");
    }
  }

  return (message: IncomingMessage, loadDocument?: () => Promise<BillDocument | null>) => {
    const previous = pending.get(message.sender) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => handle(message, loadDocument));
    pending.set(message.sender, result);
    void result.finally(() => { if (pending.get(message.sender) === result) pending.delete(message.sender); }).catch(() => {});
    return result;
  };
}
