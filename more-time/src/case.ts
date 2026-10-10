import { z } from "zod";
import type { BillFacts } from "./gemini.ts";

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const money = z.number().finite().nonnegative().max(1_000_000_000).nullable();
const evidenceFields = ["biller", "amountDue", "overdueAmount", "charges", "payments", "adjustments", "currency", "statementDate", "dueDate", "shutoffDate", "collectionsDate", "servicePeriod"] as const;
export const statementSchema = z.object({
  id: z.string().regex(/^bill_\d{1,2}$/),
  biller: z.string().max(300).nullable(),
  billType: z.enum(["utility", "medical", "rent", "other", "unknown"]),
  documentType: z.enum(["statement", "invoice", "eob", "overdue_notice", "shutoff_notice", "collections_notice", "other"]),
  statementDate: calendarDate.nullable(), servicePeriod: z.string().max(100).nullable(),
  amountDue: money, overdueAmount: money, charges: money, payments: money,
  adjustments: z.number().finite().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  dueDate: calendarDate.nullable(), shutoffDate: calendarDate.nullable(), collectionsDate: calendarDate.nullable(),
  summary: z.string().max(800),
  lineItems: z.array(z.object({ description: z.string().min(1).max(200), amount: z.number().finite().nullable(),
    quote: z.string().min(1).max(400), page: z.number().int().min(1).max(1000).nullable(),
    source: z.enum(["document", "user_description"]),
  }).strict()).max(20),
  evidence: z.array(z.object({
    field: z.enum(evidenceFields), quote: z.string().min(1).max(400),
    page: z.number().int().min(1).max(1000).nullable(),
    source: z.enum(["document", "user_description"]),
  }).strict()).max(20),
  contacts: z.array(z.object({
    label: z.string().min(1).max(100), method: z.enum(["phone", "email", "website"]),
    value: z.string().min(1).max(200), quote: z.string().min(1).max(400),
    page: z.number().int().min(1).max(1000).nullable(), source: z.enum(["document", "user_description"]),
  }).strict()).max(5),
  terms: z.array(z.object({ text: z.string().min(1).max(300), quote: z.string().min(1).max(400),
    page: z.number().int().min(1).max(1000).nullable(), source: z.enum(["document", "user_description"]),
  }).strict()).max(8),
  uncertainties: z.array(z.string().max(300)).max(8),
}).strict();
export type Statement = z.infer<typeof statementSchema>;

const memoryFields = ["goal", "monthlyBudget", "firstPaymentDate", "selectedStatementId", "amountDueCorrection", "dueDateCorrection", "shutoffDateCorrection", "collectionsDateCorrection", "serviceLocation", "previousContact", "reportedAgreement", "confirmedAmount", "confirmedDeadline"] as const;
export const caseFactSchema = z.object({
  field: z.enum(memoryFields), value: z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
  quote: z.string().min(1).max(500), source: z.enum(["user_message", "user_description"]),
  statementId: z.string().max(30).nullable(),
}).strict();
const questionSchema = z.object({
  key: z.enum(["monthly_budget", "first_payment_date", "select_bill", "confirm_amount", "confirm_deadline", "current_status", "eligibility", "missing_information"]),
  text: z.string().min(1).max(250), statementId: z.string().max(30).nullable(),
}).strict();
export const caseStateSchema = z.object({ facts: z.array(caseFactSchema).max(108), lastQuestion: questionSchema.nullable() }).strict();
export type CaseState = z.infer<typeof caseStateSchema>;
export const emptyCase = (): CaseState => ({ facts: [], lastQuestion: null });
export const caseForNewDocument = (state: CaseState): CaseState => ({
  facts: state.facts.filter(fact => fact.statementId === null && !["selectedStatementId", "previousContact", "reportedAgreement"].includes(fact.field)), lastQuestion: null,
});

