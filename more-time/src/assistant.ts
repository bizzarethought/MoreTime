import type { BillDocument, BillEngine } from "./gemini.ts";
import { ConversationStore } from "./conversation-store.ts";
import { IntakeStore } from "./intake-store.ts";
import { LinkStore } from "./store.ts";
import type { IncomingMessage } from "./store.ts";
import type { FollowUpStore } from "./follow-ups.ts";
import type { EmailStore } from "./email.ts";
import type { CallCaseStore } from "./call-case.ts";
import { assistantErrorCode } from "./assistant-error.ts";
import { caseForNewDocument, emptyCase } from "./case.ts";

export function createMessageHandler(options: {
  store: LinkStore;
  intakes: IntakeStore;
  conversations: ConversationStore;
  engine?: BillEngine;
  followUps?: FollowUpStore;
  emails?: EmailStore;
  calls?: CallCaseStore;
}) {
  // Serialize each account, including duplicate deliveries during an LLM request.
  const pending = new Map<string, Promise<unknown>>();
  async function handle(message: IncomingMessage, loadDocument?: () => Promise<BillDocument | null>) {
    const cached = options.store.replyForMessage(message.id);
    if (cached?.alreadySent) return cached;
    let connection = options.store.connectionForSender(message.sender);
    if (/^(STOP|UNSUBSCRIBE)$/i.test(message.text?.trim() ?? "")) {
      if (connection) {
        options.calls?.remove(connection.user_id);
        options.followUps?.remove(connection.user_id);
        options.emails?.remove(connection.user_id);
        options.conversations.remove(connection.user_id);
        options.intakes.removeForUser(connection.user_id);
        options.store.removeRepliesForUser(connection.user_id);
        options.store.disconnect(connection.user_id);
      }
      options.store.cancelChallengesForSender(message.sender);
      options.intakes.removeUnverifiedForSender(message.sender);
      return options.store.cacheReply(message.id, "You’re disconnected from MoreTime. Your saved bill and assistant conversation have been removed from the active database, and any pending connection was cancelled. Start a new request on the website if you want to reconnect.");
    }
    if(/^MANAGE(?:\s|$)/i.test(message.text?.trim()??"")) {
      if(cached)return cached;
      const code=/^MANAGE\s+([A-F0-9]{24})$/i.exec(message.text!.trim())?.[1];
      const confirmed=code&&options.store.confirmManagement(message.sender,code);
      return options.store.cacheReply(message.id,confirmed?"Website management is verified. Return to MoreTime to connect Gmail or manage check-ins. Your existing conversation and saved bill are still available.":"That management code is invalid, expired, or belongs to another number. Request a new code using Manage connection on the website.",connection?.user_id);
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
    const command=message.text?.trim().toUpperCase()??"";
    if(command==="FOLLOWUPS OFF"||command==="RESOLVED") {
      options.calls?.pause(userId);
      options.followUps?.pause(userId);
      return options.store.cacheReply(message.id,"Your proactive check-ins, call follow-ups, and email notice alerts are paused. You can still message me whenever you need help.",userId);
    }
    if(command==="EMAIL OFF") {
      options.emails?.remove(userId);
      return options.store.cacheReply(message.id,"Gmail is disconnected from MoreTime and the saved email access token is removed. Your scheduled bill check-ins can continue. You can also revoke MoreTime access in your Google account settings.",userId);
    }
    const snooze=/^SNOOZE (\d{1,2})$/.exec(command);
    if(snooze) {
      const days=Number(snooze[1]);
      if(cached)return cached;
      const callSnoozed=days>=1&&days<=30&&options.calls?.snooze(userId,days);
      const done=days>=1&&days<=30&&options.followUps?.snooze(userId,days);
      if(callSnoozed)return options.store.cacheReply(message.id,`Your call follow-up is moved out ${days} days.${done?" Recurring check-ins and Gmail alerts are also snoozed.":""} Reply REMIND OFF to cancel the call follow-up.`,userId);
      return options.store.cacheReply(message.id,done?`I’ll wait ${days} days before the next bill check-in. Email notice alerts are also paused until then. Reply FOLLOWUPS OFF to end check-ins.`:"Use SNOOZE 1 through SNOOZE 30 while approved check-ins are enabled.",userId);
    }

    if(options.calls&&!message.attachment) {
      const callReply=options.calls.command(userId,message.id,message.text??"",options.conversations.session(userId));
      if(callReply)return options.store.cacheReply(message.id,callReply,userId);
    }
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
      if(incomingDocument)options.calls?.remove(userId);
      const document = incomingDocument ?? session?.document ?? intake?.bill ?? null;
      const question = connectionReply
        ? "Help me understand the bill I submitted. Confirm the important details and ask what you need to help me next."
        : message.text?.trim() || "Help me understand this bill and confirm the important details.";
      const call=options.calls?.current(userId);
      const savedState=incomingDocument?caseForNewDocument(session?.caseState??emptyCase()):session?.caseState;
      const baseState=call&&savedState?{...savedState,facts:savedState.facts.filter(fact=>!(fact.field==="reportedAgreement"&&fact.statementId===call.statement_id))}:savedState;
      const withCall=call?.confirmed&&call.notes&&baseState?{...baseState,facts:[
        ...baseState.facts.filter(fact=>!(fact.field==="reportedAgreement"&&fact.statementId===call.statement_id)),
        {field:"reportedAgreement" as const,value:call.notes.slice(0,500),quote:call.notes.slice(0,500),source:"user_message" as const,statementId:call.statement_id},
      ]}:baseState;
      const input = {
        details: incomingDocument ? "" : session?.details ?? intake?.details ?? "", state: intake?.state ?? null, zipCode: intake?.zipCode ?? null,
        document, history: options.conversations.history(userId), question,
        caseState: withCall,
      };
      stage = !session || incomingDocument ? "analyze_bill" : "answer_question";
      const analysis = !session || incomingDocument
        ? await options.engine.analyze(input)
        : options.engine.respond ? await options.engine.respond({ ...input, bill: session.bill })
          : { bill: session.bill, reply: await options.engine.answer({ ...input, bill: session.bill }), caseState: session.caseState };
      if (options.store.connectionForSender(message.sender)?.user_id !== userId) {
        return options.store.cacheReply(message.id, "This conversation is no longer connected. Start a new request on the website to reconnect.");
      }
      const reply = (connectionReply ? connectionReply + "\n\n" : "") + analysis.reply;
      stage = "save_reply";
      options.conversations.complete({ userId, messageId: message.id, question, reply, bill: analysis.bill, document, caseState: analysis.caseState ?? input.caseState, details: input.details });
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
