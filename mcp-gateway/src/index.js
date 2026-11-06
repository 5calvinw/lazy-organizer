import { timingSafeEqual } from 'node:crypto'
import { DurableObject } from 'cloudflare:workers'
import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  insufficientScope,
} from '@cloudflare/workers-oauth-provider'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const scope = 'organizer:manage'
const clientMetadataUrl = 'https://cursor.com/oauth/mcp-client.json'
const redirects = new Set([
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'https://www.cursor.com/bot/mcp/oauth/callback',
  'https://grok.com/connectors-oauth-exchange-code/',
  'http://localhost:8787/callback',
  'http://127.0.0.1:8787/callback',
])
const legacyRedirect = 'cursor://anysphere.cursor-mcp/oauth/callback'
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
const json = (error, status, headers = {}) => Response.json({ error }, {
  status, headers: { 'Cache-Control': 'no-store', ...headers },
})
const equal = (left, right) => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function origin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error('Expected an HTTPS origin')
  }
  return url.origin
}

async function limitedBody(request, maximum) {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maximum) {
      await reader.cancel()
      throw new RangeError('Request too large')
    }
    chunks.push(value)
  }
  return new Blob(chunks)
}

function consentPage(details, handle) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Authorize Organizer</title>
<h1>Allow ${escape(details.clientName)} to manage Organizer?</h1>
<p>${details.clientDomain ? `Client domain: ${escape(details.clientDomain)}.` : 'Self-registered client; its name is not verified.'}</p>
<p>Callback: <strong>${escape(details.redirectHost)}</strong></p>
${details.redirectIsLoopback ? '<p>Only continue if you just started this connection on your computer.</p>' : ''}
<p><strong>${scope}</strong>: read, create, edit, and delete all tasks, calendar entries, and notebooks.</p>
<p>This connection is available to every Bot on your Grok account. Consent lasts at most seven days.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow full Organizer access</button>
<button name="decision" value="deny">Deny</button></form></html>`
}

function createGateway(env) {
  const publicOrigin = origin(env.PUBLIC_ORIGIN)
  const accessIssuer = origin(env.ACCESS_ISSUER)
  if (!new URL(accessIssuer).hostname.endsWith('.cloudflareaccess.com')) throw new Error('Invalid Access issuer')
  const upstream = new URL(env.ORIGIN_MCP_URL)
  if (upstream.protocol !== 'https:' || upstream.origin === publicOrigin || upstream.pathname !== '/mcp'
    || upstream.search || upstream.hash || upstream.username || upstream.password
    || upstream.hostname.endsWith('.invalid')) throw new Error('Configure a separate protected origin')
  for (const key of ['ACCESS_AUD', 'OWNER_EMAIL', 'ORIGIN_API_KEY', 'ORIGIN_CF_CLIENT_ID', 'ORIGIN_CF_CLIENT_SECRET']) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error('Incomplete gateway configuration')
  }
  if (!env.OAUTH_KV || !env.AUTH_RATE_LIMITER) throw new Error('Missing gateway bindings')
  const resource = `${publicOrigin}/mcp`
  const jwks = createRemoteJWKSet(new URL(`${accessIssuer}/cdn-cgi/access/certs`))
  const owner = (props) => props?.email === env.OWNER_EMAIL && typeof props?.sub === 'string' && props.sub.length > 0
  const authorization = new OAuthAuthorizationServer({
    issuer: publicOrigin,
    resources: [resource],
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [scope, 'offline_access'],
    accessTokenTTL: 900,
    refreshTokenTTL: 604800,
    clientRegistrationTTL: 604800,
    // Legacy Cursor entries may be registered, but only the exact HTTPS/loopback callbacks above may be used.
    clientRegistrationCallback({ clientMetadata: metadata }) {
      if (!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length
        || !metadata.redirect_uris.every((uri) => redirects.has(uri) || uri === legacyRedirect)
        || metadata.token_endpoint_auth_method !== 'none') {
        return { description: 'Only the documented Grok public-client callbacks are supported' }
      }
    },
    tokenExchangeCallback({ props, resource: target }) {
      if (!owner(props) || props.issuer !== publicOrigin || target !== resource) {
        throw new OAuthError('invalid_grant', { description: 'Authorization is no longer valid' })
      }
    },
    onError: ({ code, status, headers }) => json(code, status, headers),
  })

  async function proxy(request, legacy = false) {
    const headers = new Headers()
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name))
    }
    headers.set('Authorization', legacy ? request.headers.get('authorization') : `Bearer ${env.ORIGIN_API_KEY}`)
    headers.set('CF-Access-Client-Id', legacy ? request.headers.get('cf-access-client-id') : env.ORIGIN_CF_CLIENT_ID)
    headers.set('CF-Access-Client-Secret', legacy ? request.headers.get('cf-access-client-secret') : env.ORIGIN_CF_CLIENT_SECRET)
    try {
      const response = await fetch(upstream.href, {
        method: request.method, headers,
        body: await limitedBody(request, 10 * 1024 * 1024),
        redirect: 'manual', signal: AbortSignal.timeout(20000),
      })
      // Never follow an Access login redirect with the server-side credentials.
      if ((response.status >= 300 && response.status < 400) || response.status >= 500
        || (!legacy && [401, 403].includes(response.status))) return json('upstream_unavailable', 502)
      const safe = new Headers({ 'Cache-Control': 'no-store' })
      for (const name of ['content-type', 'mcp-session-id', 'www-authenticate', 'allow', 'retry-after']) {
        if (response.headers.has(name)) safe.set(name, response.headers.get(name))
      }
      return new Response(response.body, { status: response.status, headers: safe })
    } catch (error) {
      return json(error instanceof RangeError ? 'request_too_large' : 'upstream_unavailable',
        error instanceof RangeError ? 413 : 502)
    }
  }

  const protectedResource = new OAuthResourceServer({
    resourceMetadata: { resource, authorization_servers: [publicOrigin], resource_name: 'Organizer' },
    requiredScopes: [scope],
    validateToken: () => async (target, token) => {
      const validated = await authorization.validateToken(target, token, env)
      // Opaque tokens belong to this issuer's private storage, not arbitrary JWT issuers.
      return validated && owner(validated.props) && validated.props.issuer === publicOrigin
        && validated.userId === validated.props.sub ? validated : null
    },
    handler: { async fetch(request, _env, ctx) {
      if (!ctx.auth.scope.includes(scope)) return insufficientScope(ctx.auth, [scope])
      return proxy(request)
    } },
  })

  async function authorize(request) {
    const assertion = request.headers.get('cf-access-jwt-assertion')
    if (!assertion) return json('access_sign_in_required', 401)
    let identity
    try {
      const { payload } = await jwtVerify(assertion, jwks, {
        issuer: accessIssuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'],
      })
      if (payload.type !== 'app' || !owner(payload) || payload.common_name) return json('access_denied', 403)
      identity = { email: payload.email, sub: payload.sub, issuer: publicOrigin }
    } catch {
      return json('invalid_access_assertion', 401)
    }
    const oauth = authorization.getOAuthApi(env)
    try {
      if (request.method === 'GET') {
        // Restrict URL-form client IDs before the library can fetch an untrusted metadata URL.
        const clientId = new URL(request.url).searchParams.get('client_id') ?? ''
        if (clientId.includes(':') && clientId !== clientMetadataUrl) return json('invalid_client', 400)
        const auth = await oauth.parseAuthRequest(request)
        if (!redirects.has(auth.redirectUri)) return json('invalid_redirect_uri', 400)
        if (auth.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge ?? '')) {
          return json('invalid_pkce', 400)
        }
        if (auth.scope.some((value) => value !== scope && value !== 'offline_access')) return json('invalid_scope', 400)
        // ponytail: one full-access scope; split read/write only when the tools enforce that distinction.
        if (!auth.scope.includes(scope)) auth.scope.push(scope)
        const details = await oauth.describeConsent(auth)
        const consent = await oauth.beginConsent(auth)
        consent.headers.set('Content-Type', 'text/html; charset=utf-8')
        consent.headers.set('Referrer-Policy', 'no-referrer')
        return new Response(consentPage(details, consent.handle), { headers: consent.headers })
      }
      if (request.headers.get('origin') !== publicOrigin) return json('invalid_origin', 403)
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return json('invalid_request', 400)
      const form = await request.formData()
      const handle = String(form.get('handle') ?? '')
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const approved = await oauth.approveConsent(request, handle)
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, userId: identity.sub, metadata: {},
        scope: approved.request.scope, props: identity,
      })
      approved.headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers: approved.headers })
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) return json('invalid_authorization_request', 400)
      throw error
    }
  }

  return { async fetch(request, ctx) {
    const url = new URL(request.url)
    if (url.origin !== publicOrigin) return json('not_found', 404)
    if (url.searchParams.has('access_token')) return json('tokens_must_use_authorization_header', 400)
    if (url.pathname === '/mcp' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      if (url.pathname === '/mcp' && (request.headers.has('cf-access-client-id') || request.headers.has('cf-access-client-secret'))) {
        if (!request.headers.get('cf-access-client-id') || !request.headers.get('cf-access-client-secret')
          || !equal(request.headers.get('authorization') ?? '', `Bearer ${env.ORIGIN_API_KEY}`)) return json('invalid_legacy_credentials', 401)
        return proxy(request, true)
      }
      return protectedResource.fetch(request, env, ctx)
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const head = request.method === 'HEAD'
      const response = await authorization.fetch(head ? new Request(request, { method: 'GET' }) : request, env, ctx)
      if (!['GET', 'HEAD'].includes(request.method) || !response.ok) return response
      const metadata = await response.json()
      metadata.token_endpoint_auth_methods_supported = ['none']
      delete metadata.token_endpoint_auth_signing_alg_values_supported
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store')
      return new Response(head ? null : JSON.stringify(metadata), {
        headers,
      })
    }
    if (!['/oauth/authorize', '/oauth/token', '/oauth/register'].includes(url.pathname)) return json('not_found', 404)
    if (url.pathname === '/oauth/authorize' && !['GET', 'POST'].includes(request.method)) {
      return json('method_not_allowed', 405, { Allow: 'GET, POST' })
    }
    if (!(await env.AUTH_RATE_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' })).success) {
      return json('rate_limit_exceeded', 429, { 'Retry-After': '60' })
    }
    const body = await limitedBody(request, 16384)
    request = new Request(request, { body })
    if (url.pathname === '/oauth/authorize') return authorize(request)
    // Token/revocation CIMD lookups are restricted too, not just authorization-page lookups.
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      if (request.headers.has('authorization')) return json('invalid_client', 400)
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return json('invalid_request', 400)
      const form = new URLSearchParams(await request.clone().text())
      const clientId = form.get('client_id') ?? ''
      if (clientId.includes(':') && clientId !== clientMetadataUrl) return json('invalid_client', 400)
      if (form.has('client_assertion')) return json('invalid_client', 400)
    }
    return authorization.fetch(request, env, ctx)
  } }
}

// The provider expects KV operations. SQLite plus request serialization makes redemption/revocation consistent across regions.
export class OAuthState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS oauth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER, metadata TEXT)')
    const storage = {
      async get(key, options) {
        const row = [...sql.exec('SELECT value FROM oauth_state WHERE key = ? AND (expires IS NULL OR expires > ?)', key, Math.floor(Date.now() / 1000))][0]
        return row ? (options?.type === 'json' ? JSON.parse(row.value) : row.value) : null
      },
      async put(key, value, options = {}) {
        const expires = options.expiration ?? (options.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : null)
        sql.exec('INSERT OR REPLACE INTO oauth_state (key, value, expires, metadata) VALUES (?, ?, ?, ?)',
          key, value, expires, options.metadata === undefined ? null : JSON.stringify(options.metadata))
        if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 3600000)
      },
      async delete(key) { sql.exec('DELETE FROM oauth_state WHERE key = ?', key) },
      async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
        const rows = [...sql.exec('SELECT key, expires, metadata FROM oauth_state WHERE substr(key, 1, length(?)) = ? AND key > ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?',
          prefix, prefix, cursor, Math.floor(Date.now() / 1000), limit + 1)]
        return {
          keys: rows.slice(0, limit).map((row) => ({
            name: row.key,
            ...(row.expires === null ? {} : { expiration: row.expires }),
            ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
          })),
          list_complete: rows.length <= limit,
          cursor: rows.length > limit ? rows[limit - 1].key : '',
        }
      },
    }
    this.gateway = createGateway({ ...env, OAUTH_KV: storage })
  }

  async fetch(request) {
    // ponytail: one owner's small workload; partition state by owner only if multi-user support is added.
    return this.ctx.blockConcurrencyWhile(() => this.gateway.fetch(request, this.ctx))
  }

  async alarm() {
    this.ctx.storage.sql.exec('DELETE FROM oauth_state WHERE expires IS NOT NULL AND expires <= ?', Math.floor(Date.now() / 1000))
    if ([...this.ctx.storage.sql.exec('SELECT 1 FROM oauth_state LIMIT 1')].length) {
      await this.ctx.storage.setAlarm(Date.now() + 3600000)
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await env.OAUTH_STATE.getByName('organizer').fetch(request)
    } catch (error) {
      // Never log requests, authorization codes, assertions, upstream responses, or secrets.
      return json(error instanceof RangeError ? 'request_too_large' : 'gateway_unavailable',
        error instanceof RangeError ? 413 : 503)
    }
  },
}
