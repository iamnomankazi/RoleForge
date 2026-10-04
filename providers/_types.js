// Type catalog for the provider plugin contract.
//
// This file is documentation-only — pure JSDoc @typedef annotations. The
// project is plain ESM JavaScript with no build step; provider authors can
// reference these types via `/** @typedef {import('./_types.js').Provider} Provider */`
// at the top of a `// @ts-check`-enabled file to get IDE hints. The runtime
// contract is enforced by scan.mjs (id presence, fetch is a function, fetch
// returns an array), not by these annotations.
//
// Files prefixed with _ are never loaded as providers by scan.mjs.

/**
 * Normalized job posting — the unit of currency throughout the scanner.
 *
 * @typedef {object} Job
 * @property {string} title    Required, non-empty after trim.
 * @property {string} url      Required, absolute URL — used as the dedup key.
 * @property {string} company  May be empty when the source can't expose it
 *                             at the list-page level; populated downstream.
 * @property {string} location May be empty.
 * @property {string} [description] Job description text, populated ONLY when the
 *                               provider's list payload carries it for free (no
 *                               extra per-job request — the scanner is zero-token).
 *                               Lever supplies it via `descriptionPlain`; most
 *                               providers omit it. Consumed by scan.mjs's
 *                               content_filter; an empty/absent value always
 *                               passes the filter.
 * @property {number} [postedAt] Epoch ms when the posting was published.
 *                               Omitted when the source doesn't expose a
 *                               usable date. scan.mjs ignores it; consumers
 *                               like scan-ats-full.mjs use it for recency
 *                               filtering.
 * @property {number} [trustScore] 0-100 trust score from _trust-validator.mjs.
 * @property {string[]} [trustFlags] Flags raised by trust validation (e.g.
 *                                   'invalid_url', 'suspicious_domain').
 * @property {'high'|'medium'|'low'} [trustLevel] Classification derived from
 *                                                 trustScore.
 * @property {string} [sourceId] Stable source identifier when the provider exposes one.
 * @property {string} [sourceQuery] Primary query that discovered the job.
 * @property {string[]} [sourceQueries] All queries that discovered the job.
 * @property {string} [sourceUrl] Provider-owned source/provenance URL when it
 *                               differs from the selected job/careers URL.
 */

/**
 * Result returned by the trust validator for a single job posting.
 *
 * @typedef {object} TrustResult
 * @property {number} score       0-100, where 100 = fully trusted.
 * @property {string[]} flags     Flags raised (e.g. 'invalid_url', 'suspicious_domain').
 * @property {'high'|'medium'|'low'} level  Classification: 90-100 high, 60-89 medium, 0-59 low.
 */

/**
 * A single `tracked_companies` entry from `portals.yml`.
 *
 * Provider-specific fields are generally opaque to scan.mjs. The shared
 * Workday and VDAB option blocks have bounded framework validation; providers
 * still own their request behavior.
 *
 * @typedef {object} PortalEntry
 * @property {string}             name             User-facing label; appears in logs and placeholders.
 * @property {boolean}            [enabled]        Default: true.
 * @property {string}             [careers_url]    Public listing URL; consumed by detect().
 * @property {string}             [api]            JSON API URL; used directly by greenhouse/ashby providers.
 * @property {string[]}           [fallback_urls]  Ordered provider-specific fallback board URLs.
 * @property {string}             [provider]       Explicit provider id — bypasses detect().
 * @property {('http')}           [transport]      Default: 'http'. Reserved for future transports.
 * @property {number}             [max_pages]      Provider-specific pagination cap (avature, workday).
 * @property {number}             [max_jobs]       Provider-specific raw-job cap (for example, Himalayas browse).
 * @property {(string|{query?: string, q?: string, sort?: string, country?: string|string[], seniority?: string|string[], employment_type?: string|string[]})[]} [search_queries]
 *                                                 Provider-specific targeted retrieval queries. Himalayas accepts
 *                                                 structured q/sort/country/seniority/employment-type filters while
 *                                                 keeping downstream Career-Ops filtering authoritative.
 * @property {number}             [search_max_pages] Provider-specific targeted-search page cap.
 * @property {number}             [search_max_jobs] Provider-specific targeted raw-job cap.
 * @property {string}             [offset_param]   avature only: pins the pagination query key and disables the
 *                                                 provider's jobOffset→offset self-heal. Rarely needed — an
 *                                                 escape hatch for a tenant the auto-switch can't resolve.
 * @property {string|number}       [consider_board] Consider board identifier. Required by the Consider provider;
 *                                                  tenant board ids are opaque and must come from the board owner.
 * @property {number}               [consider_size] Consider result-size cap (provider clamps to its hard maximum).
 * @property {{board_id?: (string|number), boardId?: (string|number), size?: number}} [consider]
 *                                                  Optional nested Consider configuration (legacy aliases).
 * @property {string|number}       [getro_collection] Getro collection identifier. When omitted, the provider
 *                                                    resolves it from the careers page's public __NEXT_DATA__.
 * @property {string|number}       [collection_id]   Generic/Getro collection id alias.
 * @property {{collection_id?: (string|number), collection?: (string|number)}} [getro]
 *                                                    Optional nested Getro collection aliases.
 * @property {number}               [getro_max_pages] Getro pagination cap (provider clamps to its hard maximum).
 * @property {number}               [getro_max_age_days] Getro recency window; zero disables age filtering.
 * @property {{queries: string[], max_hits?: number, max_pages?: number, max_jobs?: number}} [wttj]
 *                                                    Welcome to the Jungle Algolia search configuration. At least
 *                                                    one explicit raw query is required; downstream title/location
 *                                                    filters remain authoritative.
 * @property {'EN'|'ES'|string}      [lang]           getManfred feed language (defaults to EN; ES is also supported).
 * @property {string}                [domain]         Eightfold optional brand/domain scope; never inferred from a company name.
 * @property {string}                [siteNumber]     Oracle Recruiting Cloud Candidate Experience site segment override.
 * @property {string|number}         [locationId]     Oracle Recruiting Cloud location facet override.
 * @property {string}                [company_eid]    Jobvite opaque companyEId for the current XML jobs feed.
 * @property {VdabConfig}            [vdab]           VDAB public board search configuration.
 * @property {WorkdayConfig}         [workday]        Workday detail and explicit facet configuration.
 */

