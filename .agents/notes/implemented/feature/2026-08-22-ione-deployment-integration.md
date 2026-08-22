# Agent Note: IONE deployment integration

Status: implemented

English | [中文](2026-08-22-ione-deployment-integration.zh.md)

## Problem

IONE Harness runs behind a Frappe-authenticated reverse proxy, uses a local SearXNG service instead of a commercial search API, and presents settings to remote browsers. The stock browser trust rule makes those settings process-local, the stock search card edits a credentialed provider, and the internal-testing notice is not part of the IONE product experience.

## Decision

`@deepseek-ai/dsh-web-search-searxng` registers the `searxng` provider with `ctx.web`, publishes its `baseURL` through the settings domain, reads the current endpoint for every operation, rejects redirects, and maps only HTTP(S) citations into the portable web result. The Plugins settings page owns an endpoint-only SearXNG card under `web-search-searxng`; it has no API-key or per-request-budget controls.

The browser settings base selects Host persistence for loopback connections and for builds carrying public flag `DSH_CLIENT_IONE_TRUSTED_SETTINGS=1`. That flag is valid only for the IONE deployment where Frappe authentication and the reverse proxy establish the trust boundary; other remote browsers remain in memory mode.

The models settings plugin does not register the versioned internal-testing notice. Its models page and conditional provider onboarding remain independently available.

## Security boundaries

SearXNG requests use `redirect: error`, so a configured origin cannot forward search terms or request headers to another target. The provider accepts only absolute HTTP(S) origins and drops non-HTTP(S) result URLs. The trusted-settings build flag contains no credential and grants no authentication by itself; it only changes client persistence after the deployment has supplied the authenticated proxy boundary.

## Verification

Provider tests cover request construction, response normalization, dynamic settings, failures, disposal, and real HTTP redirect refusal with an untouched redirect target. Client tests pin the trusted-proxy persistence selection, settings-scope propagation, absence of the internal-testing slot, and the endpoint-only SearXNG card.

## Alternatives considered

**Keep the commercial search provider and store its key.** This retains an external credential and does not use the SearXNG service already operated with the deployment.

**Treat every remote browser as trusted.** This weakens the original loopback security boundary for deployments that do not place Harness behind authenticated Frappe routing.

**Dismiss the internal-testing notice through stored acknowledgement.** The notice remains reachable and can reappear when its version changes; removing its slot registration matches the IONE product contract directly.

## Consequences

IONE can configure local search and other Host settings through its authenticated public entry point without browser-local fallbacks or commercial search credentials. Operators must set the trusted-settings flag only in the matching proxy topology, and must keep the SearXNG JSON endpoint reachable from the Harness process.
