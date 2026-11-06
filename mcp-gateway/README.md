# Organizer MCP OAuth gateway

Local implementation only. Nothing here provisions resources, deploys, or changes
Cloudflare Access. The existing Express MCP implementation is unchanged.

## Grok settings (after approved deployment)

| Setting | Value |
| --- | --- |
| MCP URL | `https://organizer.calvinwu.com/mcp` |
| Authorization | OAuth; no manually supplied authentication headers |
| Public client ID, if requested | `https://cursor.com/oauth/mcp-client.json` |
| Client secret | None (`token_endpoint_auth_method=none`) |
| Flow | Authorization code, S256 PKCE |
| Resource/audience | `https://organizer.calvinwu.com/mcp` |
| Required scope | `organizer:manage` |
| Optional scope | `offline_access` |

Current Grok metadata is supported through Client ID Metadata Documents (CIMD);
legacy clients can dynamically register at `/oauth/register`. No client ID must
be manually generated for either flow. DCR client names are self-asserted, not
proof of Grok's identity; the consent page makes this distinction explicit.

Only the five exact callbacks verified in
[`docs/mcp-oauth-plan.md`](../docs/mcp-oauth-plan.md) can be used. The legacy
`cursor://anysphere.cursor-mcp/oauth/callback` may appear alongside them during
registration, but cannot be selected for authorization. There are no redirect
wildcards, implicit loopback-port exceptions, or arbitrary metadata URL fetches.
If Grok changes its callbacks, first verify the new public metadata or capture
only `client_id` and `redirect_uri` locally, then update the allowlist and tests.
Do not collect authorization codes, state, cookies, or tokens in a support log.

## Local verification

Requires Node 22+ and npm. From this directory:

```powershell
npm ci
$env:WRANGLER_SEND_METRICS = 'false'
npm test
```

`npm test` first performs a **local dry-run bundle**, not a deployment, then runs
Node's assert-based tests in Miniflare/Workers with disposable Durable Object
SQLite and mocked
outbound requests. No Cloudflare login, real secrets, app data, or network
requests to Organizer are used. The suite exercises discovery, registration,
owner sign-in assertions, consent/CSRF, PKCE, code reuse/concurrent redemption,
audience/expiry/scopes, CIMD, refresh/revocation, rate limits, request size
limits, and preservation of Hermes credentials.

`npm run check` performs syntax checking and a local dry-run bundle alone.
Generated files, local state, and environment files are ignored by Git.

Verified locally on 2026-11-06: the dry-run bundle and all 17 gateway tests
pass. Backend syntax checks pass; its 23 existing Google integration tests
cannot run because their shared disposable-database setup fails at Prisma
`db push --skip-generate` with `Schema engine error`. No backend code changed.
These results do not replace the staging acceptance checks below.

## Trust boundaries

- One Worker hosts the maintained OAuth Provider authorization-server and
  resource-server components. A single named Durable Object serializes
  requests and stores provider records in native SQLite, through the provider's
  KV-shaped storage interface. Its issuer and resource are fixed configuration,
  never derived from an incoming Host or forwarded header. No global KV
  namespace or eventually consistent token cache is used.
- Browser `/oauth/authorize` remains behind the existing Access application.
  JOSE verifies the Access assertion's RS256 signature, exact issuer, application
  AUD, required expiry, and exact owner email with a nonempty user subject.
  Service-token identities cannot consent. A direct backend cookie or Access
  JWT does not authorize an MCP call.
- Human consent is required on each sign-in; the provider uses a ten-minute
  browser-bound, single-use handle. POSTs also require the exact same Origin.
  The form shows the actual callback host and warns about local callbacks.
- `organizer:manage` deliberately grants all current MCP tools, including
  deletes. It is not a read-only integration. Tokens lacking that scope get
  `403 insufficient_scope`, including tokens narrowed during refresh.
