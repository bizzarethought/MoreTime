import { readFileSync } from "node:fs";
const lookup: Record<string, string[]> = JSON.parse(readFileSync(new URL("./reference-data/zcta-states.json", import.meta.url), "utf8"));
const states = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" "));
export function resolveLocation(state: string | null, zipCode: string | null) {
  const explicit = state?.trim().toUpperCase() ?? null;
  const zip = zipCode?.trim() ?? null;
  const candidates = zip && /^\d{5}(-\d{4})?$/.test(zip) ? lookup[zip.slice(0, 5)] ?? [] : [];
  if (explicit && states.has(explicit)) {
    if (candidates.length && !candidates.includes(explicit)) return { state: null, candidates, status: "conflict" as const };
    return { state: explicit, candidates, status: "user_provided" as const };
  }
  if (candidates.length === 1) return { state: candidates[0]!, candidates, status: "zcta_match" as const };
  return { state: null, candidates, status: candidates.length > 1 ? "ambiguous" as const : "unresolved" as const };
}
