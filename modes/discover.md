# Workflow reference: ATS board discovery

Run the standalone resolver when you want to check which companies in a list
have public, scanner-readable job boards. Use `node discover-ats.mjs --in companies.yml`
or pass company names as arguments. The command checks Greenhouse, Ashby, Lever,
then the supported long-tail providers in order. A
result is resolved only when the matching provider returns a valid, nonempty
job list; empty, malformed, redirected, or uncertain results stay visible for
manual follow-up.

Workday needs an exact HTTPS board URL or explicit `{tenant, site}` coordinates.
The resolver checks at most eight common Workday instances when the user leaves
`instance` out. An invalid explicit instance is an error and never triggers that
fallback.

The default output is preview-only. `portals.yml` contains user data, so add
`--write` only when the user explicitly wants confirmed entries appended. The
write path validates the existing YAML, removes name and board aliases already
configured, preserves the file's formatting, and writes atomically. Review the
unresolved list instead of inventing a board URL or slug.
