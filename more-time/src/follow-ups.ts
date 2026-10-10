import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { LinkStore, Connection } from "./store.ts";

const DAY = 86_400_000;
export class FollowUpStore {
  private db: DatabaseSync;
  constructor(path: string, private now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS follow_up_preferences (
        user_id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL, approved_at INTEGER NOT NULL, snoozed_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS follow_up_attempts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, attempted_at INTEGER NOT NULL, status TEXT NOT NULL);
    `);
    const columns=this.db.prepare("PRAGMA table_info(follow_up_preferences)").all();
    if(!columns.some(column=>column.name==="snoozed_until"))this.db.exec("ALTER TABLE follow_up_preferences ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0");
  }
  approve(userId: string, at: number) {
    if (!Number.isFinite(at) || at < this.now()+60_000 || at > this.now()+30*DAY) throw new Error("invalid_schedule");
    this.db.prepare(`INSERT INTO follow_up_preferences (user_id,next_at,until_at,enabled,approved_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET next_at=excluded.next_at, until_at=excluded.until_at,
      enabled=1, approved_at=excluded.approved_at, snoozed_until=0`).run(userId, at, this.now()+90*DAY, this.now());
  }
  status(userId: string) {
    const row = this.db.prepare("SELECT * FROM follow_up_preferences WHERE user_id=?").get(userId) as
      { next_at: number; until_at: number; enabled: number } | undefined;
    return { enabled: Boolean(row?.enabled && row.until_at > this.now()), nextAt: row?.enabled && row.until_at > this.now() ? new Date(row.next_at).toISOString() : null };
  }
  emailAlertsEnabled(userId:string) {
    return Boolean(this.db.prepare("SELECT 1 FROM follow_up_preferences WHERE user_id=? AND enabled=1 AND until_at>? AND snoozed_until<=?").get(userId,this.now(),this.now()));
  }
  pause(userId: string) { this.db.prepare("UPDATE follow_up_preferences SET enabled=0 WHERE user_id=?").run(userId); }
  snooze(userId: string, days: number) {
    if (!this.status(userId).enabled) return false;
    this.db.prepare("UPDATE follow_up_preferences SET next_at=?, snoozed_until=? WHERE user_id=?").run(this.now()+days*DAY,this.now()+days*DAY,userId);
    return true;
  }
  remove(userId: string) {
    this.db.prepare("DELETE FROM follow_up_preferences WHERE user_id=?").run(userId);
    this.db.prepare("DELETE FROM follow_up_attempts WHERE user_id=?").run(userId);
  }
  // Reserve before delivery. An ambiguous provider failure must never trigger
  // an automatic duplicate. Persist next_at so restarts preserve cadence.
  claim(): { id: string; userId: string }[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const due = this.db.prepare("SELECT user_id FROM follow_up_preferences WHERE enabled=1 AND next_at<=? AND until_at>? LIMIT 25").all(this.now(),this.now()) as {user_id:string}[];
      const jobs = due.map(row => ({id:randomUUID(),userId:row.user_id}));
      for (const job of jobs) {
        this.db.prepare("UPDATE follow_up_preferences SET next_at=? WHERE user_id=?").run(this.now()+7*DAY,job.userId);
        this.db.prepare("INSERT INTO follow_up_attempts VALUES (?, ?, ?, 'sending')").run(job.id,job.userId,this.now());
      }
      this.db.exec("COMMIT"); return jobs;
    } catch (error) {this.db.exec("ROLLBACK"); throw error;}
  }
  finish(id: string, status: "sent" | "uncertain" | "cancelled") {
    this.db.prepare("UPDATE follow_up_attempts SET status=? WHERE id=?").run(status,id);
  }
  close() {this.db.close();}
}

export async function runFollowUps(options: { followUps: FollowUpStore; links: LinkStore;
  send: (connection: Connection, text: string) => Promise<void> }) {
  for (const job of options.followUps.claim()) {
    const connection=options.links.connectionForUser(job.userId);
    if (!connection || !options.followUps.status(job.userId).enabled) {options.followUps.finish(job.id,"cancelled");continue;}
    try {
      await options.send(connection,"Checking in about the bill or notice you shared with MoreTime. Have you reached billing or received a new notice? Tell me what changed and we can work out the next step. Reply RESOLVED or FOLLOWUPS OFF to end check-ins, SNOOZE 7 to wait a week, or STOP to disconnect.");
      options.followUps.finish(job.id,"sent");
    } catch {options.followUps.finish(job.id,"uncertain");console.error("A scheduled MoreTime check-in could not be confirmed.");}
  }
}