/**
 * Provider-specific VDAB configuration. Runtime bounds are days 1-1000, size
 * 1-100, and detailLimit 1-100.
 *
 * @typedef {object} VdabConfig
 * @property {string[]} [keywords] Explicit unique search terms; absence allows profile-role fallback.
 * @property {number}   [days] Posting age window, default 30.
 * @property {number}   [size] Results per request, default 100.
 * @property {boolean} [fetchDetails] Opt in to detail-page requests, default false.
 * @property {number}   [detailLimit] Maximum detail-page requests, default 25.
 */

/**
 * Optional per-tenant Workday controls. Facet names and values are opaque IDs
 * copied explicitly from the tenant's Workday board; omitted facets means no
 * API facets are sent. Runtime detailLimit defaults to 20 and accepts 0-100.
 *
 * @typedef {object} WorkdayConfig
 * @property {Record<string, string[]>} [appliedFacets] Up to 20 facet names with 1-50 explicit string IDs each (each <=200 characters).
 * @property {number} [detailLimit] Maximum detail lookups, default 20; 0 disables them; maximum 100.
 */

/**
 * A top-level Interamt search entry. Interamt is invoked by a standalone
 * command and is not a provider-registry entry.
 *
 * @typedef {object} InteramtSearch
 * @property {string} was Search phrase sent to Interamt.
 */

/**
 * Top-level Interamt settings in portals.yml. Relevance filters remain owned
 * by the normal scanner configuration.
 *
 * @typedef {object} InteramtConfig
 * @property {InteramtSearch[]} [interamt_searches] Up to 20 unique, trimmed searches.
 * @property {object} [interamt] Bounded standalone scanner controls.
 * @property {number} [interamt.max_load_more] Maximum pagination actions, 0-50 (default 10).
 * @property {number} [interamt.page_timeout_ms] Page navigation timeout, 1-60000 (default 15000).
 * @property {number} [interamt.wait_timeout_ms] Results wait timeout, 1-30000 (default 10000).
 */

/**
 * Returned by `detect()` when a provider claims an entry. `url` is
 * informational (used in logs); routing only checks for a non-null return.
 *
 * @typedef {object} DetectHit
 * @property {string} url
 */

/**
 * Options forwarded to the underlying `fetch` call.
 *
 * @typedef {object} FetchOptions
 * @property {number}                [timeoutMs]
 * @property {Object<string,string>} [headers]
 * @property {string}                [method]
 * @property {(string|null)}         [body]
 * @property {('error'|'follow'|'manual')} [redirect]
 */

/**
 * What scan.mjs hands to provider.fetch(). For Phase A only `transport: 'http'`
 * is implemented; the shape reserves room for future transports without
 * breaking the contract.
 *
 * @typedef {object} Context
 * @property {('http')} transport
 * @property {(url: string, opts?: FetchOptions) => Promise<string>}  fetchText
 * @property {(url: string, opts?: FetchOptions) => Promise<unknown>} fetchJson
 * @property {number} [maxPages] Optional pagination hint. When set (verify-portals.mjs's
 *                              health probe passes 1), a paginating provider SHOULD stop
 *                              after this many pages — the probe only needs the first page
 *                              to tell a live board from a broken one, and must not walk an
 *                              entire careers site. Providers that ignore it stay correct:
 *                              the probe caps their requests defensively via the context's
 *                              own fetch functions.
 * @property {(ms: number) => Promise<void>} [sleep] Optional cross-provider pacing hook used by
 *                              paginating providers (avature, workday) to throttle between page
 *                              requests. May be absent — providers fall back to a native
 *                              `setTimeout`-based delay.
 */

/**
 * The provider contract — the default export of every providers/*.mjs file
 * (excluding _-prefixed shared helpers).
 *
 * @typedef {object} Provider
 * @property {string} id                                                       Unique across all loaded providers.
 * @property {((entry: PortalEntry) => (DetectHit | null))} [detect]           Optional auto-detection.
 * @property {(entry: PortalEntry, ctx: Context) => Promise<Job[]>} fetch      Required. Providers may attach
 *                                                                             non-enumerable structured coverage
 *                                                                             metadata with _result.mjs.
 * @property {(job: Job, ctx: Context) => Promise<void|Job>} [enrichDate]      Optional detail-page enrichment;
 *                                                                             mutates date/location on the supplied job.
 */

export {};
