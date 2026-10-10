// Large document schemas can exceed Gemini's constrained-decoding complexity.
// Preserve the complete shape, required keys, types and enums at generation
// time. Length/range/pattern limits are still enforced by Zod after generation.
const runtimeConstraints = new Set(["minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "multipleOf", "$schema"]);
export function compactModelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactModelSchema);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !runtimeConstraints.has(key)).map(([key, item]) => [key, compactModelSchema(item)]));
  }
  return value;
}
