import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface EmailConfig { clientId: string; clientSecret: string; redirectUri: string; key: Buffer }
export function emailConfig(env: NodeJS.ProcessEnv): EmailConfig | undefined {
  if (!env.GOOGLE_EMAIL_CLIENT_ID || !env.GOOGLE_EMAIL_CLIENT_SECRET || !env.GOOGLE_EMAIL_REDIRECT_URI || !env.EMAIL_TOKEN_KEY) return undefined;
  const redirect=new URL(env.GOOGLE_EMAIL_REDIRECT_URI);
  if (redirect.pathname!=="/api/email/callback" || redirect.username || redirect.password ||
    (redirect.protocol!=="https:" && !(redirect.protocol==="http:" && ["localhost","127.0.0.1"].includes(redirect.hostname)))) throw new Error("invalid_email_redirect");
  if (!/^[a-f0-9]{64}$/i.test(env.EMAIL_TOKEN_KEY)) throw new Error("invalid_email_key");
  return {clientId:env.GOOGLE_EMAIL_CLIENT_ID,clientSecret:env.GOOGLE_EMAIL_CLIENT_SECRET,redirectUri:redirect.href,key:Buffer.from(env.EMAIL_TOKEN_KEY,"hex")};
}
export class EmailStore {
  private db: DatabaseSync;
  constructor(path:string, private key?:Buffer, private now=Date.now) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS email_oauth_states (state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_connections (user_id TEXT PRIMARY KEY,email TEXT NOT NULL,token TEXT NOT NULL,connected_at INTEGER NOT NULL,last_alert_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS email_notice_receipts (user_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(user_id,message_id));`);
  }
  start(userId:string) {
    const state=randomBytes(32).toString("hex"), verifier=randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM email_oauth_states WHERE user_id=? OR expires_at<=?").run(userId,this.now());
    this.db.prepare("INSERT INTO email_oauth_states VALUES (?,?,?,?)").run(digest(state),userId,verifier,this.now()+5*60_000);
    return {state,challenge:createHash("sha256").update(verifier).digest("base64url")};
  }
  consume(state:string) {
    const row=this.db.prepare("DELETE FROM email_oauth_states WHERE state_hash=? RETURNING *").get(digest(state)) as
      {user_id:string;verifier:string;expires_at:number}|undefined;
    return row && row.expires_at>this.now() ? row : undefined;
  }
  connect(userId:string,email:string,refreshToken:string) {
    if (!this.key) throw new Error("email_unconfigured");
    const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",this.key,iv);
    cipher.setAAD(Buffer.from(userId));
    const encrypted=Buffer.concat([cipher.update(refreshToken,"utf8"),cipher.final()]);
    const token=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64");
    this.db.prepare(`INSERT INTO email_connections (user_id,email,token,connected_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,token=excluded.token,connected_at=excluded.connected_at,last_alert_at=0`).run(userId,email,token,this.now());
    this.db.prepare("DELETE FROM email_notice_receipts WHERE user_id=?").run(userId);
  }
  token(userId:string):string {
    const row=this.db.prepare("SELECT token FROM email_connections WHERE user_id=?").get(userId) as {token:string}|undefined;
    if (!this.key || !row) throw new Error("email_disconnected");
    const bytes=Buffer.from(row.token,"base64"),decipher=createDecipheriv("aes-256-gcm",this.key,bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));decipher.setAAD(Buffer.from(userId));
    return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8");
  }
  status(userId:string) {
    const row=this.db.prepare("SELECT email FROM email_connections WHERE user_id=?").get(userId) as {email:string}|undefined;
    return {connected:Boolean(row),email:row?.email??null};
  }
  candidates() {return this.db.prepare("SELECT user_id,connected_at FROM email_connections WHERE last_alert_at=0 OR last_alert_at<=?").all(this.now()-86_400_000) as {user_id:string;connected_at:number}[];}
  unseen(userId:string, ids:string[]) {
    return ids.filter(id=>!this.db.prepare("SELECT 1 FROM email_notice_receipts WHERE user_id=? AND message_id=?").get(userId,id));
  }
  reserve(userId:string,ids:string[]):boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row=this.db.prepare("SELECT last_alert_at FROM email_connections WHERE user_id=?").get(userId) as {last_alert_at:number}|undefined;
      if(!row||(row.last_alert_at!==0&&row.last_alert_at>this.now()-86_400_000)||!this.unseen(userId,ids).length){this.db.exec("COMMIT");return false;}
      for(const id of ids) this.db.prepare("INSERT OR IGNORE INTO email_notice_receipts VALUES (?,?)").run(userId,id);
      this.db.prepare("UPDATE email_connections SET last_alert_at=? WHERE user_id=?").run(this.now(),userId);
      this.db.exec("COMMIT");return true;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  remove(userId:string) {
    this.db.prepare("DELETE FROM email_connections WHERE user_id=?").run(userId);
    this.db.prepare("DELETE FROM email_oauth_states WHERE user_id=?").run(userId);
    this.db.prepare("DELETE FROM email_notice_receipts WHERE user_id=?").run(userId);
  }
  close(){this.db.close();}
}
export async function googleJson(url:string,init:RequestInit={},fetcher=fetch):Promise<any> {
  const response=await fetcher(url,{...init,signal:AbortSignal.timeout(15_000),redirect:"error"});
  if (!response.ok) throw new Error(response.status===400||response.status===401?"email_authorization_failed":"email_service_unavailable");
  return response.json();
}
export async function gmailNotices(config:EmailConfig, store:EmailStore,userId:string,since:number,fetcher=fetch) {
  const token=await googleJson("https://oauth2.googleapis.com/token",{method:"POST",body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,refresh_token:store.token(userId),grant_type:"refresh_token"})},fetcher);
  if(typeof token.access_token!=="string") throw new Error("invalid_email_token");
  const url=new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q",`after:${Math.floor(since/1000)} newer_than:7d {subject:bill subject:payment subject:overdue subject:shutoff subject:disconnection}`);
  url.searchParams.set("maxResults","25");
  const data=await googleJson(url.href,{headers:{Authorization:`Bearer ${token.access_token}`}},fetcher);
  const ids=(Array.isArray(data.messages)?data.messages:[]).flatMap((message:{id?:string})=>typeof message.id==="string"?[message.id]:[]);
  // These are possible notices only. No email text is trusted as an instruction,
  // and no payment amount or deadline is asserted from a search match.
  return store.unseen(userId,ids);
}
