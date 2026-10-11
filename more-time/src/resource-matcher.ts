import { readFileSync } from "node:fs";
import { resolveLocation } from "./location.ts";
import type { AssistantInput, BillFacts } from "./gemini.ts";
import { selectedStatement } from "./case.ts";
export interface AssistanceResource { id: string; state: string | null; billTypes: string[]; title: string; url: string; facts: string[]; applicability: string; missing: string[]; verifiedAt: string; effectiveDate: string | null }
export const resources: AssistanceResource[] = JSON.parse(readFileSync(new URL("./reference-data/resources.json", import.meta.url), "utf8"));
export function matchResources(input: AssistantInput, bill?: BillFacts) {
  // A later free-text location correction must be resolved before reusing intake geography.
  const correction = input.caseState?.facts.findLast(fact => fact.field === "serviceLocation");
  const corrected = typeof correction?.value === "string" ? correction.value.trim() : "";
  const location = correction
    ? resolveLocation(/^[a-z]{2}$/i.test(corrected) ? corrected : null, /^\d{5}(-\d{4})?$/.test(corrected) ? corrected : null)
    : resolveLocation(input.state, input.zipCode);
  const selected = bill ? selectedStatement(bill, input.caseState ?? { facts: [], lastQuestion: null }) : undefined;
  const type = selected?.billType ?? (bill?.statements && bill.statements.length > 1 ? "unknown" : bill?.billType);
  const today = input.currentDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const matched = resources.filter(resource => (!type || resource.billTypes.includes(type)) &&
    (!resource.state || resource.state === location.state) && resource.verifiedAt <= today && (Date.parse(today) - Date.parse(resource.verifiedAt)) <= 90 * 86400000);
  return { location, resources: matched.sort((a, b) => Number(Boolean(b.state)) - Number(Boolean(a.state))) };
}
export function resourceEvidence(input: AssistantInput, bill: BillFacts, ids: string[]) {
  const matched = matchResources(input, bill).resources;
  const unique = [...new Set(ids)];
  if (unique.some(id => !matched.some(resource => resource.id === id))) throw new Error("invalid_resource_reference");
  return matched.filter(resource => unique.includes(resource.id));
}
export function citeResources(selected: AssistanceResource[]) {
  return selected.length ? "\n\nOfficial assistance resources (curated snapshot):\n" + selected.map(resource =>
    `${resource.title} (verified ${resource.verifiedAt}): ${resource.url}`).join("\n") : "";
}
