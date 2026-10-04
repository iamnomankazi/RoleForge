# RoleForge Security

## Reporting a Vulnerability

RoleForge is a private, local-first workspace maintained by `iamnomankazi`.

Report security concerns to the repository owner through an existing private
channel. If GitHub private vulnerability reporting is available for this
repository, use it. Do not publish vulnerabilities or include credentials,
CVs, application data, or raw browser captures in issues or reports.

Include sanitized details:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

## Scope

Security issues in the following are in scope:

- **Scripts** (`*.mjs`) — command injection, path traversal, SSRF
- **Dashboard** (`dashboard/`) — any Go binary vulnerabilities
- **Templates** (`templates/`) — XSS in generated HTML/PDF
- **Configuration** — secrets exposure, unsafe defaults

## Out of Scope

- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the user's machine
- Social engineering attacks
- RoleForge does not operate a hosted service

## Handling

Review and fixes are handled privately by the repository owner. No response-time,
release, or public-disclosure commitment is implied. See
[DATA_CONTRACT.md](../DATA_CONTRACT.md) for the boundary between system files and
private user data.
