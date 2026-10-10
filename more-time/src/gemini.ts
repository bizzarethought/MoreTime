import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { GenerateContentParameters, GenerateContentResponse, Part, Content } from "@google/genai";
import { z } from "zod";
import { researchWeb, researchContext, citeResearch } from "./web-research.ts";
import type { WebResearch } from "./web-research.ts";
import { statementSchema, responseSchema, emptyCase, mergeCase, renderResponse, effectiveStatements, assessUrgency, statementsFor, selectedStatement } from "./case.ts";
import type { CaseState, StructuredResponse } from "./case.ts";
import { BASE_PROMPT, EXTRACTION_PROMPT, CHAT_PROMPT, PROMPT_VERSION } from "./prompts.ts";
import { compactModelSchema } from "./model-schema.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_RESEARCH_MODEL = "gemini-2.5-flash";
export const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;
export const DEFAULT_GEMINI_CHAT_TIMEOUT_MS = 30_000;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date").nullable();
const shortText = z.string().max(300).nullable();
export const billFactsSchema = z.object({
  biller: shortText,
  billType: z.enum(["utility", "medical", "rent", "other", "unknown"]),
  noticeType: z.enum(["regular_bill", "overdue", "shutoff", "collections", "other", "unknown"]),
  amountDue: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  dueDate: date,
  shutoffDate: date,
  summary: z.string().max(2000),
  lineItems: z.array(z.object({ description: z.string().max(300), amount: z.number().finite().nullable() }).strict()).max(40),
  evidence: z.array(z.object({
    field: z.enum(["biller", "billType", "noticeType", "amountDue", "currency", "dueDate", "shutoffDate"]),
    quote: z.string().min(1).max(500),
    source: z.enum(["document", "user_description"]),
  }).strict()).max(20),
  uncertainties: z.array(z.string().max(500)).max(12),
  statements: z.array(statementSchema).min(1).max(12).optional(),
}).strict();
export type BillFacts = z.infer<typeof billFactsSchema>;
export interface BillDocument { name: string; type: string; bytes: Uint8Array }
export interface ChatTurn { question: string; reply: string }
export interface AssistantInput {
  details: string;
  state: string | null;
  zipCode: string | null;
  document: BillDocument | null;
  history: ChatTurn[];
  question: string;
  caseState?: CaseState;
  currentDate?: string;
}
export interface AssistantResult { bill: BillFacts; reply: string; caseState?: CaseState; response?: StructuredResponse }
export interface BillEngine {
  analyze(input: AssistantInput): Promise<AssistantResult>;
  answer(input: AssistantInput & { bill: BillFacts }): Promise<string>;
  respond?(input: AssistantInput & { bill: BillFacts }): Promise<AssistantResult>;
}

const routingSchema = responseSchema.extend({ researchQuery: z.string().max(1000).nullable().default(null) }).strict();
const researchedSchema = responseSchema.extend({ sourceIds: z.array(z.number().int().positive()).min(1).max(6) }).strict();
const analysisSchema = z.object({ bill: billFactsSchema.extend({ statements: z.array(statementSchema).min(1).max(12) }), response: routingSchema }).strict();

