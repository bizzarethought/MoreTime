import { Spectrum } from "spectrum-ts";
import type { SpectrumInstance } from "spectrum-ts";
import type { Server } from "node:http";
import { imessage } from "spectrum-ts/providers/imessage";
import { resolve } from "node:path";
import { authenticationFromEnvironment } from "./auth.ts";
import { createApi } from "./api.ts";
import { createIntakeApi } from "./intake-api.ts";
import { IntakeStore } from "./intake-store.ts";
import { createHttpServer } from "./server.ts";
import { LinkStore } from "./store.ts";
import { photonTransport, runMessageLoop } from "./photon.ts";
import { geminiFromEnvironment, DEFAULT_GEMINI_CHAT_TIMEOUT_MS, DEFAULT_GEMINI_TIMEOUT_MS } from "./gemini.ts";
import { ConversationStore } from "./conversation-store.ts";
import { createMessageHandler } from "./assistant.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { FollowUpStore, runFollowUps } from "./follow-ups.ts";
import { EmailStore, emailConfig, gmailNotices } from "./email.ts";
import { createEngagementApi } from "./engagement-api.ts";

const projectId = process.env.PROJECT_ID || process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.PROJECT_SECRET || process.env.SPECTRUM_PROJECT_SECRET;

if (!projectId?.trim() || !projectSecret?.trim()) {
  console.error(
    "Missing Photon credentials. Set PROJECT_ID and PROJECT_SECRET in more-time/.env " +
    "using your project Settings at https://app.photon.codes."
  );
  process.exit(1);
}

let app: SpectrumInstance | undefined;
let store: LinkStore | undefined;
let intakes: IntakeStore | undefined;
let conversations: ConversationStore | undefined;
let server: Server | undefined;
let cleanup: ReturnType<typeof setInterval> | undefined;
let followUps: FollowUpStore | undefined;
let emails: EmailStore | undefined;
let engagementTimer: ReturnType<typeof setInterval> | undefined;
let engagementRun: Promise<void> | undefined;
let stopping=false;
let startupStage="configuration";