export const responseSchema = z.object({
  intent: z.enum(["understand", "amount", "deadline", "risk", "charges", "multiple_bills", "payment_plan", "assistance", "insurance", "dispute", "contact", "policy", "status", "draft"]),
  answer: z.string().min(1).max(700), concern: z.string().max(250).nullable(),
  supportingStatementIds: z.array(z.string().max(30)).max(12),
  nextStep: z.object({ kind: z.enum(["prepare_request", "contact_biller", "clarify_bill", "confirm_status", "review_terms", "provide_information"]), text: z.string().min(1).max(350) }).strict(),
  contact: z.object({ statementId: z.string().max(30).nullable(), contactIndex: z.number().int().min(0).max(4).nullable(),
    department: z.enum(["billing", "financial_assistance", "insurance", "property_manager", "collections"]) }).strict(),
  question: questionSchema.nullable(), draft: z.string().min(1).max(1000).nullable(),
  needsDocument: z.boolean(), needsPolicyLookup: z.boolean(),
  caseUpdates: z.array(caseFactSchema).max(11),
}).strict();
export type StructuredResponse = z.infer<typeof responseSchema>;

export function statementsFor(bill: BillFacts): Statement[] {
  if (bill.statements?.length) return bill.statements;
  // Existing saved cases remain usable; rereading is requested only for new details.
  return [{ id: "bill_1", biller: bill.biller, billType: bill.billType, documentType: "statement",
    statementDate: null, servicePeriod: null, amountDue: bill.amountDue, overdueAmount: null, charges: null,
    payments: null, adjustments: null, currency: bill.currency, dueDate: bill.dueDate, shutoffDate: bill.shutoffDate,
    collectionsDate: null, summary: bill.summary, lineItems: [], contacts: [], terms: [], uncertainties: bill.uncertainties,
    evidence: bill.evidence.filter(item => ["biller", "amountDue", "currency", "dueDate", "shutoffDate"].includes(item.field))
      .map(item => ({ ...item, field: item.field as typeof evidenceFields[number], page: null })),
  }];
}

export function remembered(state: CaseState, field: typeof memoryFields[number], statementId?: string): CaseState["facts"][number] | undefined {
  return state.facts.find(fact => fact.field === field && (!statementId || fact.statementId === statementId));
}

export function mergeCase(state: CaseState, updates: StructuredResponse["caseUpdates"], input: { question: string; details: string }, bill: BillFacts): CaseState {
  const next = caseStateSchema.parse(state);
  const ids = statementsFor(bill).map(item => item.id);
  for (const patch of updates) {
    // Budget, goal and service location belong to the person/case. Normalize a
    // valid statement reference the model attached to one of these global facts.
    const global = ["goal", "monthlyBudget", "firstPaymentDate", "selectedStatementId", "serviceLocation"].includes(patch.field);
    const update = global ? { ...patch, statementId: null } : patch;
    const source = update.source === "user_message" ? input.question : input.details;
    // Ignore unsupported memory patches, without discarding a valid reply or
    // erasing remembered facts. Models sometimes restate an earlier turn here.
    if (!source.includes(update.quote) || (patch.statementId && !ids.includes(patch.statementId))) continue;
    const scoped = ["amountDueCorrection", "dueDateCorrection", "shutoffDateCorrection", "collectionsDateCorrection", "confirmedAmount", "confirmedDeadline"].includes(update.field);
    if (scoped && (!update.statementId || !ids.includes(update.statementId))) continue;
    const index = next.facts.findIndex(fact => fact.field === update.field && fact.statementId === update.statementId);
    if (update.source === "user_description" && index >= 0 && next.facts[index]!.source === "user_message") continue;
    const value = update.value;
    if (value !== null) {
      if (["monthlyBudget", "amountDueCorrection"].includes(update.field)) {
        const numbers = update.quote.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
        if (typeof value !== "number" || value < 0 || value > 1_000_000_000 || !numbers.some(item => Number(item) === value)) continue;
      } else if (["confirmedAmount", "confirmedDeadline"].includes(update.field)) {
        const key = update.field === "confirmedAmount" ? "confirm_amount" : "confirm_deadline";
        if (typeof value !== "boolean" || value !== true || update.source !== "user_message" || state.lastQuestion?.key !== key || state.lastQuestion.statementId !== update.statementId) continue;
      } else {
        if (typeof value !== "string") continue;
        if (["firstPaymentDate", "dueDateCorrection", "shutoffDateCorrection", "collectionsDateCorrection"].includes(update.field) && !calendarDate.safeParse(value).success) continue;
        if (update.field === "selectedStatementId" && !ids.includes(value)) continue;
      }
    }
    if (index >= 0) next.facts[index] = update; else next.facts.push(update);
  }
  return caseStateSchema.parse(next);
}

