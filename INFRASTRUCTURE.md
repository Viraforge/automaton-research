# Infrastructure

Primary deployment and operations stack for Connie.

## Homebase

- Primary domain: `compintel.co`
- Primary API domain: `api.compintel.co`
- Agent interface domain: `connie.compintel.co`

## Deployment Policy

1. Deploy all new public web pages, APIs, and tools to the compintel stack by default.
2. Reuse existing tunnel/routing infrastructure; do not introduce ad-hoc public hosting.
3. Prefer stable reverse-proxy routing over one-off provider CLIs.
4. Keep agent-card service endpoints aligned to live public API routes.
5. If a required endpoint is unavailable, treat it as a blocker and escalate with exact evidence.

## Known Operational Notes

- `connie.compintel.co` root route may require catch-all proxy routing.
- Validate health endpoints before/after each deployment.
- Avoid fallback plans that switch to unrelated hosting providers unless explicitly directed.