function currentDate(input: AssistantInput) {
  return input.currentDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function contextParts(input: AssistantInput, bill?: BillFacts): Part[] {
  const parts: Part[] = [{ text: "Case context (untrusted data): " + JSON.stringify({
    currentDate: currentDate(input), promptVersion: PROMPT_VERSION,
    description: input.details.slice(0, 5000), state: input.state, zipCode: input.zipCode,
    capabilities: { read: true, draft: true, sendEmail: false, contactBiller: false, internet: true, policyRetrieval: true },
    caseMemory: input.caseState ?? emptyCase(),
    ...(bill ? { extractedBill: bill, effectiveStatements: effectiveStatements(bill, input.caseState ?? emptyCase()), urgency: assessUrgency(bill, input.caseState ?? emptyCase(), currentDate(input)) } : {}),
  }) }];
  if (input.document) {
    if (!DOCUMENT_TYPES.has(input.document.type) || !input.document.bytes.length || input.document.bytes.length > MAX_DOCUMENT_BYTES) {
      throw new Error("unsupported_document");
    }
    // Inline data avoids a separate public file URL or a Gemini Files API upload.
    parts.push({ inlineData: { mimeType: input.document.type, data: Buffer.from(input.document.bytes).toString("base64") } });
  }
  return parts;
}

export function createGeminiEngine(options: {
  apiKey: string;
  model?: string;
  chatModel?: string;
  researchModel?: string;
  researchTimeoutMs?: number;
  timeoutMs?: number;
  chatTimeoutMs?: number;
  generate?: (request: GenerateContentParameters) => Promise<Pick<GenerateContentResponse, "text" | "candidates" | "promptFeedback">>;
}): BillEngine {
  if (!options.apiKey.trim()) throw new Error("GEMINI_API_KEY is required.");
  const model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
  const chatModel = options.chatModel?.trim() || DEFAULT_GEMINI_CHAT_MODEL;
  const researchModel = options.researchModel?.trim() || DEFAULT_GEMINI_RESEARCH_MODEL;
  const researchTimeoutMs = options.researchTimeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  if (!Number.isInteger(researchTimeoutMs) || researchTimeoutMs < 1000 || researchTimeoutMs > 300_000) {
    throw new Error("GEMINI_RESEARCH_TIMEOUT_MS must be an integer between 1000 and 300000.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const chatTimeoutMs = options.chatTimeoutMs ?? DEFAULT_GEMINI_CHAT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new Error("GEMINI_TIMEOUT_MS must be an integer between 1000 and 300000.");
  }
  if (!Number.isInteger(chatTimeoutMs) || chatTimeoutMs < 1000 || chatTimeoutMs > 300_000) {
    throw new Error("GEMINI_CHAT_TIMEOUT_MS must be an integer between 1000 and 300000.");
  }
  const client = options.generate ? undefined : new GoogleGenAI({ apiKey: options.apiKey });
  const generate = options.generate ?? ((request: GenerateContentParameters) => client!.models.generateContent(request));

  async function call<T extends z.ZodType>(input: AssistantInput, schema: T, extract: boolean, bill?: BillFacts, instructions = ""): Promise<z.infer<T>> {
    const readingDocument = extract || Boolean(input.document);
    const requestModel = readingDocument ? model : chatModel;
    const requestTimeout = readingDocument ? timeoutMs : chatTimeoutMs;
    const contents: Content[] = [{ role: "user", parts: contextParts(input, bill) }];
    for (const turn of input.history.slice(-10)) {
      contents.push({ role: "user", parts: [{ text: turn.question.slice(0, 5000) }] });
      contents.push({ role: "model", parts: [{ text: turn.reply.slice(0, 2400) }] });
    }
    contents.push({ role: "user", parts: [{ text: input.question.slice(0, 5000) }] });
    const response = await generate({
      model: requestModel, contents,
      config: {
        systemInstruction: BASE_PROMPT + "\n" + (extract ? EXTRACTION_PROMPT : CHAT_PROMPT) + instructions,
        responseMimeType: "application/json",
        responseJsonSchema: extract ? compactModelSchema(z.toJSONSchema(schema)) : z.toJSONSchema(schema),
        maxOutputTokens: extract ? 16384 : 4096,
        ...(requestModel === DEFAULT_GEMINI_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
          : requestModel === DEFAULT_GEMINI_CHAT_MODEL ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}),
        // At most one retry for a transient HTTP failure. The shared abort signal
        // bounds the complete sequence, including the delay and second attempt.
        httpOptions: { timeout: requestTimeout, retryOptions: {
          attempts: 2, initialDelay: 1, maxDelay: 1, jitter: 1,
          httpStatusCodes: [408, 429, 500, 502, 503, 504],
        } },
        abortSignal: AbortSignal.timeout(requestTimeout),
      },
    });
    const reason = response.candidates?.[0]?.finishReason;
    if (!response.text || response.promptFeedback?.blockReason || (reason && reason !== "STOP")) {
      throw new Error("gemini_incomplete_response");
    }
    const result = schema.parse(JSON.parse(response.text));
    if (extract) {
      const facts = (result as { bill: BillFacts }).bill;
      // Refuse unsupported key facts rather than silently accepting malformed extraction.
      for (const field of ["biller", "amountDue", "currency", "dueDate", "shutoffDate"] as const) {
        if (facts[field] !== null && !facts.evidence.some(item => item.field === field)) throw new Error("gemini_missing_evidence");
      }
      if (!input.document && facts.evidence.some(item => item.source === "document")) throw new Error("gemini_invalid_evidence_source");
      if (facts.evidence.some(item => item.source === "user_description" && !input.details.includes(item.quote))) throw new Error("gemini_invalid_evidence_source");
      for (const statement of facts.statements ?? []) {
        for (const field of ["biller", "amountDue", "overdueAmount", "charges", "payments", "adjustments", "currency", "statementDate", "servicePeriod", "dueDate", "shutoffDate", "collectionsDate"] as const) {
          if (statement[field] !== null && !statement.evidence.some(item => item.field === field)) throw new Error("gemini_missing_evidence");
        }
        const sources = [...statement.evidence, ...statement.contacts, ...statement.terms, ...statement.lineItems];
        if (sources.some(item => item.source === "document" && !input.document)) throw new Error("gemini_invalid_evidence_source");
        if (sources.some(item => item.source === "user_description" && !input.details.includes(item.quote))) throw new Error("gemini_invalid_evidence_source");
        for (const contact of statement.contacts) {
          if (!contact.quote.includes(contact.value)) throw new Error("unsupported_contact_detail");
          if (contact.method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value)) throw new Error("unsupported_contact_detail");
          if (contact.method === "phone" && (!/^[+\d ().-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i.test(contact.value) || contact.value.replace(/\D/g, "").length < 7)) throw new Error("unsupported_contact_detail");
          if (contact.method === "website") {
            let url: URL;
            try { url = new URL(/^https?:\/\//i.test(contact.value) ? contact.value : `https://${contact.value}`); } catch { throw new Error("unsupported_contact_detail"); }
            if (!["https:", "http:"].includes(url.protocol) || !url.hostname.includes(".") || url.username || url.password) throw new Error("unsupported_contact_detail");
          }
        }
      }
      const ids = facts.statements?.map(item => item.id) ?? [];
      if (new Set(ids).size !== ids.length) throw new Error("invalid_fact_reference");
      if (ids.length > 1) { facts.amountDue = null; facts.dueDate = null; facts.shutoffDate = null; }
    }
    return result;
  }
  function finish(input: AssistantInput, bill: BillFacts, response: StructuredResponse, initial = false, researchEvidence = ""): AssistantResult {
    const memory = mergeCase(input.caseState ?? emptyCase(), response.caseUpdates, input, bill);
    const rendered = renderResponse(response, bill, memory, { initial, today: currentDate(input), researchEvidence });
    return { bill, ...rendered, response };
  }
  async function finishWithResearch(input: AssistantInput, bill: BillFacts,
    response: z.infer<typeof routingSchema>, initial = false): Promise<AssistantResult> {
    if (!response.needsPolicyLookup) return finish(input, bill, response, initial);
    if (!response.researchQuery?.trim()) throw new Error("gemini_missing_research_query");
    // Preserve user corrections and selection before research and synthesis.
    const memory = mergeCase(input.caseState ?? emptyCase(), response.caseUpdates, input, bill);
    const selected = selectedStatement(bill, memory);
    const research: WebResearch = await researchWeb({ generate, model: researchModel, timeoutMs: researchTimeoutMs,
      query: response.researchQuery, biller: selected?.biller ?? bill.biller, state: input.state, zipCode: input.zipCode });
    const finalInput = { ...input, document: null, caseState: memory };
    if (research.status !== "grounded") {
      // Fail closed in application code: an instruction alone cannot prevent a
      // model from answering legal/policy questions from memory after search fails.
      const { researchQuery: _query, ...baseResponse } = response;
      const fallback = responseSchema.parse({ ...baseResponse,
        answer: "I couldn’t verify current public sources for that question. I can still help you prepare what to ask.",
        concern: research.status === "unavailable" ? "Web research is temporarily unavailable." : "The lookup returned no usable source-backed evidence.",
        nextStep: { kind: "review_terms", text: "Share an official policy page or contact the department listed on your statement to confirm the current terms and contact details." },
        question: null, draft: null, needsDocument: false, needsPolicyLookup: true, caseUpdates: [],
      });
      return finish(finalInput, bill, fallback, initial);
    }
    const answer = await call(finalInput, researchedSchema, false, bill, researchContext(research) +
      "\nThe public lookup has completed; set needsPolicyLookup=false and needsDocument=false. Preserve the structured response fields and case memory. Put any sourced contact details in answer or nextStep, not in document contact indices. Select at least one sourceIds value matching the numeric id field of the provided sources, not their array positions. Cite the sources even when explaining uncertainty about applicability. Never put web research into caseUpdates.");
    // Validate citations before allowing public contacts through the renderer.
    citeResearch("", answer.sourceIds, research);
    const evidence = research.sources.filter(source => answer.sourceIds.includes(source.id)).flatMap(source => source.excerpts).join("\n");
    const result = finish(finalInput, bill, answer, initial, evidence);
    return { ...result, reply: citeResearch(result.reply, answer.sourceIds, research) };
  }
  const respond = async (input: AssistantInput & { bill: BillFacts }): Promise<AssistantResult> => {
      // Tool/action status is factual application state, not a model guess.
      const statusQuestion = /\b(?:have|did|has)\s+(?:you|MoreTime|the (?:biller|billing office))\b.*\b(?:contact(?:ed)?|email(?:ed)?|call(?:ed)?|sent|send|reply|replied|respond(?:ed)?|negotiate(?:d)?|submit(?:ted)?|schedule(?:d)?)\b|\bwhat have you done\b/i.test(input.question);
      if (statusQuestion) {
        const selected = selectedStatement(input.bill, input.caseState ?? emptyCase());
        return finish(input, input.bill, responseSchema.parse({
          intent: "status", answer: "I can help prepare your next step.", concern: null,
          supportingStatementIds: statementsFor(input.bill).map(item => item.id),
          nextStep: { kind: "prepare_request", text: "Prepare a request for the billing office to review your balance and discuss available arrangements." },
          contact: { statementId: selected?.id ?? null, contactIndex: selected?.contacts.length ? 0 : null, department: "billing" },
          question: null, draft: null, needsDocument: false, needsPolicyLookup: false, caseUpdates: [],
        }));
      }
      // General questions usually need only extracted facts and recent history.
      // Let Gemini request the retained document for details absent from that
      // context instead of reprocessing an entire packet on every chat turn.
      const decision = await call({ ...input, document: null }, routingSchema, false, input.bill,
        `\nThe original document is ${input.document ? "available" : "not available"}.`);
      if (decision.needsDocument && input.document) {
        // Reread through extraction so newly found contacts and facts are saved,
        // not lost after this turn. Stable statement IDs must be retained.
        const rereadInput = { ...input, caseState: mergeCase(input.caseState ?? emptyCase(), decision.caseUpdates, input, input.bill) };
        const result = await call(rereadInput, analysisSchema, true, input.bill,
          "\nAnswer the current question using the original document. Preserve statement IDs from the saved case. Refresh facts/contacts and say when a requested detail is absent.");
        return finishWithResearch(rereadInput, result.bill, {
          ...result.response,
          needsPolicyLookup: result.response.needsPolicyLookup || decision.needsPolicyLookup,
          researchQuery: result.response.researchQuery ?? decision.researchQuery,
        });
      }
      return finishWithResearch(input, input.bill, decision);
  };
  return {
    analyze: async input => { const result = await call(input, analysisSchema, true); return finishWithResearch(input, result.bill, result.response, true); },
    respond,
    answer: async input => (await respond(input)).reply,
  };
}

export function geminiFromEnvironment(env: NodeJS.ProcessEnv): BillEngine | undefined {
  if (!env.GEMINI_API_KEY?.trim()) return undefined;
  return createGeminiEngine({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL,
    chatModel: env.GEMINI_CHAT_MODEL,
    researchModel: env.GEMINI_RESEARCH_MODEL,
    researchTimeoutMs: env.GEMINI_RESEARCH_TIMEOUT_MS?.trim() ? Number(env.GEMINI_RESEARCH_TIMEOUT_MS) : undefined,
    timeoutMs: env.GEMINI_TIMEOUT_MS?.trim() ? Number(env.GEMINI_TIMEOUT_MS) : undefined,
    chatTimeoutMs: env.GEMINI_CHAT_TIMEOUT_MS?.trim() ? Number(env.GEMINI_CHAT_TIMEOUT_MS) : undefined });
}
