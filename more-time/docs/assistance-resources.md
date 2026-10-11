# Curated assistance evidence

The backend resolves location and matches official assistance resources before Gemini generates a response. No extra API key or runtime network request is required for these records. Existing Google Search research still handles current provider contacts, policies and legal protections.

## Geography

`src/reference-data/zcta-states.json` contains 33,791 Census 2020 ZCTAs mapped to all intersecting states using county FIPS codes from https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt (downloaded 2026-10-11). This is a Census ZIP-area approximation, not a current USPS ZIP validation service. PO-box/new ZIPs may be absent. Unknown, conflicting and multi-state mappings do not select state resources. ZIP+4 uses its first five digits. Later saved service-location corrections disable the intake mapping pending clarification.

## Coverage and maintenance

`src/reference-data/resources.json` initially covers New Jersey energy assistance and Charity Care, plus national hospital financial-assistance guidance and the federal LIHEAP assistance finder. Other states use national navigation plus existing live research. Rent and unknown bill types receive no curated match. Multiple statements require a selected statement before matching.

Each record contains supported paraphrased facts, source URL, verification date, applicability and missing eligibility information. A null effectiveDate means no effective date was established; it is not the verification date. Records older than 90 days or newer than the case date are excluded. To expand coverage, verify an official source, add its supported facts and applicability, and set the actual verification date. Never copy income limits or enrollment dates without their effective period.

Model citations are validated against the matched records. The backend appends official URLs and snapshot dates. Assistance responses also get the top matching navigation link if the model omits a citation; this link does not support uncited model claims. Eligibility, protections, enrollment and payment holds are not established by a resource match. Missing bill/provider/location information must be confirmed.

Demo: ZIP 07102 + electricity bill selects NJ utility assistance; ZIP 07102 + hospital bill selects NJ Charity Care and IRS guidance; ZIP 90210 + electricity bill selects national LIHEAP navigation. Run npm run typecheck and npm test from the repository root.
