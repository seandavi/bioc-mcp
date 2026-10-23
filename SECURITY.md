# Security policy

## Scope

bioc-mcp is a public, read-only server over public data. It has no accounts and no writes, and one
secret: a GitHub token with no repository permissions.

In scope:

- anything that lets a caller reach non-public data or hosts (SSRF);
- making the Worker fetch caller-chosen URLs;
- leaking the token;
- bypassing the rate limit at scale;
- getting the server to return non-public data.

Out of scope:

- volumetric denial of service;
- findings in upstream services (report those to their owners);
- wrong or stale answers (use the
  [wrong answer issue form](https://github.com/seandavi/bioc-mcp/issues/new?template=wrong-answer.yml)).

## Reporting a vulnerability

Report privately at <https://github.com/seandavi/bioc-mcp/security/advisories/new>. Do not open a
public issue. Expect an acknowledgement within a week.

## Supported version

Only what is deployed from `main`.
