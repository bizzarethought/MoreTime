import { z } from "zod";

// Only return fixed labels. SDK error messages and validation issues can contain
// API keys, document text, or private model output and must never reach logs.
export function assistantErrorCode(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 401 || status === 403) return "api_access_denied";
  if (status === 404) return "model_not_found";
  if (status === 429) return "quota_or_rate_limit";
  if (status === 400) return "request_rejected";
  if (typeof status === "number" && status >= 500 && status <= 599) return "service_unavailable";
  if (error instanceof z.ZodError) return "invalid_model_output";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "request_timeout";
    switch (error.message) {
      case "gemini_missing_research_query": return "missing_research_query";
      case "gemini_invalid_research_source":
      case "gemini_missing_research_source": return "invalid_research_source";
      case "gemini_missing_evidence": return "missing_bill_evidence";
      case "gemini_invalid_evidence_source": return "invalid_evidence_source";
      case "gemini_incomplete_response": return "incomplete_model_response";
      case "unsupported_document":
      case "invalid_document": return "unsupported_document";
      case "invalid_case_update": return "invalid_case_update";
      case "invalid_fact_reference": return "invalid_fact_reference";
      case "invalid_contact_reference":
      case "unsupported_contact_detail": return "unsupported_contact_detail";
      case "unsupported_action_claim": return "unsupported_action_claim";
    }
  }
  return "unknown_error";
}
