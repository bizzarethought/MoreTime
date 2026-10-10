import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { assistantErrorCode } from "../src/assistant-error.ts";

test("diagnostic labels discard API messages, model output and arbitrary fields", () => {
  for (const [status, expected] of [[400, "request_rejected"], [401, "api_access_denied"],
    [403, "api_access_denied"], [404, "model_not_found"], [429, "quota_or_rate_limit"],
    [503, "service_unavailable"]] as const) {
    const error = Object.assign(new Error("Private bill and secret key"), { status });
    assert.equal(assistantErrorCode(error), expected);
  }
  const invalid = z.object({ reply: z.string() }).safeParse({ reply: { private: "secret" } });
  assert.equal(assistantErrorCode(invalid.error), "invalid_model_output");
  assert.equal(assistantErrorCode(new SyntaxError("Private JSON")), "invalid_json");
  assert.equal(assistantErrorCode(new DOMException("Private request", "TimeoutError")), "request_timeout");
  assert.equal(assistantErrorCode(new Error("gemini_missing_evidence")), "missing_bill_evidence");
  assert.equal(assistantErrorCode(new Error("Private bill and secret key")), "unknown_error");
  assert.equal(assistantErrorCode({ status: "Private status", name: "Private name" }), "unknown_error");
  assert.equal(assistantErrorCode(null), "unknown_error");
});
