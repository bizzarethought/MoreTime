import type { BillFacts } from "../src/gemini.ts";
import type { Statement, StructuredResponse, CaseState } from "../src/case.ts";

export const statement = (changes: Partial<Statement> = {}): Statement => ({
  id: "bill_1", biller: "Example Electric", billType: "utility", documentType: "overdue_notice",
  statementDate: "2026-10-01", servicePeriod: null, amountDue: 180, overdueAmount: null,
  charges: null, payments: null, adjustments: null, currency: "USD", dueDate: "2026-10-20",
  shutoffDate: null, collectionsDate: null, summary: "An overdue electricity bill.",
  evidence: [
    { field: "biller", quote: "Example Electric", page: 1, source: "document" },
    { field: "amountDue", quote: "$180", page: 1, source: "document" },
    { field: "currency", quote: "USD", page: 1, source: "document" },
    { field: "statementDate", quote: "October 1, 2026", page: 1, source: "document" },
    { field: "dueDate", quote: "October 20, 2026", page: 1, source: "document" },
  ], lineItems: [], contacts: [], terms: [], uncertainties: [], ...changes,
});
export const bill = (statements: Statement[] = [statement()]): BillFacts => ({
  biller: "Example Electric", billType: "utility", noticeType: "overdue", amountDue: statements.length === 1 ? statements[0]!.amountDue : null,
  currency: "USD", dueDate: statements.length === 1 ? statements[0]!.dueDate : null, shutoffDate: null,
  summary: "Fictional bill packet.", lineItems: [],
  evidence: [
    { field: "biller", quote: "Example Electric", source: "document" },
    { field: "amountDue", quote: "$180", source: "document" },
    { field: "currency", quote: "USD", source: "document" },
    { field: "dueDate", quote: "October 20, 2026", source: "document" },
  ], uncertainties: [], statements,
});
export const response = (changes: Partial<StructuredResponse> = {}): StructuredResponse => ({
  intent: "payment_plan", answer: "I can help you prepare a manageable payment proposal.", concern: null,
  supportingStatementIds: ["bill_1"],
  nextStep: { kind: "prepare_request", text: "Ask billing about installments and whether the proposed arrangement affects the deadline." },
  contact: { statementId: "bill_1", contactIndex: null, department: "billing" },
  question: { key: "monthly_budget", text: "What monthly amount feels manageable?", statementId: null },
  draft: null, needsDocument: false, needsPolicyLookup: false, caseUpdates: [], ...changes,
});
export const budgetCase = (budget = 30): CaseState => ({ facts: [
  { field: "monthlyBudget", value: budget, quote: `I can afford $${budget} a month`, source: "user_message", statementId: null },
], lastQuestion: null });
