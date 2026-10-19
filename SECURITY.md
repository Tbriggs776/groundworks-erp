# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report
a vulnerability** on this repository. Don't open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We
aim to acknowledge reports within 2 business days and to share a fix plan
within 10.

## Scope

- The Groundworks web app, REST API (`/api/v1`), and MCP server (`/api/mcp`)
- Authentication, sessions, API keys, and tenant isolation (workspaces and
  companies)

Out of scope: denial of service by volume, social engineering, and issues
in third-party services (report those to the vendor).

## How we handle security

See [docs/compliance/soc2.md](docs/compliance/soc2.md) for the controls
built into the product and the ones the operating company owns.