- Access tokens are opaque, bound to this issuer's dedicated private grant
  storage and the exact MCP resource, and last 15 minutes. Encrypted grant props
  additionally bind the issuing origin and owner. The provider hashes secret
  tokens/codes and encrypts props at rest. Refresh grants last at most seven
  days and refresh tokens rotate.
- Scope/issuer/account changes fail closed on subsequent token checks. Access
  policy changes do **not** continuously re-evaluate already-issued OAuth
  grants: revoke the grant or disable the Worker when removing access.
- All protocol requests and checks reach the same serialized Durable Object,
  so code/consent consumption and revocation do not depend on cross-region KV
  propagation. Expired records are denied immediately and cleaned hourly by a
  native alarm. The tradeoff is one serialization point suitable for this
  single-owner app, not a high-throughput multi-user gateway. An already
  authorized in-flight upstream operation is not retroactively cancelled.
- Only a successful scoped OAuth check injects server-side origin credentials.
  Incoming cookies/assertions/other headers are not relayed upstream. Redirects
  are never followed with credentials; upstream errors are sanitized.
- Hermes takes a separate path: the original bearer key and **both original**
  service-token headers are forwarded, without substituting gateway service
  credentials. The origin's Access policy must validate Hermes's service token.
- OAuth request bodies are capped at 16 KiB and rate limited per source IP.
  MCP bodies retain the backend's 10 MiB ceiling. Proxy calls time out after
  20 seconds; this preserves the existing stateless JSON-response transport,
  not a new long-lived SSE transport.
- Worker observability is disabled, and application code does not log secrets
  or request URLs. Do not enable URL/query logging at another layer for the
  authorization endpoint without redaction.

## Before any deployment: obtain separate approval

The checked-in config has **no Worker routes** and an invalid origin placeholder.
It is intentionally not ready for a production deploy. Its SQLite Durable Object
binding/migration would create remote resources on a real deployment, which
also requires approval.
The owner email, Access team issuer, and browser application AUD were inspected
in the dashboard; these are public configuration, not authentication secrets.

First inspect/export the existing tunnel and reverse-proxy configuration
securely. It is not in this repository. Do not deploy on assumptions about its
path precedence. Back up the app database and existing Access configuration.
Pushing `main` currently triggers the existing app deployment workflow.

### 1. Stage a private origin

With approval, choose a separate origin hostname and create an Access
application protecting it **before exposing its tunnel route**. Allow only
the existing Hermes service token and a new dedicated gateway service token.
Reuse the Hermes policy without widening it or deleting the original policy.
Expose only `/mcp` on this origin; deny `/api/*` and other application routes.
Keep backend port 3000 bound to loopback; use Tunnel or an equivalently private
origin connection, not a public backend port.

Set `ORIGIN_MCP_URL` to that hostname's exact HTTPS `/mcp` URL. The gateway
rejects its own public origin as an upstream to prevent proxy loops.

### 2. Configure staging resources and secrets

Use a separate staging hostname, Access audience/policy, and Worker name
(therefore a separate Durable Object namespace); do not mix staging grants
with production. Copy the config to a
local deployment config and replace the relevant public variables. The
`ACCESS_AUD` is the application protecting the **browser authorization page**,
not the separate service-only origin's audience.

After resource-creation approval, deploy the `OAuthState` SQLite Durable Object
binding/migration with the gateway. Set these secrets through masked
`wrangler secret put NAME --config <approved-config>` prompts, or the
Cloudflare dashboard secret fields:

| Worker secret | Source |
| --- | --- |
| `ORIGIN_API_KEY` | Existing backend `MCP_API_KEY`; must match for Hermes compatibility |
| `ORIGIN_CF_CLIENT_ID` | New dedicated upstream gateway service token |
| `ORIGIN_CF_CLIENT_SECRET` | New dedicated upstream gateway service token |

