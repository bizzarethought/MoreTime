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

try {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const authenticate = authenticationFromEnvironment(process.env);
  app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
  const databasePath = resolve(process.env.DATABASE_PATH ?? "data/moretime.sqlite");
  store = new LinkStore(databasePath);
  intakes = new IntakeStore(databasePath);
  conversations = new ConversationStore(databasePath);
  const engine = geminiFromEnvironment(process.env);
  const handleMessage = createMessageHandler({ store, intakes, conversations, engine });
  intakes.prune();
  const transport = photonTransport(app);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:8000,http://127.0.0.1:8000")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  server = createHttpServer(createIntakeApi({
    store, intakes, transport, allowedOrigins,
    fallback: createApi({ store, authenticate, transport, allowedOrigins }),
  }));
  await new Promise<void>((done, reject) => {
    server!.once("error", reject);
    server!.listen(port, process.env.HOST ?? "127.0.0.1", done);
  });
  console.log(`MoreTime intake and account-linking API is listening on port ${port}. Ctrl+C stops it.`);
  console.log(engine ? "Gemini bill analysis and chat are enabled." : "Set GEMINI_API_KEY to enable bill analysis and chat. Messaging verification is available.");
  if (engine) console.log(`Gemini runtime: version=2 saved_facts_first=true retry_attempts=2 chat_timeout_ms=${Number(process.env.GEMINI_CHAT_TIMEOUT_MS?.trim() || DEFAULT_GEMINI_CHAT_TIMEOUT_MS)} document_timeout_ms=${Number(process.env.GEMINI_TIMEOUT_MS?.trim() || DEFAULT_GEMINI_TIMEOUT_MS)}.`);
  if (!process.env.AUTH_JWKS_URL || !process.env.AUTH_ISSUER || !process.env.AUTH_AUDIENCE) {
    console.log("Configure AUTH_JWKS_URL, AUTH_ISSUER, and AUTH_AUDIENCE before connecting website accounts.");
  }
  cleanup = setInterval(() => { store!.prune(); intakes!.prune(); }, 60_000);
  cleanup.unref();
  await runMessageLoop(app, store, handleMessage);
} catch {
  // Avoid printing SDK errors that might contain credentials or message contents.
  console.error(
    "MoreTime startup failed. Verify Photon credentials at https://app.photon.codes, " +
    "iMessage access, Gemini configuration, authentication configuration, database path, and server port."
  );
  process.exitCode = 1;
} finally {
  if (cleanup) clearInterval(cleanup);
  server?.close();
  try { await app?.stop(); }
  catch { console.error("Could not cleanly close the Photon connection."); }
  intakes?.close();
  conversations?.close();
  store?.close();
}
