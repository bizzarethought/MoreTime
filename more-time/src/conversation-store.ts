import { DatabaseSync } from "node:sqlite";
import { billFactsSchema } from "./gemini.ts";
import type { BillDocument, BillFacts, ChatTurn } from "./gemini.ts";

export class ConversationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bill_sessions (
        user_id TEXT PRIMARY KEY, bill_json TEXT NOT NULL,
        document_name TEXT, document_type TEXT, document_bytes BLOB
      );
      CREATE TABLE IF NOT EXISTS bill_turns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
        question TEXT NOT NULL, reply TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bill_turns_user ON bill_turns(user_id, sequence);
    `);
  }

  session(userId: string): { bill: BillFacts; document: BillDocument | null } | undefined {
    const row = this.db.prepare("SELECT * FROM bill_sessions WHERE user_id = ?").get(userId) as {
      bill_json: string; document_name: string | null; document_type: string | null; document_bytes: Uint8Array | null;
    } | undefined;
    return row ? {
      bill: billFactsSchema.parse(JSON.parse(row.bill_json)),
      document: row.document_bytes ? { name: row.document_name!, type: row.document_type!, bytes: row.document_bytes } : null,
    } : undefined;
  }

  reply(messageId: string, userId: string): string | undefined {
    const row = this.db.prepare("SELECT reply FROM bill_turns WHERE message_id = ? AND user_id = ?").get(messageId, userId) as { reply: string } | undefined;
    return row?.reply;
  }

  history(userId: string): ChatTurn[] {
    const rows = this.db.prepare(`SELECT question, reply FROM bill_turns
      WHERE user_id = ? ORDER BY sequence DESC LIMIT 10`).all(userId) as unknown as ChatTurn[];
    return rows.reverse();
  }

  complete(input: { userId: string; messageId: string; question: string; reply: string; bill: BillFacts; document: BillDocument | null }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A duplicate delivery must never replace a newer case's bill facts.
      if (!this.reply(input.messageId, input.userId)) {
        this.db.prepare(`INSERT INTO bill_sessions VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET bill_json = excluded.bill_json,
            document_name = excluded.document_name, document_type = excluded.document_type,
            document_bytes = excluded.document_bytes
        `).run(input.userId, JSON.stringify(input.bill), input.document?.name ?? null,
          input.document?.type ?? null, input.document?.bytes ?? null);
        this.db.prepare(`INSERT INTO bill_turns (message_id, user_id, question, reply) VALUES (?, ?, ?, ?)`)
          .run(input.messageId, input.userId, input.question, input.reply);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  remove(userId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM bill_turns WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM bill_sessions WHERE user_id = ?").run(userId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