try {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const authenticate = authenticationFromEnvironment(process.env);
  startupStage="photon_connection";
  app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  startupStage="database";
  const databasePath = resolve(process.env.DATABASE_PATH ?? "data/moretime.sqlite");
  store = new LinkStore(databasePath);
  intakes = new IntakeStore(databasePath);
  conversations = new ConversationStore(databasePath);
  startupStage="gemini_configuration";
  const engine = geminiFromEnvironment(process.env);
  startupStage="email_configuration";
  const config=emailConfig(process.env);
  startupStage="follow_up_database";
  followUps=new FollowUpStore(databasePath);
  emails=new EmailStore(databasePath,config?.key);
  const handleMessage = createMessageHandler({ store, intakes, conversations, engine, followUps, emails });
  intakes.prune();
  const transport = photonTransport(app);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:8000,http://127.0.0.1:8000")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  server = createHttpServer(createEngagementApi({
    intakes,links:store,followUps,emails,config,allowedOrigins,transport,
    fallback:createIntakeApi({
    store, intakes, transport, allowedOrigins,
    fallback: createApi({ store, authenticate, transport, allowedOrigins }),
  })}));
  startupStage="http_listener";
  await new Promise<void>((done, reject) => {
    server!.once("error", reject);
    server!.listen(port, process.env.HOST ?? "127.0.0.1", done);
  });
  console.log(`MoreTime intake and account-linking API is listening on port ${port}. Ctrl+C stops it.`);
  console.log(engine ? "Gemini bill analysis and chat are enabled." : "Set GEMINI_API_KEY to enable bill analysis and chat. Messaging verification is available.");
  if (engine) console.log(`Gemini runtime: version=3 prompt=${PROMPT_VERSION} saved_facts_first=true retry_attempts=2 chat_timeout_ms=${Number(process.env.GEMINI_CHAT_TIMEOUT_MS?.trim() || DEFAULT_GEMINI_CHAT_TIMEOUT_MS)} document_timeout_ms=${Number(process.env.GEMINI_TIMEOUT_MS?.trim() || DEFAULT_GEMINI_TIMEOUT_MS)}.`);
  if (!process.env.AUTH_JWKS_URL || !process.env.AUTH_ISSUER || !process.env.AUTH_AUDIENCE) {
    console.log("Configure AUTH_JWKS_URL, AUTH_ISSUER, and AUTH_AUDIENCE before connecting website accounts.");
  }
  cleanup = setInterval(() => { store!.prune(); intakes!.prune(); }, 60_000);
  cleanup.unref();
  const send=async(connection: import("./store.ts").Connection,text:string)=>{
    if(stopping||store!.connectionForUser(connection.user_id)?.space_id!==connection.space_id)throw new Error("disconnected");
    const space=await imessage(app!).space.get(connection.space_id, /^\+[1-9]\d{7,14}$/.test(connection.line)?{phone:connection.line}:undefined);
    if(stopping||!store!.connectionForUser(connection.user_id)||!followUps!.emailAlertsEnabled(connection.user_id))throw new Error("disconnected");
    const delivered=await space.send(text);
    if(!delivered)throw new Error("unconfirmed_delivery");
  };
  let lastEmailPoll=0;
  const tick=async()=>{
    await runFollowUps({followUps:followUps!,links:store!,send});
    if(!config||Date.now()-lastEmailPoll<10*60_000)return;
    lastEmailPoll=Date.now();
    for(const row of emails!.candidates()) {
      if(stopping||!followUps!.emailAlertsEnabled(row.user_id))continue;
      const connection=store!.connectionForUser(row.user_id);
      if(!connection){emails!.remove(row.user_id);continue;}
      try {
        const ids=await gmailNotices(config,emails!,row.user_id,row.connected_at);
        if(!ids.length||stopping||!followUps!.emailAlertsEnabled(row.user_id)||!emails!.status(row.user_id).connected)continue;
        if(!emails!.reserve(row.user_id,ids))continue;
        await send(connection,`Gmail has ${ids.length===1?"a possible payment notice":"possible payment notices"} received since you connected MoreTime. Please check your inbox and share any notice you want help with. A search match doesn’t confirm an amount or deadline. Reply EMAIL OFF to disconnect Gmail, or FOLLOWUPS OFF to pause all check-ins and alerts.`);
      } catch {console.error("MoreTime could not check or confirm an email notice alert. No email contents logged.");}
    }
  };
  const startTick=()=>{
    if(engagementRun||stopping)return;
    engagementRun=tick().catch(()=>console.error("MoreTime follow-up worker failed.")).finally(()=>{engagementRun=undefined;});
  };
  engagementTimer=setInterval(startTick,60_000);engagementTimer.unref();startTick();
  console.log(config?"Optional Gmail connection and approved notice alerts are available.":"Gmail connection needs GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, GOOGLE_EMAIL_REDIRECT_URI, and EMAIL_TOKEN_KEY.");
  startupStage="message_loop";
  await runMessageLoop(app, store, handleMessage);
} catch (error) {
  // Fixed labels only: SDK messages can contain credentials or bill contents.
  const rawCode=error && typeof error==="object" && "code" in error ? error.code : undefined;
  const code=["EADDRINUSE","EACCES","EPERM","ENOENT","SQLITE_ERROR","ERR_SQLITE_ERROR"].includes(String(rawCode))?String(rawCode):"unknown_error";
  console.error(`MoreTime startup failed: stage=${startupStage} code=${code}.`);
  if(code==="EADDRINUSE") console.error("The backend port is already in use. Stop the earlier MoreTime backend in its terminal, then run ./run.sh again.");
  else if(startupStage==="email_configuration") console.error("Check GOOGLE_EMAIL_REDIRECT_URI (HTTPS or localhost callback) and EMAIL_TOKEN_KEY (64 hex characters). Gmail is optional; omit its configuration until ready.");
  else if(startupStage==="database"||startupStage==="follow_up_database") console.error("Check that DATABASE_PATH points to a writable SQLite database and its parent directory is accessible.");
  else if(startupStage==="gemini_configuration") console.error("Check GEMINI_TIMEOUT_MS and GEMINI_CHAT_TIMEOUT_MS: integer milliseconds from 1000 through 300000.");
  else console.error("Check the configuration for the reported stage. No private error details logged.");
  process.exitCode = 1;
} finally {
  stopping=true;
  if(engagementTimer)clearInterval(engagementTimer);
  await engagementRun;
  if (cleanup) clearInterval(cleanup);
  server?.close();
  try { await app?.stop(); }
  catch { console.error("Could not cleanly close the Photon connection."); }
  followUps?.close();
  emails?.close();
  intakes?.close();
  conversations?.close();
  store?.close();
}
