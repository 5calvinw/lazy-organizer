import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const base = 'https://organizer.example'
const resource = `${base}/mcp`
const issuer = 'https://team.cloudflareaccess.com'
const callback = 'https://www.cursor.com/agents/mcp/oauth/callback'
const metadataId = 'https://cursor.com/oauth/mcp-client.json'
const env = {
  PUBLIC_ORIGIN: base, ACCESS_ISSUER: issuer, ACCESS_AUD: 'test-audience',
  OWNER_EMAIL: 'owner@example.com', ORIGIN_MCP_URL: 'https://origin.example/mcp',
  ORIGIN_API_KEY: 'test-api-key', ORIGIN_CF_CLIENT_ID: 'gateway-service',
  ORIGIN_CF_CLIENT_SECRET: 'gateway-secret',
}
let mf, options, privateKey, publicKey, storage, forwards = [], lookups = [], upstreamStatus = 200
let failUpstream = false
const req = (path, init = {}) => mf.dispatchFetch(new URL(path, base), {
  ...init, redirect: 'manual',
  headers: { 'cf-connecting-ip': '192.0.2.1', ...init.headers },
})
const form = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
})
const mcp = (token, headers = {}) => req('/mcp', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})

before(async () => {
  ;({ privateKey, publicKey } = await generateKeyPair('RS256'))
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' }
  options = {
    name: 'gateway', modules: true, scriptPath: resolve('.build/index.js'),
    compatibilityDate: '2026-11-06',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings: env, durableObjects: { OAUTH_STATE: { className: 'OAuthState', useSQLite: true } },
    ratelimits: { AUTH_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 10000, period: 60 } } },
    outboundService: async (request) => {
      const url = new URL(request.url)
      if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] })
      if (url.href === metadataId) {
        lookups.push(url.href)
        return Response.json({
          client_id: metadataId, client_name: 'Cursor', token_endpoint_auth_method: 'none',
          redirect_uris: [callback, 'http://localhost:8787/callback'],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        })
      }
      assert.equal(url.href, env.ORIGIN_MCP_URL, 'No unconfigured outbound URLs')
      forwards.push({ headers: Object.fromEntries(request.headers), body: await request.text() })
      if (failUpstream) return new Response('Simulated upstream failure', { status: 503 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        status: upstreamStatus,
        headers: {
          'Content-Type': 'application/json', 'Set-Cookie': 'private=must-not-leak',
          ...(upstreamStatus === 302 ? { Location: 'https://untrusted.example/' } : {}),
        },
      })
    },
  }
  mf = new Miniflare({ ...convertV4MiniflareOptions(options), unsafeInspectDurableObjects: true })
  await mf.ready
  storage = await mf.unsafeGetDurableObjectStorage('gateway', 'OAuthState', { name: 'organizer' })
})
after(async () => { await mf?.dispose() })

async function assertion(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    type: 'app', sub: 'owner-id', email: env.OWNER_EMAIL,
    iss: issuer, aud: env.ACCESS_AUD, iat: now, nbf: now - 1, exp: now + 600,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key)
}

async function register(overrides = {}) {
  return req('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: '<script>self-asserted</script>', redirect_uris: [callback],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], ...overrides,
    }),
  })
}

async function begin(clientId, changes = {}, jwt) {
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: 'code', resource,
    scope: 'organizer:manage offline_access', state: 'test-client-state',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...changes,
  })
  const response = await req(`/oauth/authorize?${query}`, {
    headers: { 'cf-access-jwt-assertion': jwt ?? await assertion() },
  })
  const html = await response.text()
  return {
    response, html, verifier,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
    handle: /name="handle" value="([^"]+)"/.exec(html)?.[1],
  }
}
async function approve(start, changes = {}) {
  return req('/oauth/authorize', form({
    handle: start.handle, decision: 'approve', ...changes,
  }, {
    origin: base, cookie: start.cookie, 'cf-access-jwt-assertion': await assertion(),
  }))
}
async function grant(clientId, tokenChanges = {}) {
  const start = await begin(clientId)
  assert.equal(start.response.status, 200, start.html)
  const approved = await approve(start)
  assert.equal(approved.status, 302, await approved.clone().text())
  const location = new URL(approved.headers.get('location'))
  assert.equal(location.origin + location.pathname, callback)
  assert.equal(location.searchParams.get('state'), 'test-client-state')
  assert.equal(location.searchParams.get('iss'), base)
  const body = {
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback,
    code: location.searchParams.get('code'), code_verifier: start.verifier, resource, ...tokenChanges,
  }
  const response = await req('/oauth/token', form(body))
  return { response, tokens: await response.json(), body, start }
}

