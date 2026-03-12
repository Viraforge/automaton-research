# Compintel Asset Publication Design

**Date:** 2026-03-12

**Status:** Approved

**Goal:** Ensure Connie publishes distribution assets only on approved `*.compintel.co` subdomains and records those published assets in a repo-backed registry that the `compintel.co` UI can render.

## Problem

Connie is still surfacing temporary Cloudflare quick-tunnel URLs such as `*.trycloudflare.com` in runtime output. That violates the repo's operating model, which already treats `compintel.co` as the primary public surface for shipped services and assets.

The current gap is in the publication flow:

- `publish_service` is already restricted to `compintel.co`
- `expose_port` still accepts raw `conway.exposePort()` output too easily
- there is no stable public asset registry for the `compintel.co` UI to consume

This means Connie can treat a temporary tunnel URL as "good enough" and there is no durable source of truth for which public assets should appear in the UI.

## Requirements

### Functional

- In sovereign mode, public distribution assets must end up on `*.compintel.co`
- Temporary public URLs like `*.trycloudflare.com` must never be treated as final public asset URLs
- Successful public publication must create or update a durable asset record
- The `compintel.co` UI must be able to list published assets from that durable record set

### Behavioral

- `expose_port` should treat non-`compintel.co` public URLs as intermediate or invalid, not as completion
- If Cloudflare publication is possible, Connie should promote the service to a `compintel.co` subdomain
- If Cloudflare publication is not possible, Connie should return an explicit blocker with evidence
- Public-proof validation should only count approved public asset URLs

### Operational

- Asset records must be auditable in git
- The UI contract should be stable across Connie restarts
- The design should minimize new runtime dependencies

## Chosen Approach

Use a **strict `compintel.co` publication path** plus a **repo-backed public asset registry**.

### Why this approach

- It matches the existing governance and operational docs
- It makes the approved public surface unambiguous
- It avoids coupling the `compintel.co` UI to Connie's live runtime DB
- It gives the UI a simple, cacheable, auditable source of truth

## Architecture

### 1. Publication gate

`expose_port` will stop treating a returned public URL as acceptable merely because it is public.

Instead, in sovereign mode:

- if the returned URL is already on `*.compintel.co`, it may be accepted
- if the returned URL is temporary or on any unapproved domain, the tool must attempt managed publication on `compintel.co`
- if managed publication cannot complete, the tool must fail with an explicit blocker rather than returning the temporary URL as the public answer

This shifts `expose_port` from "return whatever Conway gave me" to "return only approved public publication state."

### 2. Public asset registry

Add a repo-backed registry file that records assets approved for display on the `compintel.co` UI.

Recommended location:

- `docs/public-assets.json`

Each record should include:

- `id`
- `title`
- `description`
- `category`
- `status`
- `url`
- `subdomain`
- `healthcheckPath`
- `port`
- `projectId` or equivalent linkage when available
- `publishedAt`
- `updatedAt`
- optional tags and UI metadata

Only successful `compintel.co` publications should be written to this registry.

### 3. UI contract

The `compintel.co` UI should render from the registry file, not from raw runtime logs or temporary URLs.

That means:

- tunnel URLs never appear in the UI
- unpublished assets stay out of the catalog
- published `*.compintel.co` assets become the canonical distribution list

This repo may not contain the `compintel.co` UI implementation itself, so the contract must be explicit and stable enough for an external consumer.

### 4. Completion and governance rules

Public distribution work should only count as complete when it references approved public URLs, not localhost or temporary tunnel endpoints.

This implies tightening:

- public completion evidence checks
- loop/governor messages when Connie keeps reporting temporary tunnel URLs as successful publication

## Data Flow

1. Connie starts or exposes a local service
2. `expose_port` receives the raw Conway URL
3. If sovereign mode is enabled and the URL is not on `*.compintel.co`, the tool attempts managed publication
4. `publish_service` provisions DNS and proxy routing on `compintel.co`
5. On success, the publication writes or updates the registry entry
6. The `compintel.co` UI reads the registry and lists the asset

## Error Handling

### Managed publication unavailable

Return a blocker such as:

- temporary public URL is not an approved surface
- managed publication requires Cloudflare credentials or a fresh DNS/proxy verification step

Do not treat the temporary URL as public success.

### Registry write failure

Publication should still report the service as published only if the system can clearly state that publication succeeded but catalog registration failed. This must be visible and testable.

### Duplicate asset publication

Registry updates should be idempotent by stable asset key, preferably based on subdomain or asset id.

## Testing Strategy

- Add regression tests for `expose_port` when `conway.exposePort()` returns `*.trycloudflare.com`
- Add tests that verify sovereign mode promotes unapproved public URLs to `*.compintel.co`
- Add tests that verify a blocker is returned instead of leaking the temporary URL when publication fails
- Add tests for registry upsert behavior
- Add tests that public-proof validation rejects non-`compintel.co` URLs

## Non-Goals

- Building the entire `compintel.co` UI in this repo
- Supporting arbitrary third-party public domains
- Treating temporary tunnels as a valid fallback for public distribution assets

## Key Assumption

The `compintel.co` UI can read a repo-backed registry artifact from this repository or from a deployment artifact built from it. If the UI lives in another repository, this design still provides the source-of-truth contract needed for integration.
