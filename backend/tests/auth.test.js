import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

test('browser auth is private, expires after 30 days, and never replaces MCP auth', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-auth-test-'))
  const databaseUrl = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`
  const origin = 'http://localhost:5173'
  const env = {
    ...process.env, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: '0',
    AUTH_USERNAME: 'a', AUTH_PASSWORD: 'test-123',
    BETTER_AUTH_SECRET: 'test-secret-only-abcdefghijklmnopqrstuvwxyz-123456',
    BETTER_AUTH_URL: origin, MCP_API_KEY: 'test-mcp-key',
  }
  let child, db, client
  try {
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env, stdio: 'pipe' })
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const url = await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000)
      child.once('error', reject)
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)) })
      child.stderr.on('data', (data) => { output += data })
      child.stdout.on('data', (data) => {
        output += data
        const match = output.match(/API listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) { clearTimeout(timeout); resolve(match[1]) }
      })
    })
    const call = (path, options = {}) => fetch(`${url}${path}`, options)
    const post = (path, body, headers = {}) => call(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      body: JSON.stringify(body),
    })
    for (const path of ['/api/board', '/api/notebooks', '/api/integrations/google/status', '/api/integrations/google/callback']) {
      assert.equal((await call(path)).status, 401, path)
    }
    assert.equal(await (await call('/api/auth/get-session')).json(), null)
    assert.equal((await post('/api/auth/sign-up/email', {})).status, 404)
    assert.equal((await post('/api/auth/sign-in/username', { username: env.AUTH_USERNAME, password: 'wrong' })).status, 401)
    assert.equal((await post('/api/auth/sign-in/username', { username: env.AUTH_USERNAME, password: env.AUTH_PASSWORD }, { Origin: 'https://evil.example' })).status, 403)
    const login = await post('/api/auth/sign-in/username', { username: env.AUTH_USERNAME, password: env.AUTH_PASSWORD, rememberMe: true })
    assert.equal(login.status, 200, await login.clone().text())
    const setCookie = login.headers.getSetCookie().find((cookie) => cookie.includes('session_token='))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
    assert.match(setCookie, /Max-Age=2592000/i)
    const cookie = setCookie.split(';')[0]
    const session = await (await call('/api/auth/get-session', { headers: { Cookie: cookie } })).json()
    const duration = Date.parse(session.session.expiresAt) - Date.parse(session.session.createdAt)
    assert(Math.abs(duration - 30 * 86400000) < 1000)
    assert.equal((await call('/api/board', { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await post('/api/notebooks', { title: 'Forbidden' }, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403)
    assert.equal((await post('/api/notebooks', { title: 'Allowed' }, { Cookie: cookie })).status, 201)
    assert.equal((await call('/mcp', { headers: { Cookie: cookie } })).status, 401)
    assert.equal((await call('/api/board', { headers: { Authorization: `Bearer ${env.MCP_API_KEY}` } })).status, 401)
    client = new Client({ name: 'auth-check', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${env.MCP_API_KEY}` } },
    }))
    assert((await client.listTools()).tools.some(({ name }) => name === 'get_board'))
    assert.equal((await post('/api/auth/sign-out', {}, { Cookie: cookie })).status, 200)
    assert.equal((await call('/api/board', { headers: { Cookie: cookie } })).status, 401)
    const secondLogin = await post('/api/auth/sign-in/username', { username: env.AUTH_USERNAME, password: env.AUTH_PASSWORD })
    const secondCookie = secondLogin.headers.getSetCookie().find((item) => item.includes('session_token=')).split(';')[0]
    await db.session.updateMany({ data: { expiresAt: new Date(0) } })
    assert.equal((await call('/api/board', { headers: { Cookie: secondCookie } })).status, 401)
    assert.equal((await post('/api/auth/sign-in/username', { username: env.AUTH_USERNAME, password: 'wrong' })).status, 429)
  } finally {
    if (client) await client.close()
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    if (db) await db.$disconnect()
    await rm(directory, { recursive: true, force: true })
  }
})