test('discovery advertises the canonical resource, S256, public registration, and issuer response', async () => {
  const protectedResponse = await req('/.well-known/oauth-protected-resource/mcp')
  assert.equal(protectedResponse.status, 200)
  assert.deepEqual(await protectedResponse.json(), {
    resource, authorization_servers: [base], resource_name: 'Organizer',
    scopes_supported: ['organizer:manage'], bearer_methods_supported: ['header'],
  })
  const metadata = await (await req('/.well-known/oauth-authorization-server')).json()
  assert.equal(metadata.issuer, base)
  assert.equal(metadata.authorization_endpoint, `${base}/oauth/authorize`)
  assert.equal(metadata.token_endpoint, `${base}/oauth/token`)
  assert.equal(metadata.revocation_endpoint, metadata.token_endpoint)
  assert.equal(metadata.registration_endpoint, `${base}/oauth/register`)
  assert.equal(metadata.client_id_metadata_document_supported, true)
  assert.equal(metadata.authorization_response_iss_parameter_supported, true)
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none'])
  const head = await req('/.well-known/oauth-authorization-server', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const cors = await req('/.well-known/oauth-authorization-server', { headers: { origin: 'https://grok.com' } })
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://grok.com')
})

test('unauthorized MCP requests challenge, never proxy; cookies/Access assertions are not MCP tokens', async () => {
  const count = forwards.length
  for (const headers of [{}, { 'cf-access-jwt-assertion': await assertion() }, { cookie: 'CF_Authorization=anything' }]) {
    const response = await req('/mcp', { headers })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=.*oauth-protected-resource\/mcp/)
    assert.match(response.headers.get('www-authenticate'), /scope="organizer:manage"/)
  }
  assert.equal((await mcp('invalid')).status, 401)
  assert.equal((await req('/mcp?access_token=invalid')).status, 400)
  assert.equal((await req('/mcp-other')).status, 404)
  assert.equal(forwards.length, count)
})

test('registration is public but exact: no arbitrary, wildcard, fragment, remote HTTP, or secret clients', async () => {
  const good = await register({ redirect_uris: [callback, 'cursor://anysphere.cursor-mcp/oauth/callback'] })
  assert.equal(good.status, 201)
  assert.equal((await good.json()).client_secret, undefined)
  for (const uri of ['https://evil.example/callback', `${callback}/`, `${callback}#fragment`,
    'https://www.cursor.com/*', 'http://remote.example/callback', 'http://127.0.0.1:8888/callback']) {
    assert.equal((await register({ redirect_uris: [uri] })).status, 400, uri)
  }
  assert.equal((await register({ token_endpoint_auth_method: 'client_secret_basic' })).status, 400)
})

test('browser authorization validates signature, issuer, audience, expiry, account, and user identity', async () => {
  const client = await (await register()).json()
  assert.equal((await req('/oauth/authorize')).status, 401)
  for (const [claims, expected] of [
    [{ iss: 'https://attacker.example' }, 401], [{ aud: 'another-app' }, 401],
    [{ exp: 1 }, 401], [{ nbf: Math.floor(Date.now() / 1000) + 9999 }, 401],
    [{ email: 'other@example.com' }, 403], [{ sub: '' }, 403],
    [{ type: 'org' }, 403], [{ common_name: 'service-token' }, 403],
  ]) assert.equal((await begin(client.client_id, {}, await assertion(claims))).response.status, expected)
  const other = await generateKeyPair('RS256')
  assert.equal((await begin(client.client_id, {}, await assertion({}, other.privateKey))).response.status, 401)
  assert.equal((await begin(client.client_id, {}, await assertion({ exp: undefined }))).response.status, 401)
})

