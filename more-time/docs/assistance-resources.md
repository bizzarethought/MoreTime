# Curated resource matching and grounded generation

The backend resolves location and matches official assistance resources before Gemini generates a response. No extra API key or runtime network request is required for these records. Existing Google Search research still handles current provider contacts, policies and legal protections.

## Architecture

This is a curated knowledge layer with deterministic resource matching and grounded generation, rather than a document RAG pipeline. No documents are indexed or chunked, and there is no embedding store or semantic retrieval.

The code path is:

1. `src/location.ts` resolves an explicit state or ZIP through the bundled Census mapping. Conflicting and multi-state results remain unresolved.
2. `src/resource-matcher.ts` filters `src/reference-data/resources.json` by resolved state, selected bill type and snapshot age. National resources remain available when a state has no curated record.
3. `src/gemini.ts` adds matched records, applicability and missing eligibility information to model context. During initial extraction the bill type is not yet known, so location-matched candidate records are supplied; returned IDs are validated against the extracted bill before rendering.
4. Gemini returns `resourceIds` for records used. The backend rejects IDs outside the matched set and checks contact details against supplied evidence. These checks do not prove every free-text claim is supported.
5. The backend renders the explanation, next step, contact guidance and optional question, then appends official resource URLs and verification dates. Existing installment calculations still run in code.

The existing Gemini Google Search path remains separate and supplies current public evidence when requested. Curated snapshots do not establish current provider policy, enrollment status, legal protections or qualification.

## Geography

`src/reference-data/zcta-states.json` contains 33,791 Census 2020 ZCTAs mapped to all intersecting states using county FIPS codes from https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt (downloaded 2026-10-11). This is a Census ZIP-area approximation, not a current USPS ZIP validation service. PO-box/new ZIPs may be absent. Unknown, conflicting and multi-state mappings do not select state resources. ZIP+4 uses its first five digits. Later saved service-location corrections replace the intake mapping when they are an exact two-letter state abbreviation or ZIP. Other free-text corrections disable the intake mapping pending clarification. Assistance responses with unresolved locations get an application-generated question asking for the service or hospital state. Public research receives the resolved state, without forwarding the intake ZIP.

## Coverage and maintenance

`src/reference-data/resources.json` initially covers New Jersey energy assistance and Charity Care, plus national hospital financial-assistance guidance and the federal LIHEAP assistance finder. Other states use national navigation plus existing live research. Rent and unknown bill types receive no curated match. Multiple statements require a selected statement before matching.

Each record contains supported paraphrased facts, source URL, verification date, applicability and missing eligibility information. A null effectiveDate means no effective date was established; it is not the verification date. Records older than 90 days or newer than the case date are excluded. To expand coverage, verify an official source, add its supported facts and applicability, and set the actual verification date. Never copy income limits or enrollment dates without their effective period.

Model citations are validated against the matched records. The backend appends official URLs and snapshot dates. Assistance responses also get the top matching navigation link if the model omits a citation; this link does not support uncited model claims. Eligibility, protections, enrollment and payment holds are not established by a resource match. Missing bill/provider/location information must be confirmed.

Demo: ZIP 07102 + electricity bill selects NJ utility assistance; ZIP 07102 + hospital bill selects NJ Charity Care and IRS guidance; ZIP 90210 + electricity bill selects national LIHEAP navigation. Run npm run typecheck and npm test from the repository root.

## Validation performed

On October 11, 2026, TypeScript checks and all 113 automated tests passed (109 backend tests and four launcher tests). New tests cover leading-zero ZIPs, ZIP+4, unknown/conflicting/ambiguous mappings, bill-type and state selection, national fallback, snapshot expiry, service-location corrections, invalid resource references, source rendering and location clarification.

Three live Gemini smoke checks using fictional data also passed: New Jersey electricity assistance with extraction, New Jersey hospital assistance, and California electricity assistance using the national fallback. Responses included the expected official links and October 11 snapshot dates. The prompts explicitly directed the model to use supplied official resources; these were guided integration checks, not a benchmark of ordinary user questions. No iMessage delivery was tested as part of these checks.
