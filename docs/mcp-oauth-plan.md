# MCP OAuth: inspection and proposed architecture

Status: architecture approved for local implementation; gateway and tests are in
`mcp-gateway/`. Deployment and production settings remain unapproved/unchanged.
Inspected 2026-11-06. See `mcp-gateway/README.md` for the implementation's limits
and staging/deployment gates.

Implementation refinement: provider storage uses serialized Durable Object
SQLite, not eventually consistent global KV, so authorization-code consumption
and revocation share one consistent state. The maintained provider still owns
the OAuth protocol and cryptography.

## Verified current state

- `backend/src/server.js` protects `/mcp` with a constant-time API-key comparison.
  MCP is stateless Streamable HTTP. There is no OAuth authorization server.
- The public `/mcp` and protected-resource discovery URL return Cloudflare
  browser-login redirects, not usable OAuth challenges.
- The Cloudflare `organizer` self-hosted application protects the entire
  `organizer.calvinwu.com` hostname. Its `only calvin` Allow policy includes
  one email; `hermes mcp` is a separate Service Auth policy for one service
  token. No policy was edited.
- Managed OAuth is off. The application has its own AUD tag. The backend does
  not currently validate Cloudflare JWT assertions.
- Docker publishes the backend on loopback. Production ingress configuration
  is not tracked in this repository; verify the tunnel/reverse-proxy mappings
  before deployment.
- Pushing `main` triggers production deployment in `.github/workflows/deploy.yml`.
  Do not push these changes without deployment approval.

## Native Cloudflare option and its limitation

[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
provides discovery, client registration, browser authentication, and OAuth
tokens without giving Grok a service token. Existing Service Auth policies
can remain.

However, Cloudflare documents opaque OAuth tokens and a signed
`Cf-Access-Jwt-Assertion` at the origin. Its documented application JWT
contains identity, issuer, application audience, and timestamps, but no
granted OAuth scopes. A valid Access JWT must not be relabeled as a scoped
Organizer access token. Native Managed OAuth alone has not been shown to
satisfy the requested scope validation; do not claim that it does.

## Approved local architecture

Keep the client URL `https://organizer.calvinwu.com/mcp`.

1. Use Cloudflare's maintained
   [Workers OAuth Provider](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
   authorization/resource-server components for discovery, authorization code
   with S256 PKCE, client registration, audience-bound tokens, expiry, and
   revocation. Require an explicit `organizer:manage` grant for MCP operations.
2. Keep browser authorization behind Cloudflare Access. Verify its signed JWT
   against the configured team issuer, application AUD, expiry, and the exact
   owner identity before showing consent or issuing a grant. A service
   identity cannot approve user consent.
3. Put a token-validating Worker in front of `/mcp`. Only after validating the
   issuing authorization server, resource, expiry, owner, and granted scope
   may it forward to the original API-key-protected backend through a separate
   Access-protected origin hostname. Keep the backend private.
4. Store the origin API key and a dedicated upstream Cloudflare service token
   in Worker secrets. Never return them to clients or log headers, codes, or
   tokens. Never forward a client's OAuth token to the origin.
5. Preserve Hermes: its existing API key and Cloudflare service headers must
   continue to reach the origin's existing authentication checks. An invalid
   OAuth token must not fall back to a trusted machine identity.
6. Keep interactive Access on the app and browser authorization. Discovery,
   registration, token exchange, and the OAuth-protected `/mcp` ingress need
   narrowly scoped routing outside the interactive-login gate; the Worker
   replaces that gate with OAuth validation, not unauthenticated MCP access.
   The upstream remains behind Access. This security-boundary change needs
   separate deployment approval; do not add a broad domain bypass.

Tradeoff: this preserves strict scoped authorization and avoids client-held
static credentials, but introduces Workers, grant storage, an origin hostname,
and server-side upstream credentials. Simply enabling Managed OAuth would be
smaller, but cannot yet be represented as satisfying scope verification.

## Verified Grok public client requirements

Fetched [Cursor's client metadata](https://cursor.com/oauth/mcp-client.json):

- Client ID: `https://cursor.com/oauth/mcp-client.json`
- Client authentication: `none`; no client secret.
- Grant types: `authorization_code`, `refresh_token`; response type: `code`.
- Published redirect URIs:
  - `https://www.cursor.com/agents/mcp/oauth/callback`
  - `https://www.cursor.com/bot/mcp/oauth/callback`
  - `https://grok.com/connectors-oauth-exchange-code/`
  - `http://localhost:8787/callback`
  - `http://127.0.0.1:8787/callback`

[Cursor staff's correction](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877/16)
also confirms legacy dynamic registration can include
`cursor://anysphere.cursor-mcp/oauth/callback`. Current Cloudflare documentation
allows explicitly listed custom schemes. Do not allow arbitrary redirects,
domain wildcards, or all localhost clients. A published list does not prove
which callback this installed Grok version will select; verify it during staging.

## Implementation and deployment gates

- Local architecture approval is recorded; code and mocked tests are prepared.
- Tests must cover both discovery documents, challenges, exact redirects,
  registration, consent/CSRF, owner-only sign-in, S256 PKCE, one-time codes,
  token issuer/resource/expiry/scope enforcement, revocation, and unchanged
  Hermes access. Tests must not mutate production Organizer data.
- Verify the real Grok flow on staging: discovery, registration, selected
  redirect URI, browser Access login, consent, token exchange, read-only MCP
  handshake/tool listing, refresh, and revocation. Wrong-account sign-in and
  missing/invalid credentials must fail closed.
- Obtain separate approval before provisioning resources, changing Access,
  deploying, or pushing a branch that triggers deployment. Back up the database
  and export the existing Access configuration securely before changes.
- Enter secrets only in server environment files or Cloudflare's secret-entry
  mechanism, never chat. Keep configuration exports and token traces out of Git.
- Roll back by restoring the original Access routing and previous application
  release; preserve the existing Hermes service policy throughout.