export function effectiveStatements(bill: BillFacts, state: CaseState): Statement[] {
  return statementsFor(bill).map(item => {
    const amount = remembered(state, "amountDueCorrection", item.id);
    const due = remembered(state, "dueDateCorrection", item.id);
    const shutoff = remembered(state, "shutoffDateCorrection", item.id);
    const collections = remembered(state, "collectionsDateCorrection", item.id);
    return { ...item,
      amountDue: amount ? amount.value as number | null : item.amountDue,
      dueDate: due ? due.value as string | null : item.dueDate,
      shutoffDate: shutoff ? shutoff.value as string | null : item.shutoffDate,
      collectionsDate: collections ? collections.value as string | null : item.collectionsDate,
    };
  });
}

export function selectedStatement(bill: BillFacts, state: CaseState): Statement | undefined {
  const statements = effectiveStatements(bill, state);
  const selected = remembered(state, "selectedStatementId")?.value;
  return statements.find(item => item.id === selected) ?? (statements.length === 1 ? statements[0] : undefined);
}

export function assessUrgency(bill: BillFacts, state: CaseState, today: string) {
  return effectiveStatements(bill, state).map(statement => {
    // A historical statement does not prove that a threatened action is current.
    const historical = statement.statementDate !== null && Date.parse(today) - Date.parse(statement.statementDate) > 90 * 86400000;
    const deadlines = [statement.shutoffDate, statement.collectionsDate].filter((date): date is string => date !== null);
    const imminent = !historical && deadlines.some(date => Date.parse(date) >= Date.parse(today) && Date.parse(date) - Date.parse(today) <= 3 * 86400000);
    const past = deadlines.some(date => date < today);
    return { statementId: statement.id, level: historical ? "verify_historical" : imminent ? "urgent" : past ? "verify_status" : "routine", deadlines };
  });
}

function containsUnsupportedContact(text: string, bill: BillFacts, researchEvidence = "") {
  const contacts: { method: string; value: string }[] = statementsFor(bill).flatMap(item => item.contacts);
  // Only cited, attributed web passages can authorize additional contact values.
  for (const value of researchEvidence.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) contacts.push({ method: "email", value });
  for (const value of researchEvidence.match(/(?:\+\d[\d ()-]{7,}\d|\(\d{3}\)[\d -]{6,}\d|\b\d{3}[- .]\d{3}[- .]\d{4}\b|\b\d{10,15}\b)/g) ?? []) contacts.push({ method: "phone", value });
  const webWithoutEmails = researchEvidence.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "");
  for (const value of webWithoutEmails.match(/(?:https?:\/\/|www\.)[^\s)]+|\b[A-Z0-9][A-Z0-9.-]*\.[A-Z]{2,}(?:\/[^\s)]*)?/gi) ?? []) contacts.push({ method: "website", value });
  const addresses = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const phones = (text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "").match(/(?:\+\d[\d ()-]{7,}\d|\(\d{3}\)[\d -]{6,}\d|\b\d{3}[- .]\d{3}[- .]\d{4}\b|\b\d{10,15}\b)/g) ?? []);
  const withoutEmails = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "");
  const urls = withoutEmails.match(/(?:https?:\/\/|www\.)[^\s)]+|\b[A-Z0-9][A-Z0-9.-]*\.[A-Z]{2,}(?:\/[^\s)]*)?/gi) ?? [];
  const normalizedUrl = (value: string) => value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[.,;]+$/, "").replace(/\/$/, "");
  return addresses.some(value => !contacts.some(contact => contact.method === "email" && contact.value.toLowerCase() === value.toLowerCase()))
    || phones.some(value => !contacts.some(contact => contact.method === "phone" && contact.value.replace(/\D/g, "") === value.replace(/\D/g, "")))
    || urls.some(value => !contacts.some(contact => contact.method === "website" && normalizedUrl(contact.value) === normalizedUrl(value)));
}