test('consent is escaped, explicit, browser-bound, CSRF-protected, single-use, and can be denied', async () => {
  const client = await (await register()).json()
  const start = await begin(client.client_id)
  assert.equal(start.response.status, 200)
  assert.match(start.html, /&#60;script&#62;/)
  assert(!start.html.includes('<script>'))
  assert.match(start.response.headers.get('set-cookie'), /Secure/)
  assert.match(start.response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(start.response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal((await req('/oauth/authorize', form({ handle: start.handle, decision: 'approve' }, {
    origin: 'https://evil.example', cookie: start.cookie, 'cf-access-jwt-assertion': await assertion(),
  }))).status, 403)
  assert.equal((await req('/oauth/authorize', form({ handle: start.handle, decision: 'approve' }, {
    origin: base, 'cf-access-jwt-assertion': await assertion(),
  }))).status, 400)
  const denied = await approve(start, { decision: 'deny' })
  assert.equal(denied.status, 302)
  const location = new URL(denied.headers.get('location'))
  assert.equal(location.searchParams.get('error'), 'access_denied')
  assert.equal(location.searchParams.get('state'), 'test-client-state')
  assert.equal(location.searchParams.get('iss'), base)
  assert.equal((await approve(start)).status, 400)
})

test('authorization rejects unexpected redirects, clients, resources, scopes, and downgrade/plain PKCE', async () => {
  const client = await (await register()).json()
  const beforeLookups = lookups.length
  for (const changes of [
    { redirect_uri: 'https://evil.example/' }, { redirect_uri: 'http://localhost:9999/callback' },
    { resource: 'https://other.example/mcp' }, { scope: 'admin' },
    { code_challenge_method: 'plain' }, { code_challenge: '' }, { response_type: 'token' },
    { client_id: 'https://evil.example/client.json' },
  ]) assert.equal((await begin(client.client_id, changes)).response.status, 400)
  assert.equal(lookups.length, beforeLookups)
})

test('S256 flow issues issuer/resource-bound tokens and proxies with server credentials, not client credentials', async () => {
  const client = await (await register()).json()
  const { response, tokens, body, start } = await grant(client.client_id)
  assert.equal(response.status, 200, JSON.stringify(tokens))
  assert.equal(tokens.token_type.toLowerCase(), 'bearer')
  assert.equal(tokens.resource, resource)
  assert.equal(tokens.expires_in, 900)
  assert(tokens.refresh_token)
  assert.equal((await approve(start)).status, 400)
  const result = await mcp(tokens.access_token, {
    cookie: 'CF_Authorization=private', 'cf-access-jwt-assertion': 'spoof',
    'x-unsafe-header': 'not-forwarded',
  })
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('set-cookie'), null)
  const forwarded = forwards.at(-1)
  assert.equal(forwarded.headers.authorization, `Bearer ${env.ORIGIN_API_KEY}`)
  assert.equal(forwarded.headers['cf-access-client-id'], env.ORIGIN_CF_CLIENT_ID)
  assert.equal(forwarded.headers['cf-access-client-secret'], env.ORIGIN_CF_CLIENT_SECRET)
  assert.equal(forwarded.headers.cookie, undefined)
  assert.equal(forwarded.headers['cf-access-jwt-assertion'], undefined)
  assert.equal(forwarded.headers['x-unsafe-header'], undefined)
  assert(!JSON.stringify(forwarded).includes(tokens.access_token))
  assert.equal((await req('/oauth/token', form(body))).status, 400, 'Code reuse must fail')
})

test('wrong verifier, callback, and token resource cannot exchange the authorization code', async () => {
  const client = await (await register()).json()
  for (const changes of [
    { code_verifier: 'incorrect-verifier' }, { redirect_uri: `${callback}/` },
    { resource: 'https://wrong.example/mcp' },
  ]) {
    const issued = await grant(client.client_id, changes)
    assert.equal(issued.response.status, 400)
    assert.equal(issued.tokens.access_token, undefined)
  }
})

test('CIMD works for the verified Grok metadata URL, no third-party client metadata fetches', async () => {
  const { response, tokens } = await grant(metadataId)
  assert.equal(response.status, 200, JSON.stringify(tokens))
  assert(lookups.includes(metadataId))
  assert.equal((await mcp(tokens.access_token)).status, 200)
  assert.equal((await req('/oauth/token', form({
    client_id: 'https://evil.example/client.json', grant_type: 'refresh_token', refresh_token: 'invalid',
  }))).status, 400)
  assert.equal((await req('/oauth/token', form({ grant_type: 'refresh_token' }, {
    authorization: `Basic ${Buffer.from('https://evil.example/client.json:secret').toString('base64')}`,
  }))).status, 400)
})

test('token scope narrowing is enforced, refresh rotates, revocation prevents access', async () => {
  const client = await (await register()).json()
  const issued = await grant(client.client_id)
  const refreshed = await req('/oauth/token', form({
    grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: issued.tokens.refresh_token, resource, scope: 'offline_access',
  }))
  assert.equal(refreshed.status, 200)
  const tokens = await refreshed.json()
  assert.notEqual(tokens.refresh_token, issued.tokens.refresh_token)
  const denied = await mcp(tokens.access_token)
  assert.equal(denied.status, 403)
  assert.match(denied.headers.get('www-authenticate'), /insufficient_scope/)
  const revoked = await req('/oauth/token', form({
    client_id: client.client_id, token: tokens.refresh_token, token_type_hint: 'refresh_token',
  }))
  assert.equal(revoked.status, 200)
  assert.equal((await mcp(tokens.access_token)).status, 401)
  assert.equal((await req('/oauth/token', form({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource,
  }))).status, 400)
})

test('expired and wrong-audience opaque token records fail closed', async () => {
  const client = await (await register()).json()
  for (const changes of [{ expiresAt: 1 }, { audience: 'https://another.example/mcp' }]) {
    const issued = await grant(client.client_id)
    const [userId, grantId] = issued.tokens.access_token.split(':')
    const rows = await storage.exec('SELECT key, value FROM oauth_state WHERE key LIKE ?', `token:${userId}:${grantId}:%`)
    assert.equal(rows.length, 1)
    const row = rows[0]
    await storage.exec('UPDATE oauth_state SET value = ? WHERE key = ?', JSON.stringify({ ...JSON.parse(row.value), ...changes }), row.key)
    assert.equal((await mcp(issued.tokens.access_token)).status, 401)
  }
})

test('Hermes requires the original API key AND both original service headers; no OAuth fallback', async () => {
  const original = { 'cf-access-client-id': 'hermes-service', 'cf-access-client-secret': 'hermes-secret' }
  assert.equal((await mcp(env.ORIGIN_API_KEY, original)).status, 200)
  assert.equal(forwards.at(-1).headers['cf-access-client-id'], 'hermes-service')
  assert.equal(forwards.at(-1).headers['cf-access-client-secret'], 'hermes-secret')
  const count = forwards.length
  assert.equal((await mcp('invalid-oauth', original)).status, 401)
  assert.equal((await mcp(env.ORIGIN_API_KEY, { 'cf-access-client-id': 'hermes-service' })).status, 401)
  assert.equal((await mcp(env.ORIGIN_API_KEY)).status, 401)
  assert.equal(forwards.length, count)
  // A wrong service credential must still fail at the upstream Access gate.
  upstreamStatus = 403
  try { assert.equal((await mcp(env.ORIGIN_API_KEY, original)).status, 403) } finally { upstreamStatus = 200 }
})

test('upstream redirects and network failures do not leak credentials or follow another host', async () => {
  const client = await (await register()).json()
  const issued = await grant(client.client_id)
  upstreamStatus = 302
  try { assert.equal((await mcp(issued.tokens.access_token)).status, 502) } finally { upstreamStatus = 200 }
  failUpstream = true
  try { assert.equal((await mcp(issued.tokens.access_token)).status, 502) } finally { failUpstream = false }
  assert.equal((await req('/oauth/register', { method: 'POST', body: 'x'.repeat(16385) })).status, 413)
})

test('missing secrets fail closed, and OAuth registration is rate limited', async () => {
  const broken = new Miniflare(convertV4MiniflareOptions({
    ...options, bindings: { ...env, ORIGIN_API_KEY: '' },
  }))
  try { assert.equal((await broken.dispatchFetch(resource)).status, 503) } finally { await broken.dispose() }
  const limited = new Miniflare(convertV4MiniflareOptions({
    ...options,
    ratelimits: { AUTH_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 1, period: 60 } } },
  }))
  try {
    assert.equal((await limited.dispatchFetch(`${base}/oauth/register`, { method: 'POST', body: '{}' })).status, 400)
    assert.equal((await limited.dispatchFetch(`${base}/oauth/register`, { method: 'POST', body: '{}' })).status, 429)
  } finally { await limited.dispose() }
})

