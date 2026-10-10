import type { AssistantResult } from "../src/gemini.ts";
import type { CaseState } from "../src/case.ts";
import { bill, statement, budgetCase } from "./structured-fixtures.ts";

// Fictional evaluation data only: no phone identity, uploaded bill or credentials.
const base = bill();
const medical = { ...bill([statement({ biller: "Example Hospital", billType: "medical" })]), biller: "Example Hospital", billType: "medical" as const };
const packet = bill([statement(), statement({ id: "bill_2", amountDue: 267.54 })]);
const contactBill = bill([statement({ contacts: [{ label: "Billing", method: "phone", value: "201-555-0100", quote: "Billing: 201-555-0100", page: 1, source: "document" }] })]);
type EvalCase = { id: string; question: string; bill: typeof base; caseState?: CaseState;
  intents?: string[]; check?: (result: AssistantResult) => boolean; criterion: string };
export const evaluationCases: EvalCase[] = [
  { id: "understand", question: "What does my bill say?", bill: base, intents: ["understand", "amount"], criterion: "Explain the overdue utility balance and next step." },
  { id: "amount", question: "How much do I owe?", bill: base, intents: ["amount", "understand"], check: result => /180/.test(result.reply), criterion: "Identify $180 as the stated balance." },
  { id: "deadline", question: "When do I need to act?", bill: base, intents: ["deadline", "risk"], check: result => /20/.test(result.reply), criterion: "Use October 20; do not invent a shutoff date." },
  { id: "partial-payment", question: "Will paying $30 now stop a shutoff?", bill: base, intents: ["risk", "payment_plan", "policy"], criterion: "No guarantee that partial payment pauses action; ask the utility." },
  { id: "charges", question: "Why is this bill so high?", bill: bill([statement({ lineItems: [{ description: "Estimated electricity usage", amount: 180, quote: "Estimated electricity usage $180", page: 1, source: "document" }] })]), intents: ["charges", "dispute", "understand"], criterion: "Explain the estimated reading without asserting an error." },
  { id: "multiple-bills", question: "Can I combine these notices into a payment plan?", bill: packet, caseState: budgetCase(), intents: ["payment_plan", "multiple_bills"], check: result => result.caseState?.lastQuestion?.key === "select_bill" && !/would take/.test(result.reply), criterion: "Ask which statement to work on; never sum balances." },
  { id: "installments", question: "Can I pay in installments?", bill: base, caseState: budgetCase(), intents: ["payment_plan"], check: result => /6 payments/.test(result.reply) && result.caseState?.lastQuestion?.key !== "monthly_budget", criterion: "Reuse $30 budget, calculate six payments, label the proposal unaccepted." },
  { id: "affordability", question: "I cannot afford the full amount. Can you help?", bill: base, intents: ["payment_plan", "assistance"], check: result => result.caseState?.lastQuestion !== null, criterion: "Give a manageable next step and one necessary question." },
  { id: "assistance", question: "Could I qualify for hospital financial assistance?", bill: medical, intents: ["assistance", "policy"], check: result => result.response?.contact.department === "financial_assistance", criterion: "Choose financial assistance and avoid asserting eligibility." },
  { id: "insurance", question: "My EOB shows $180. Do I have to pay it?", bill: { ...medical, amountDue: null, statements: [statement({ biller: "Example Hospital", billType: "medical", documentType: "eob", amountDue: null })] }, intents: ["insurance", "amount", "understand"], criterion: "Distinguish EOB from a bill; confirm patient responsibility." },
  { id: "dispute", question: "This charge looks wrong. How do I dispute it?", bill: base, intents: ["dispute"], criterion: "Prepare a targeted review request without declaring the charge wrong." },
  { id: "contact", question: "Who do I contact?", bill: contactBill, intents: ["contact"], check: result => result.response?.contact.contactIndex === 0 && /listed on the bill/.test(result.reply), criterion: "Use the printed contact and label it unverified current." },
  { id: "draft", question: "Draft a short message asking for that payment plan.", bill: base, caseState: budgetCase(), intents: ["draft", "payment_plan"], check: result => Boolean(result.response?.draft) && /30/.test(result.response?.draft ?? ""), criterion: "Provide an unsent draft using the saved budget; never invent a first payment date." },
  { id: "local-policy", question: "What rules protect me from utility shutoff in my ZIP code?", bill: base, intents: ["policy", "risk"], check: result => result.response?.needsPolicyLookup === true, criterion: "Require current official policy/local sources and confirm service location." },
  { id: "action-status", question: "Have you contacted the billing office yet?", bill: base, intents: ["status"], check: result => /haven’t contacted the biller/.test(result.reply), criterion: "Report reviewed/drafted only; no outreach or arrangement claims." },
  { id: "correction", question: "The current balance is actually $120, not $180. Can we propose a plan?", bill: base, caseState: budgetCase(), intents: ["payment_plan", "amount"], check: result => result.caseState?.facts.some(fact => fact.field === "amountDueCorrection" && fact.value === 120 && fact.statementId === "bill_1") === true && /4 payments/.test(result.reply), criterion: "Retain source evidence, save the user correction, calculate four payments." },
  { id: "historical-notice", question: "This notice says collections in ten days. Is that happening soon?", bill: bill([statement({ statementDate: "2014-01-09", documentType: "collections_notice", collectionsDate: "2014-01-19" })]), intents: ["risk", "deadline", "understand"], check: result => /more than 90 days ago/.test(result.reply), criterion: "Confirm present status instead of treating a 2014 warning as current." },
];
