import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.ts";

const TTL_MS = 5 * 60_000;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) throw new ApiError(400, "invalid_address", "Provide an E.164 phone number or iMessage email address.");
  const address = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(address)) return address;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return address.toLowerCase();
  throw new ApiError(400, "invalid_address", "Use a phone number with country code, such as +15551234567, or an iMessage email address.");
}

export interface Connection {
  user_id: string;
  sender_address: string;
  space_id: string;
  line: string;
  connected_at: number;
}

export interface IncomingMessage {
  id: string;
  sender: string;
  spaceId: string;
  line: string;
  text?: string;
  attachment?: boolean;
}

interface Challenge { user_id: string; expected_address: string; expires_at: number }
interface Receipt { reply: string; reply_sent: number }

export class LinkStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS connections (
        user_id TEXT PRIMARY KEY, sender_address TEXT NOT NULL UNIQUE,
        space_id TEXT NOT NULL, line TEXT NOT NULL, connected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS link_challenges (
        code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE,
        expected_address TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS management_sessions (
        token_hash TEXT PRIMARY KEY, code_hash TEXT UNIQUE, user_id TEXT NOT NULL,
        expected_address TEXT NOT NULL, connected_at INTEGER NOT NULL,
        code_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT PRIMARY KEY, reply TEXT NOT NULL,
        reply_sent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        user_id TEXT
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(message_receipts)").all();
    if (!columns.some(column => column.name === "user_id")) this.db.exec("ALTER TABLE message_receipts ADD COLUMN user_id TEXT");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private allow(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    this.db.prepare(`INSERT INTO rate_limits VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
        reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    `).run(key, now + windowMs, now, now);
    const row = this.db.prepare("SELECT count FROM rate_limits WHERE key = ?").get(key) as { count: number };
    return row.count <= limit;
  }

  issue(userId: string, expectedAddress: string): { code: string; expiresAt: string } {
    const challenge = this.transaction(() => {
      if (!this.allow(`issue:${userId}`, 3, TTL_MS) || !this.allow(`target:${expectedAddress}`, 3, TTL_MS)) {
        // Return outside the transaction below so the rate-limit write is retained.
        return undefined;
      }
      const connection = this.connectionForUser(userId);
      if (connection) throw new ApiError(409, "already_connected", "Disconnect the existing iMessage account before reconnecting.");
      if (this.connectionForSender(expectedAddress)) throw new ApiError(409, "address_in_use", "This iMessage address is already connected.");
      const code = randomBytes(12).toString("hex").toUpperCase();
      const expiresAt = this.now() + TTL_MS;
      this.db.prepare("DELETE FROM link_challenges WHERE user_id = ?").run(userId);
      this.db.prepare("INSERT INTO link_challenges VALUES (?, ?, ?, ?)").run(hash(code), userId, expectedAddress, expiresAt);
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
    if (!challenge) throw new ApiError(429, "rate_limited", "You can request three connection codes every five minutes.");
    return challenge;
  }

  issueManagement(address: string) {
    const result=this.transaction(()=>{
      if(!this.allow(`manage:${address}`,3,TTL_MS))return undefined;
      const connection=this.connectionForSender(address);
      if(!connection)throw new ApiError(404,"connection_not_found","This number is not connected. Start a new conversation first.");
      const accessToken=randomBytes(32).toString("hex"),code=randomBytes(12).toString("hex").toUpperCase();
      this.db.prepare("DELETE FROM management_sessions WHERE user_id=? AND verified=0").run(connection.user_id);
      this.db.prepare("INSERT INTO management_sessions VALUES (?,?,?,?,?,?,?,0)").run(hash(accessToken),hash(code),connection.user_id,address,connection.connected_at,this.now()+TTL_MS,this.now()+20*60_000);
      return {intakeId:"management",accessToken,code,expiresAt:new Date(this.now()+TTL_MS).toISOString()};
    });
    if(!result)throw new ApiError(429,"rate_limited","Wait five minutes before requesting another management code.");
    return result;
  }
  revokeManagement(token:string) {this.db.prepare("DELETE FROM management_sessions WHERE token_hash=?").run(hash(token));}
  managementStatus(token:string): "pending" | "connected" | "expired" | undefined {
    const row=this.db.prepare(`SELECT m.verified,m.code_expires_at,m.expires_at FROM management_sessions m
      JOIN connections c ON c.user_id=m.user_id AND c.sender_address=m.expected_address AND c.connected_at=m.connected_at
      WHERE m.token_hash=?`).get(hash(token)) as {verified:number;code_expires_at:number;expires_at:number}|undefined;
    if(!row)return undefined;
    if(row.expires_at<=this.now()||(!row.verified&&row.code_expires_at<=this.now()))return "expired";
    return row.verified?"connected":"pending";
  }
  managementUser(token:string):string|undefined {
    if(this.managementStatus(token)!=="connected")return undefined;
    return (this.db.prepare("SELECT user_id FROM management_sessions WHERE token_hash=?").get(hash(token)) as {user_id:string}).user_id;
  }
  confirmManagement(sender:string,code:string):boolean {
    return this.transaction(()=>{
      if(!this.allow(`manage-attempt:${sender}`,5,60_000))return false;
      const row=this.db.prepare(`SELECT m.token_hash FROM management_sessions m JOIN connections c
        ON c.user_id=m.user_id AND c.sender_address=m.expected_address AND c.connected_at=m.connected_at
        WHERE m.code_hash=? AND m.expected_address=? AND m.verified=0 AND m.code_expires_at>? AND m.expires_at>?`).get(hash(code.toUpperCase()),sender,this.now(),this.now()) as {token_hash:string}|undefined;
      if(!row)return false;
      this.db.prepare("UPDATE management_sessions SET verified=1,code_hash=NULL WHERE token_hash=?").run(row.token_hash);
      return true;
    });
  }

  revokeCode(code: string): void { this.db.prepare("DELETE FROM link_challenges WHERE code_hash = ?").run(hash(code)); }
  cancelChallengesForSender(address: string): void {
    this.db.prepare("DELETE FROM link_challenges WHERE expected_address = ?").run(address);
    this.db.prepare("DELETE FROM management_sessions WHERE expected_address=?").run(address);
  }
  connectionForUser(userId: string): Connection | undefined {
    return this.db.prepare("SELECT * FROM connections WHERE user_id = ?").get(userId) as Connection | undefined;
  }
  connectionForSender(address: string): Connection | undefined {
    return this.db.prepare("SELECT * FROM connections WHERE sender_address = ?").get(address) as Connection | undefined;
  }
  disconnect(userId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM management_sessions WHERE user_id=?").run(userId);
      this.db.prepare("DELETE FROM connections WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM link_challenges WHERE user_id = ?").run(userId);
    });
  }

  prepareReply(message: IncomingMessage): { reply: string; alreadySent: boolean } {
    return this.transaction(() => {
      const receipt = this.db.prepare("SELECT reply, reply_sent FROM message_receipts WHERE message_id = ?").get(message.id) as Receipt | undefined;
      if (receipt) return { reply: receipt.reply, alreadySent: receipt.reply_sent === 1 };
      let reply: string;
      if (/^CONNECT(?:\s|$)/i.test(message.text?.trim() ?? "")) {
        const code = /^CONNECT\s+([A-F0-9]{24})$/i.exec(message.text!.trim())?.[1]?.toUpperCase();
        if (!this.allow(`attempt:${message.sender}`, 5, 60_000)) {
          reply = "Too many connection attempts. Wait a minute, then try again.";
        } else {
          const challenge = code ? this.db.prepare("SELECT * FROM link_challenges WHERE code_hash = ?").get(hash(code)) as Challenge | undefined : undefined;
          if (!challenge || challenge.expires_at <= this.now() || challenge.expected_address !== message.sender) {
            reply = "That connection code is invalid, expired, or was requested for a different iMessage address. Request a new code on the website and send it from the address you entered.";
          } else if (this.connectionForSender(message.sender) || this.connectionForUser(challenge.user_id)) {
            reply = "This account or iMessage address is already connected. Disconnect it on the website before connecting again.";
          } else {
            this.db.prepare("INSERT INTO connections VALUES (?, ?, ?, ?, ?)").run(challenge.user_id, message.sender, message.spaceId, message.line, this.now());
            this.db.prepare("DELETE FROM link_challenges WHERE code_hash = ?").run(hash(code!));
            reply = "Your iMessage is connected to MoreTime. You can return to the website to check the connection.";
          }
        }
      } else if (!this.connectionForSender(message.sender)) {
        reply = "To connect this chat to your MoreTime account, sign in on the website and choose Connect iMessage.";
      } else if (message.attachment) {
        reply = "Your MoreTime account is connected. Bill processing is not available yet; this attachment has not been analyzed or saved.";
      } else {
        reply = "Your MoreTime account is connected. The messaging connection is ready; the bill-resolution assistant is still being connected.";
      }
      this.db.prepare("INSERT INTO message_receipts (message_id, reply, reply_sent, created_at) VALUES (?, ?, 0, ?)").run(message.id, reply, this.now());
      return { reply, alreadySent: false };
    });
  }

  replyForMessage(id: string): { reply: string; alreadySent: boolean } | undefined {
    const receipt = this.db.prepare("SELECT reply, reply_sent FROM message_receipts WHERE message_id = ?").get(id) as Receipt | undefined;
    return receipt ? { reply: receipt.reply, alreadySent: receipt.reply_sent === 1 } : undefined;
  }

  cacheReply(id: string, reply: string, userId?: string): { reply: string; alreadySent: boolean } {
    this.db.prepare(`INSERT INTO message_receipts (message_id, reply, reply_sent, created_at, user_id)
      VALUES (?, ?, 0, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
      reply = excluded.reply, user_id = excluded.user_id WHERE message_receipts.reply_sent = 0
    `).run(id, reply, this.now(), userId ?? null);
    return this.replyForMessage(id)!;
  }

  removeRepliesForUser(userId: string): void {
    this.db.prepare("DELETE FROM message_receipts WHERE user_id = ?").run(userId);
  }

  markReplySent(id: string): void { this.db.prepare("UPDATE message_receipts SET reply_sent = 1 WHERE message_id = ?").run(id); }
  prune(): void {
    this.db.prepare("DELETE FROM management_sessions WHERE expires_at<=?").run(this.now());
    this.db.prepare("DELETE FROM link_challenges WHERE expires_at <= ?").run(this.now());
    this.db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(this.now());
    this.db.prepare("DELETE FROM message_receipts WHERE created_at < ?").run(this.now() - 7 * 24 * 60 * 60_000);
  }
  close(): void { this.db.close(); }
}