export function validateResponse(response: StructuredResponse, bill: BillFacts, researchEvidence = "") {
  const statements = statementsFor(bill);
  const ids = statements.map(item => item.id);
  if (response.supportingStatementIds.some(id => !ids.includes(id)) || (response.question?.statementId && !ids.includes(response.question.statementId))) throw new Error("invalid_fact_reference");
  const target = statements.find(item => item.id === response.contact.statementId);
  if (response.contact.statementId && !target) throw new Error("invalid_fact_reference");
  if (response.contact.contactIndex !== null && !target?.contacts[response.contact.contactIndex]) throw new Error("invalid_contact_reference");
  const text = [response.answer, response.concern, response.nextStep.text, response.question?.text, response.draft].filter(Boolean).join("\n");
  if (containsUnsupportedContact(text, bill, researchEvidence)) throw new Error("unsupported_contact_detail");
  // Drafts are explicitly rendered as text for the user to send. Action claims
  // elsewhere cannot be backed by tools because outreach is not implemented.
  if (/\b(?:I|we|MoreTime)\s+(?:have\s+|already\s+)?(?:sent|emailed|called|contacted|negotiated|submitted|scheduled|secured)\b|\b(?:I|we)\s+will\s+(?:email|call|contact|send|negotiate|submit|schedule)\b|\b(?:I|we)[’']ll\s+(?:email|call|contact|send|negotiate|submit|schedule)\b|\b(?:your\s+)?(?:extension|payment plan|hold)\s+(?:is|has been)\s+(?:approved|confirmed|secured)\b/i.test([response.answer, response.concern, response.nextStep.text].join(" "))) throw new Error("unsupported_action_claim");
}

export function renderResponse(response: StructuredResponse, bill: BillFacts, state: CaseState, options: { initial?: boolean; today: string; researchEvidence?: string }): { reply: string; caseState: CaseState } {
  validateResponse(response, bill, options.researchEvidence);
  const selected = selectedStatement(bill, state);
  const needsSelection = !selected && statementsFor(bill).length > 1 && ["payment_plan", "draft", "dispute"].includes(response.intent);
  const separateAmounts = !selected && statementsFor(bill).length > 1 && response.intent === "amount";
  const target = statementsFor(bill).find(item => item.id === response.contact.statementId) ?? selected;
  const contact = target?.contacts[response.contact.contactIndex ?? -1];
  const departments = { billing: "billing office", financial_assistance: "financial assistance team", insurance: "insurer’s member services team", property_manager: "property manager", collections: "collections contact listed on the notice" };
  const department = response.contact.department === "billing" && target?.billType === "utility" ? "billing/customer assistance team" : departments[response.contact.department];
  const contactText = options.researchEvidence
    ? `Who to contact: ${target?.biller ?? bill.biller ?? "your biller"}’s ${department}. Refer to the sourced guidance above and the contact listed on your statement.`
    : contact
    ? `Who to contact: ${contact.label} — ${contact.value} (${contact.source === "document" ? "listed on the bill" : "provided by you"}; current details still need verification).`
    : `Who to contact: ${response.contact.department === "insurance" ? "your insurer’s member services team" : `${target?.biller ?? bill.biller ?? "your biller"}’s ${department}`}. Use the contact details on your statement or their official website; I haven’t verified a current number or email yet.`;
  const urgency = assessUrgency(bill, state, options.today);
  const relevant = selected ? urgency.filter(item => item.statementId === selected.id) : urgency;
  const urgent = relevant.some(item => item.level === "urgent");
  const historical = relevant.some(item => item.level === "verify_historical");
  const parts: string[] = [];
  if (urgent) parts.push("The notice lists an action deadline within three days. Contact the biller today to confirm its status and ask about available arrangements; a request does not pause that deadline.");
  else if (historical) parts.push("These statements are dated more than 90 days ago. Let’s confirm the current balance and notice status before treating an old warning as an upcoming deadline.");
  if (response.intent === "status") parts.push("I’ve reviewed the information you shared and can help prepare your next step. I haven’t contacted the biller, sent an email, or secured an arrangement.");
  else if (separateAmounts) parts.push("Here are the balances we have for each statement:\n" + effectiveStatements(bill, state).map((item, index) =>
    `${index + 1}. ${item.biller ?? "Unknown biller"}: ${item.amountDue === null ? "balance unclear" : `${item.currency ?? "Amount"} ${item.amountDue.toFixed(2)} (${remembered(state, "amountDueCorrection", item.id) ? "user-reported" : "shown on the statement"})`}`
  ).join("\n") + "\nThese notices may overlap; I haven’t added their balances together.");
  else parts.push((options.initial ? "I can help you work through this. " : "") + (needsSelection
    ? "I can help you work through these notices. First, let’s confirm which statements show separate balances and which may be repeated reminders."
    : response.answer));
  if (response.concern && !needsSelection && !separateAmounts) parts.push(response.concern);
  if (["payment_plan", "draft"].includes(response.intent) && selected?.documentType !== "eob" && selected?.amountDue !== null && selected?.amountDue !== undefined) {
    const budget = remembered(state, "monthlyBudget")?.value;
    if (typeof budget === "number" && Math.round(budget * 100) > 0) {
      const count = Math.ceil(Math.round(selected.amountDue * 100) / Math.round(budget * 100));
      if (count > 0) parts.push(`At ${budget.toFixed(2)} ${selected.currency ?? "currency units"} per month, the ${selected.amountDue.toFixed(2)} balance would take ${count} payments, before fees or new charges. The biller needs to accept the proposal.`);
    }
  }
  parts.push(`Next step: ${needsSelection || separateAmounts ? "Ask billing for the current balance on each statement and whether any notices overlap before proposing an arrangement." : response.nextStep.text}`,
    needsSelection || separateAmounts ? "Who to contact: the billing office listed on each statement. Current contact details still need verification." : contactText);
  if (!options.researchEvidence && (response.needsPolicyLookup || response.intent === "policy")) parts.push("Current company terms and local protections still need an official source. I can help prepare the question to ask; I can’t confirm eligibility or protections from the bill alone.");
  if (response.draft && !needsSelection && !separateAmounts) parts.push(`Draft you can send:\n${response.draft}`);
  let question = response.question;
  const known = { monthly_budget: "monthlyBudget", first_payment_date: "firstPaymentDate", select_bill: "selectedStatementId", confirm_amount: "confirmedAmount", confirm_deadline: "confirmedDeadline" } as const;
  if (question && question.key in known) {
    const field = known[question.key as keyof typeof known];
    if (remembered(state, field, ["confirmedAmount", "confirmedDeadline"].includes(field) ? question.statementId ?? undefined : undefined)?.value !== null
      && remembered(state, field, ["confirmedAmount", "confirmedDeadline"].includes(field) ? question.statementId ?? undefined : undefined) !== undefined) question = null;
  }
  if (question && /^(?:would you like|do you want) (?:me )?to (?:draft|prepare|write|ask|help|look into)\b/i.test(question.text)) question = null;
  if (separateAmounts && question?.key === "select_bill") question = null;
  if (needsSelection) {
    question = { key: "select_bill", text: "Which statement should we work on first?", statementId: null };
    parts.push("The packet contains separate statements; I haven’t added their balances together.");
  }
  if (question) parts.push(question.text);
  // Stable IDs are internal references, never account numbers in user drafts.
  const reply = parts.join("\n\n")
    .replace(/\baccount\s+bill_\d{1,2}\b/gi, "account [your account reference]")
    .replace(/\bbill_(\d{1,2})\b/g, "statement $1");
  return { reply, caseState: { facts: state.facts, lastQuestion: question } };
}
