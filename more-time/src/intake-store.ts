import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface IntakeDetails {
  address: string;
  details: string;
  zipCode: string | null;
  state: string | null;
  bill: { name: string; type: string; bytes: Uint8Array } | null;
}

export function intakeIdentity() {
  const intakeId = randomUUID();
  return { intakeId, userId: `guest-intake:${intakeId}`, accessToken: randomBytes(32).toString("hex") };
}

// Open the SAME SQLite file as LinkStore, after LinkStore creates its tables.
// This keeps the established phone-verification handler as the source of truth.
export class IntakeStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS guest_intakes (
        intake_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
        address TEXT, details TEXT, zip_code TEXT, state TEXT,
        bill_name TEXT, bill_type TEXT, bill_bytes BLOB
      );
      CREATE INDEX IF NOT EXISTS guest_intakes_expiry ON guest_intakes(expires_at);
    `);
  }

  save(identity: ReturnType<typeof intakeIdentity>, expiresAt: string, input: IntakeDetails): void {
    this.db.prepare(`INSERT INTO guest_intakes
      (intake_id, user_id, token_hash, expires_at, address, details, zip_code, state, bill_name, bill_type, bill_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(identity.intakeId, identity.userId, hash(identity.accessToken), Date.parse(expiresAt),
      input.address, input.details, input.zipCode, input.state,
      input.bill?.name ?? null, input.bill?.type ?? null, input.bill?.bytes ?? null);
  }

  status(accessToken: string): { intakeId: string; status: "pending" | "connected" | "expired" } | undefined {
    this.prune();
    const row = this.db.prepare(`SELECT i.intake_id, i.expires_at,
        EXISTS(SELECT 1 FROM connections c WHERE c.user_id = i.user_id) AS connected
      FROM guest_intakes i WHERE token_hash = ?
    `).get(hash(accessToken)) as { intake_id: string; expires_at: number; connected: number } | undefined;
    if (!row) return undefined;
    return { intakeId: row.intake_id, status: row.connected ? "connected" : row.expires_at <= this.now() ? "expired" : "pending" };
  }

  // Server-only handoff for the assistant. Never expose this over the guest
  // status endpoint: only a verified message sender can have a connection.
  forConnection(userId: string): IntakeDetails | undefined {
    const row = this.db.prepare(`SELECT i.* FROM guest_intakes i
      JOIN connections c ON c.user_id = i.user_id WHERE i.user_id = ?
    `).get(userId) as {
      address: string; details: string; zip_code: string | null; state: string | null;
      bill_name: string | null; bill_type: string | null; bill_bytes: Uint8Array | null;
    } | undefined;
    if (!row) return undefined;
    return {
      address: row.address, details: row.details, zipCode: row.zip_code, state: row.state,
      bill: row.bill_bytes ? { name: row.bill_name!, type: row.bill_type!, bytes: row.bill_bytes } : null,
    };
  }

  remove(intakeId: string): void {
    this.db.prepare("DELETE FROM guest_intakes WHERE intake_id = ?").run(intakeId);
  }

  removeForUser(userId: string): void {
    this.db.prepare("DELETE FROM guest_intakes WHERE user_id = ?").run(userId);
  }

  removeUnverifiedForSender(address: string): void {
    this.db.prepare(`DELETE FROM guest_intakes WHERE address = ?
      AND NOT EXISTS(SELECT 1 FROM connections c WHERE c.user_id = guest_intakes.user_id)
    `).run(address);
  }

  prune(): void {
    // Retain only a short-lived status tombstone for an expired browser tab.
    // Connected intakes remain available for the future agent, even if the
    // visitor closed the tab before its next status check.
    this.db.prepare(`UPDATE guest_intakes SET address = NULL, details = NULL,
      zip_code = NULL, state = NULL, bill_name = NULL, bill_type = NULL, bill_bytes = NULL
      WHERE expires_at <= ? AND address IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM connections c WHERE c.user_id = guest_intakes.user_id)
    `).run(this.now());
    this.db.prepare(`DELETE FROM guest_intakes WHERE expires_at <= ?
      AND NOT EXISTS(SELECT 1 FROM connections c WHERE c.user_id = guest_intakes.user_id)
    `).run(this.now() - 24 * 60 * 60_000);
  }

  close(): void { this.db.close(); }
}