test('concurrent redemption cannot mint two tokens for one authorization code', async () => {
  const client = await (await register()).json()
  const start = await begin(client.client_id)
  const approved = await approve(start)
  const code = new URL(approved.headers.get('location')).searchParams.get('code')
  const body = {
    grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback,
    code, code_verifier: start.verifier, resource,
  }
  const results = await Promise.all([req('/oauth/token', form(body)), req('/oauth/token', form(body))])
  assert.equal(results.filter((response) => response.status === 200).length, 1)
})

test('a consent handle can be consumed by only one concurrent browser submission', async () => {
  const client = await (await register()).json()
  const start = await begin(client.client_id)
  const responses = await Promise.all([approve(start), approve(start), approve(start)])
  assert.equal(responses.filter((response) => response.status === 302).length, 1)
})

test('expired storage records fail closed; reauthorizing revokes the previous grant', async () => {
  const client = await (await register()).json()
  const first = await grant(client.client_id)
  assert.equal((await mcp(first.tokens.access_token)).status, 200)
  const next = await grant(client.client_id)
  assert.equal((await mcp(first.tokens.access_token)).status, 401)
  assert.equal((await mcp(next.tokens.access_token)).status, 200)
  const [user, grantId] = next.tokens.access_token.split(':')
  await storage.exec('UPDATE oauth_state SET expires = 1 WHERE key LIKE ?', `token:${user}:${grantId}:%`)
  assert.equal((await mcp(next.tokens.access_token)).status, 401)
})