Never paste secrets into chat, inline shell commands, tracked config, or
frontend variables. Do not rotate the Hermes key/token as part of this rollout.
Do not put secret values in a local deployment config. Keep any local copies
of secrets in the ignored `.dev.vars`, not the example file.

### 3. Add narrowly scoped Worker routes and Access exceptions

Use Worker **Routes**, not an entire-domain custom-domain takeover. Route only:

```text
<public-host>/mcp
<public-host>/.well-known/oauth-protected-resource/mcp
<public-host>/.well-known/oauth-authorization-server
<public-host>/oauth/*
```

Cloudflare Access executes before the Worker. Keep `/oauth/authorize` covered
by the existing interactive owner-only Access application. Keep Managed OAuth
**off**; it would replace the gateway's OAuth challenges.

The following exact paths need more-specific Access applications/policies
that bypass the **interactive browser gate only**, so non-browser clients can
reach the Worker protocol handlers:

```text
/mcp
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/register
/oauth/token
```

This is not an unauthenticated MCP alternative: the Worker enforces tokens,
scopes, and owner identity, and the separate upstream remains behind Access.
Do **not** bypass the entire hostname, `/oauth/*`, or `/api/*`.

Before adding these exceptions, configure the public hostname's tunnel or
reverse-proxy origin to return `404` for these five paths if a request ever
falls through without the Worker. Otherwise detaching a Worker route could
reach the old API-key-only MCP handler after bypassing its Access service gate.
Keep this denial scoped to the public hostname, not the private origin.

Deploy and verify the Worker routes before changing the public exceptions.
With the exceptions still closed, deployment can fail safely with Access
redirects. Verify wildcard/path precedence in staging, especially that
`/oauth/authorize` still requires owner login. Do not cut over production
until these checks pass.

### 4. Staging acceptance

1. With no cookies or headers, fetch both discovery documents: expect `200`,
   the staging issuer/resource, and `code_challenge_methods_supported=["S256"]`.
   An unauthenticated POST to `/mcp` must return `401` with the resource metadata
   URL and `scope="organizer:manage"`, never a browser `302`.
2. Add the staging MCP URL to Grok without headers or a client secret. Verify
   CIMD or DCR registration, the exact selected callback, browser Access login
   as the owner, the consent page, code exchange, and tool listing. Do not
   approve writes while verifying the connection.
3. Check a private browser with no session prompts for Access login. Sign in
   with an unauthorized account: Access or the gateway must deny it. Browser
   cookies alone must not authorize `/mcp`.
4. Verify rejected callbacks, missing/wrong PKCE, unknown/expired tokens,
   wrong-audience tokens, missing scopes, and revocation. Revoke using the
   advertised token/revocation endpoint; never paste test tokens into chat or
   include them in a URL.
5. Verify refresh after 15 minutes and reconnect after grant expiry. Account
   grants are shared across all Bots on that Grok account.
6. Run Hermes's normal read-only initialization and `tools/list`/`get_board`
   with its **unchanged** three headers. Wrong service-token credentials or
   a missing header must fail. Do not use the existing mutating
   `backend/scripts/check-mcp.js` against production for this check.
7. Temporarily detach the staging Worker route: the public origin must deny
   all five exception paths. Restore it and confirm OAuth still works.
8. Verify no direct-origin request without valid service credentials can
   access MCP, and that its other application paths are denied.

The real Grok connection and Cloudflare policy/routing checks remain pending;
mocked tests cannot establish them.

### 5. Production and rollback

Ask again before the production resource/policy changes or deployment. Repeat
the staging sequence with the production config and endpoint, preserving the
existing app and Hermes policies. No database migration or backend code
deployment is needed for this gateway.

To roll back, **first remove the five interactive-gate exceptions** so the
original full-host Access protection applies. Then remove the Worker routes
and the public-origin fallback denials to restore the original MCP path.
Keep the original app/Hermes service policy untouched. Revoke gateway grants
and its dedicated service token, and remove staging resources only with
separate deletion approval.
