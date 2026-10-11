import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { BillFacts } from "./gemini.ts";
import type { CaseState } from "./case.ts";
import { remembered, selectedStatement } from "./case.ts";
import type { Connection, LinkStore } from "./store.ts";

type CallCase = { user_id: string; version: string; statement_id: string; biller: string;
  notes: string | null; confirmed: number };
type Reminder = { id: string; user_id: string; version: string; due_at: number; status: string };
const commands = /^(?:CALL(?: PLAN| STATUS)?|CONFIRM CALL|REMIND OFF|REMIND IN .+|CALLED(?:\s+.*)?)$/is;
const formatTime = (at: number) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(at);

export class CallCaseStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS call_cases (
        user_id TEXT PRIMARY KEY, version TEXT NOT NULL, statement_id TEXT NOT NULL,
        biller TEXT NOT NULL, notes TEXT, confirmed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS call_reminders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, version TEXT NOT NULL,
        due_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS call_reminders_due ON call_reminders(status,due_at);
      CREATE TABLE IF NOT EXISTS call_command_receipts (
        message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reply TEXT NOT NULL);
    `);
  }
  current(userId: string): CallCase | undefined {
    return this.db.prepare("SELECT * FROM call_cases WHERE user_id=?").get(userId) as CallCase | undefined;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result=fn(); this.db.exec("COMMIT"); return result; }
    catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pause(userId: string): void {
    this.db.prepare("UPDATE call_reminders SET status='cancelled' WHERE user_id=? AND status IN ('scheduled','sending')").run(userId);
  }
  snooze(userId: string, days: number): boolean {
    const changed=this.db.prepare("UPDATE call_reminders SET due_at=? WHERE user_id=? AND status='scheduled'").run(this.now()+days*86400000,userId);
    return Number(changed.changes)>0;
  }
  remove(userId: string): void {
    this.transaction(()=>{
      for(const table of ["call_cases","call_reminders","call_command_receipts"])
        this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    });
  }
  // Store the action AND its reply in one transaction. Replayed inbound messages
  // never replace a newer call report or silently extend an approved reminder.
  command(userId: string, messageId: string, text: string,
    session?: { bill: BillFacts; caseState: CaseState }): string | undefined {
    const input=text.trim();
    if(!commands.test(input))return undefined;
    return this.transaction(()=>{
      const receipt=this.db.prepare("SELECT reply FROM call_command_receipts WHERE message_id=? AND user_id=?").get(messageId,userId) as {reply:string}|undefined;
      if(receipt)return receipt.reply;
      const reply=this.handle(userId,input,session);
      this.db.prepare("INSERT INTO call_command_receipts VALUES (?,?,?)").run(messageId,userId,reply);
      return reply;
    });
  }
  private handle(userId: string, input: string, session?: { bill: BillFacts; caseState: CaseState }): string {
    const action=input.toUpperCase(),current=this.current(userId);
    if(action==="REMIND OFF") {this.pause(userId);return "Your call follow-up is cancelled. The saved call update is still available with CALL STATUS.";}
    if(action==="CALL STATUS") {
      if(!current)return "No call is tracked yet. Reply CALL for a script based on your bill, or CALLED followed by what billing told you.";
      const reminder=this.db.prepare("SELECT due_at,status FROM call_reminders WHERE user_id=? AND version=? ORDER BY rowid DESC LIMIT 1").get(userId,current.version) as {due_at:number;status:string}|undefined;
      const state=!current.notes?"Ready for your call":current.confirmed?"Call update confirmed by you":"Waiting for your confirmation";
      const followUp=reminder?.status==="scheduled"?`Next check-in: ${formatTime(reminder.due_at)}.`
        :reminder?.status==="sent"?"The call follow-up was sent. Tell me what changed with CALLED followed by an update."
        :reminder?.status==="sending"||reminder?.status==="uncertain"?"A check-in was attempted; delivery is not confirmed. It will not be retried automatically."
        :"No call follow-up is scheduled.";
      return `${current.biller}: ${state}.`+(current.notes?`\n\nYour report: ${current.notes}\nThese terms have not been independently verified with the biller.`:"")+`\n\n${followUp}`;
    }
    if(action==="CONFIRM CALL") {
      if(!current?.notes)return "Send CALLED followed by what billing told you first.";
      this.db.prepare("UPDATE call_cases SET confirmed=1 WHERE user_id=?").run(userId);
      return `Saved your confirmed account of the ${current.biller} call. This does not independently confirm an agreement with the biller.\n\nNext step: get the amount, payment dates, fees, and any deadline extension in writing.\n\nWhen should I check back? Reply REMIND IN 2 DAYS (or a different number of MINUTES, HOURS, or DAYS). That approves one check-in; it does not enable recurring check-ins or Gmail alerts.`;
    }
    if(action.startsWith("REMIND IN ")) {
      const match=/^REMIND IN (\d{1,5}) (MINUTES?|HOURS?|DAYS?)$/i.exec(input);
      const factor=match?.[2]?.toUpperCase().startsWith("MINUTE")?60000:match?.[2]?.toUpperCase().startsWith("HOUR")?3600000:86400000;
      const delay=Number(match?.[1])*factor;
      if(!match||!Number.isFinite(delay)||delay<60000||delay>30*86400000)return "Use REMIND IN 2 MINUTES, REMIND IN 4 HOURS, or REMIND IN 2 DAYS, from one minute through 30 days.";
      if(!current)return "Reply CALL to prepare a call, or CALLED followed by what happened, before setting a call follow-up.";
      if(current.notes&&!current.confirmed)return "Please confirm the call update first with CONFIRM CALL, or send CALLED followed by a corrected update.";
      this.pause(userId);
      this.db.prepare("INSERT INTO call_reminders VALUES (?,?,?,?,'scheduled')").run(randomUUID(),userId,current.version,this.now()+delay);
      return `One ${current.biller} call check-in is scheduled for ${formatTime(this.now()+delay)}. Reply REMIND OFF to cancel it, SNOOZE 7 to move it out a week, or STOP to disconnect. I haven't called the biller or agreed to any terms.`;
    }
    const target=session?selectedStatement(session.bill,session.caseState):undefined;
    if(!target)return session?"Choose which bill we should work on in this chat first, then reply CALL or CALLED with your update. I won’t combine separate balances.":"Share a bill and let me read it first, then reply CALL for a call plan.";
    if(target.documentType==="eob")return "This document is an explanation of benefits, not a payment demand. Ask the provider for the current patient balance before discussing a payment arrangement.";
    if(action.startsWith("CALLED")) {
      const notes=input.slice(6).trim();
      if(!notes||notes.length>1500)return "Send CALLED followed by what billing told you, in 1,500 characters or fewer. Include any amount, date, offer, or promised response.";
      this.pause(userId);
      this.db.prepare(`INSERT INTO call_cases VALUES (?,?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET
        version=excluded.version,statement_id=excluded.statement_id,biller=excluded.biller,notes=excluded.notes,confirmed=0`)
        .run(userId,randomUUID(),target.id,target.biller??"Your biller",notes);
      return `Here’s the call update I have for ${target.biller??"your biller"}:\n\n${notes}\n\nIs that accurate? Reply CONFIRM CALL to save it, or CALLED followed by a corrected update. Any earlier call reminder is cancelled while you review this update. I haven't changed the statement balance or deadline.`;
    }
    // Asking for a script must not erase an already recorded outcome.
    if(!current||current.statement_id!==target.id) {
      this.pause(userId);
      this.db.prepare(`INSERT INTO call_cases VALUES (?,?,?,?,NULL,0) ON CONFLICT(user_id) DO UPDATE SET
        version=excluded.version,statement_id=excluded.statement_id,biller=excluded.biller,notes=NULL,confirmed=0`)
        .run(userId,randomUUID(),target.id,target.biller??"Your biller");
    }
    const amount=target.amountDue===null?"the current balance":`${target.currency??"Amount"} ${target.amountDue.toFixed(2)}`;
    const budget=remembered(session!.caseState,"monthlyBudget")?.value;
    const offer=typeof budget==="number"&&budget>0?` I can manage ${budget.toFixed(2)} per month. Is that possible?`:" What payment arrangements or financial assistance could help?";
    const contact=target.contacts.find(item=>item.method==="phone");
    return `Call plan for ${target.biller??"your biller"}\n\n${contact?`Contact: ${contact.value} (listed in your document or provided by you; verify that it is current).`:'Use the billing/customer assistance number on the official website. Ask me to search for it if you need a verified number.'}\n\nSay: “I’m calling about ${amount} on my statement.${offer} Please confirm the current balance, any fees, and the next deadline. Can you send the options in writing?”\n\nBefore hanging up, note the representative’s name, any reference number, payment amount and dates, and whether any deadline extension was actually approved.\n\nAfterward, reply CALLED followed by what happened. If you want a nudge to make the call, reply REMIND IN 1 DAY.`;
  }
  claim(): Reminder[] {
    return this.transaction(()=>{
      const jobs=this.db.prepare(`SELECT r.* FROM call_reminders r JOIN call_cases c
        ON c.user_id=r.user_id AND c.version=r.version WHERE r.status='scheduled' AND r.due_at<=? LIMIT 25`).all(this.now()) as Reminder[];
      for(const job of jobs)this.db.prepare("UPDATE call_reminders SET status='sending' WHERE id=?").run(job.id);
      return jobs;
    });
  }
  isDeliverable(userId: string, id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM call_reminders r JOIN call_cases c ON c.user_id=r.user_id AND c.version=r.version
      WHERE r.id=? AND r.user_id=? AND r.status='sending'`).get(id,userId));
  }
  finish(id: string, status: "sent" | "uncertain" | "cancelled"): void {
    this.db.prepare("UPDATE call_reminders SET status=? WHERE id=? AND status='sending'").run(status,id);
  }
  close(): void {this.db.close();}
}

export async function runCallReminders(options: { calls: CallCaseStore; links: LinkStore;
  send: (connection: Connection, text: string, reminderId: string) => Promise<void> }): Promise<void> {
  for(const job of options.calls.claim()) {
    const connection=options.links.connectionForUser(job.user_id),current=options.calls.current(job.user_id);
    if(!connection||!current||!options.calls.isDeliverable(job.user_id,job.id)){options.calls.finish(job.id,"cancelled");continue;}
    const text=current.notes
      ? `Checking back about your ${current.biller} call. You reported: “${current.notes.slice(0,600)}”\n\nDid you receive written confirmation or hear back from billing? Reply CALLED followed by what changed so we can choose the next step.`
      : `Your ${current.biller} call check-in: were you able to reach billing? Reply CALL for your script, or CALLED followed by what happened.`;
    try {await options.send(connection,text,job.id);options.calls.finish(job.id,"sent");}
    catch {options.calls.finish(job.id,"uncertain");console.error("A call follow-up delivery could not be confirmed. No call notes logged.");}
  }
}
