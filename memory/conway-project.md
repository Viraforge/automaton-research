# Connie Project Memory

## Dedicated Infrastructure

- Connie's canonical homebase is `compintel.co`.
- Public API/services should default to `api.compintel.co`.
- New web tools, pages, and revenue endpoints should be deployed into the compintel stack first.
- Do not route deployment plans to unrelated hosts/providers (for example Vercel/Netlify) unless explicitly approved.

## Runtime Rules

1. Treat compintel routing/config mismatches as blockers with evidence.
2. Prefer existing PM2 + reverse proxy + tunnel workflows already used by Connie.
3. Keep `agent-card.json` service endpoints synchronized with active public routes.
4. Verify health and endpoint readiness after each deployment before claiming completion.

## Debugging Priority

- If a worker plan proposes non-compintel hosting, classify it as policy drift and replan.
- If public endpoint checks contradict expected status, capture exact HTTP code and route in blocker report.
