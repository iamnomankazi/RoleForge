# Finland employer catalog

## Method

I loaded the current user-layer `portals.yml` read-only and excluded its 11 tracked employers. Each catalog entry was then checked against its provider's public list endpoint on 2026-10-09, using one serial request per employer and a short pause between requests. No job detail pages or personal data were requested. Finland-location counts use the location fields in the returned list data; a multi-location posting counts when any listed place is in Finland.

The job counts in `portals.finland.example.yml` describe the response used for verification. Workday and SmartRecruiters return pages, so their notes state the first-page count and, when available, the board total. The normal scanner can paginate those supported providers. The Amazon request was narrowed to Finland (`FIN`) and the `software` keyword.

## Verified boards by ATS

| Provider | Employers | Jobs returned in verification responses | Finland-located |
| --- | ---: | ---: | ---: |
| Ashby | 7 | 350 | 142 |
| Greenhouse | 3 | 700 | 10 |
| Lever | 3 | 20 | 10 |
| Teamtailor | 2 | 12 | 10 |
| Workday | 15 | 292 | 52 |
| SmartRecruiters | 8 | 672 | 52 |
| Recruitee | 1 | 1 | 1 |
| Amazon Jobs API | 1 | 2 | 2 |
| **Total** | **40** | **2,049** | **279** |

Some verified employers are international companies with Finland-based teams or Finland-listed roles rather than Finnish-headquartered companies. This includes Mapbox, Tandem Health, EnergyHub/Kapacity.io, AlphaSense, Speechify, Alif Semiconductor, Bosch, Mirantis, Fastmarkets, and several Workday boards. Their notes identify the Finland signal or the fact that the observed first page did not include Finland jobs.

## Attempts that did not yield a usable list

- Several guessed Greenhouse identifiers returned 404: Varjo (`varjo`), IQM (`iqm`), Swappie (`swappie`), Supermetrics (`supermetrics`), Rovio (`rovio`), Fingersoft (`fingersoft`), and Small Giant Games (`smallgiantgames`). Skylo's public Greenhouse page was visible, but both tested API identifiers (`skylotechnologies`, `skylo`) returned 404.
- The guessed Teamtailor feeds for Futurice, Vincit, Solita, Digia, Netlight, Enfuce, Konecranes, and several large employers returned 404. Gofore's feed returned HTTP 200 with no job items. Some companies may use another ATS or a different tenant slug.
- The Metacore Greenhouse endpoint returned HTTP 200 with an empty `jobs` array. It was excluded because it had no usable jobs.
- Repeated SmartRecruiters guesses for Kesko, Nokia, Nordea, and Metso returned valid HTTP responses with zero postings. Guessed Workday paths for Neste, Fortum, Vaisala, and Nokia returned HTTP 422. Konecranes was later verified successfully on SmartRecruiters.
- Yousician's guessed Lever and Ashby endpoints returned 404. Its current board was not identified during this pass.

## Provider gap

The verified set mapped to eight existing RoleForge providers; no provider gap was confirmed from these checks. The main coverage friction is location filtering on large global boards: Workday and SmartRecruiters pages can contain many non-Finland listings before Finland roles appear. Per-tenant Workday location facets could reduce unnecessary pagination, but the facet IDs and values vary by employer.
