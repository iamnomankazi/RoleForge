# Workday wd1 first-page instance probe - 2026-10-09

Completed: 2026-10-09T01:10:08.220Z.

Twenty catalog boards currently returning wd1 HTTP 422 were checked against the existing discovery instance list. Only two returned a valid nonempty first page elsewhere: `ioaging|wd1|ioa` on wd12 (50 total jobs) and `nbtbancorp|wd1|nbt-b` on wd12 (77 total jobs). Both correct wd12 coordinates are already present in the public catalog alongside the failing wd1 duplicates. The sample did not establish the requested "several boards" condition (interpreted as three or more), so no Workday retry was added and its pagination was left unchanged.

The catalog contains 12,884 Workday entries, including 8,841 wd1 entries. Of those, 6,055 have an instance label (such as `wd3`) in the tenant field. For example, `wd103|wd1|yougov_external_careers` constructs `wd103.wd1.myworkdayjobs.com`; changing the instance cannot restore the missing real tenant. These counts suggest a large catalog coordinate defect, not a general wrong-instance explanation. This is an inference from the current catalog; the production failure log was unavailable.

## Method and limits

Catalog: [job-board-aggregator Workday data](https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/workday_companies.json). The requested `output/production-20261005/` and `data/cache/ats-companies` were absent in this worktree.

Selection: first screen 100 boards (four observed failures, then evenly spaced unique wd1 tenants with one site per tenant, then catalog-order unique tenants), yielding 13 current 422s. Add seven entries with an instance label in the tenant field, covering the dominant coordinate defect. This is a diagnostic sample, not a random estimate of production failure rates.

Requests: 243 first-page POSTs across 107 baseline screens and 20 failing boards; serial, with a 250 ms gap and an 8 s timeout. Body: `{limit:20, offset:0, searchText:'', appliedFacets:{}}`. Browser headers, origin, and referer match the provider. Redirects refused; no pagination, detail requests, transport retries, or user-data/cache writes. Stop alternate probing on a valid nonempty page. Initial exploratory screening also made 28 baseline requests.

Final baseline statuses: 200: 80, 403: 4, 404: 3, 422: 20. Successful control boards included `2020companies|wd1|external_careers` and `advisorgroup|wd1|career_profile`.

The instance list was copied exactly from `discover-ats.mjs`: wd1, wd2, wd3, wd5, wd10, wd12, wd101, wd103. `ENOTFOUND` means DNS lookup failed, not an HTTP result. HTTP 422 bodies reported `errorCode: HTTP_422`. No alternate returned a successful empty list. Instances after a nonempty success were not probed. Other instances and site/tenant corrections were outside this investigation.

## Outcomes

| Tenant | Site | wd1 | wd2 | wd3 | wd5 | wd10 | wd12 | wd101 | wd103 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21cf | domestic | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| 8451llc | external8451 | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| activision | ss_external | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| adfinc | external_idf | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| forestlawn | forest_lawn | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| highpoint | highpoint-faculty | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| htlf | citywide-banks | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| ioaging | ioa | 422 | ENOTFOUND | 422 | 422 | 422 | 200 (20 rows; total 50) | not probed | not probed |
| kings | rivercatscareers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| lmiaerospace | lmi_careers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| nbtbancorp | nbt-b | 422 | ENOTFOUND | 422 | 422 | 422 | 200 (20 rows; total 77) | not probed | not probed |
| ufpi | ufpi | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd501 | wth | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd102 | publicservicecareers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd103 | yougov_external_careers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd105 | zap | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd107 | tp-icap | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd108 | xtiumcareers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd10 | yee_hong | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
| wd115 | valleyhealthcareers | 422 | ENOTFOUND | 422 | 422 | 422 | 422 | ENOTFOUND | 422 |
