# Compintel Root Cutover Runbook

## Scope

Move `compintel.co` root hosting to Connie's VPS while preserving all existing subdomain routes (`api`, `relay`, product subdomains).

## Preconditions

- CI deploy completed successfully on `main`.
- Connie service has:
  - `PUBLIC_ASSET_REGISTRY_PATH`
  - `PRODUCTS_REGISTRY_PATH`
  - `COMPINTEL_SITE_ROOT`
- `$COMPINTEL_SITE_ROOT/index.html` exists and renders expected products.
- `vps-tls-root.yml` executed successfully.

## Cutover Steps

1. Validate local origin on Connie VPS:
   - `curl -fsS http://127.0.0.1:8081/health` (API still healthy)
   - `curl -I https://compintel.co` (root site returns 200 from Connie host)
2. Validate subdomain routes before DNS edits:
   - `curl -fsS https://api.compintel.co/health`
   - `curl -fsS https://relay.compintel.co/health`
3. Update Cloudflare DNS:
   - Apex `compintel.co` A/AAAA to Connie origin
   - `www` CNAME/A to Connie origin (or leave proxied and keep Caddy redirect)
4. Wait for propagation and retest:
   - `curl -I https://compintel.co`
   - `curl -I https://www.compintel.co`
   - `curl -fsS https://api.compintel.co/health`
   - `curl -fsS https://relay.compintel.co/health`
5. Monitor logs for at least 15 minutes after cutover.

## Smoke Test Checklist

- Root site serves generated catalog content.
- Draft + published product sections render.
- `www.compintel.co` redirects to apex.
- Existing published subdomains still resolve.
- API and relay remain healthy.

## Rollback

Trigger rollback if:
- Root site returns sustained 5xx.
- Caddy cannot reload valid config.
- API or relay become unhealthy after root cutover.

Rollback actions:
1. Repoint Cloudflare apex + `www` records to prior origin.
2. Confirm old root site serves traffic.
3. Keep `api`, `relay`, and product subdomain records unchanged.
4. Investigate Connie host Caddy config and catalog generation before retry.
