import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import express from 'express'
import { createGoogleIntegration, tokenCipher, remoteEvent } from '../src/google-sync.js'
import { ensureRecurringEvents, eventOverlapWhere, syncCardDeadline } from '../src/store.js'

const env = { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
const cipher = tokenCipher(env.GOOGLE_TOKEN_ENCRYPTION_KEY)
const now = () => Date.parse('2026-09-06T12:00:00Z')
let directory, db, integration, server, url, remotes, sequence, loseInsert, beforeGet, racePatch, losePatch, afterInsert
const remote = (id, summary = 'Remote') => ({ id, summary, etag: `"${++sequence}"`, start: { dateTime: '2026-09-07T09:00:00Z' }, end: { dateTime: '2026-09-07T10:00:00Z' } })
const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status })
const normalize = (body) => {
  for (const key of ['start', 'end']) {
    if (body[key]?.dateTime && !/(Z|[+-]\d\d:\d\d)$/.test(body[key].dateTime)) body[key].dateTime += 'Z'
  }
  return body
}
async function mockFetch(input, options = {}) {
  const parsed = new URL(input)
  if (parsed.hostname === 'oauth2.googleapis.com') return response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
  if (parsed.pathname.endsWith('/calendars/primary')) return response({ id: 'owner@example.com', timeZone: 'UTC' })
  const id = decodeURIComponent(parsed.pathname.split('/events/')[1] || '')
  const method = options.method || 'GET'
  if (!id && method === 'GET') return response({ items: [...remotes.values()].filter((item) => !item.hidden) })
  if (method === 'POST') {
    const body = normalize(JSON.parse(options.body))
    if (remotes.has(body.id)) return response({}, 409)
    const saved = { ...body, etag: `"${++sequence}"` }
    remotes.set(body.id, saved)
    if (afterInsert) await afterInsert(saved)
    if (loseInsert) { loseInsert = false; throw new Error('lost response') }
    return response(saved)
  }
  if (method === 'GET') {
    if (beforeGet) { const run = beforeGet; beforeGet = null; await run() }
    return remotes.has(id) ? response(remotes.get(id)) : response({}, 404)
  }
  if (racePatch) { racePatch = false; remotes.set(id, remote(id, 'Concurrent Google')) }
  const current = remotes.get(id)
  if (!current) return response({}, 404)
  if (options.headers['If-Match'] !== current.etag) return response({}, 412)
  if (method === 'DELETE') { remotes.set(id, { id, status: 'cancelled', etag: `"${++sequence}"` }); return response(null, 204) }
  const saved = { ...current, ...normalize(JSON.parse(options.body)), etag: `"${++sequence}"` }
  remotes.set(id, saved)
  if (losePatch) { losePatch = false; throw new Error('lost patch response') }
  return response(saved)
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'organizer-google-test-'))
  const databaseUrl = `file:${join(directory, 'test.db').replaceAll('\\', '/')}`
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' })
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  integration = createGoogleIntegration(db, { env, fetchImpl: mockFetch, now })
  const app = express()
  app.use(express.json())
  app.use('/api/integrations/google', integration.router)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  url = `http://127.0.0.1:${server.address().port}/api/integrations/google`
})
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (db) await db.$disconnect()
  if (directory) await rm(directory, { recursive: true, force: true })
})
beforeEach(async () => {
  await db.googleEventMapping.deleteMany()
  await db.event.deleteMany()
  await db.list.deleteMany()
  await db.googleIntegration.deleteMany()
  await db.googleIntegration.create({ data: { id: 1, tokens: cipher.encrypt({ access_token: 'access', refresh_token: 'refresh', expires_at: now() + 3600000 }) } })
  remotes = new Map(); sequence = 0; loseInsert = false; beforeGet = null; racePatch = false; losePatch = false
  afterInsert = null
})
const local = () => db.event.create({ data: { title: 'Local', eventDate: '2026-09-07' } })

test('authenticated encryption rejects tampering and invalid keys', () => {
  const encrypted = cipher.encrypt({ refresh_token: 'private' })
  assert.deepEqual(cipher.decrypt(encrypted), { refresh_token: 'private' })
  const bytes = Buffer.from(encrypted, 'base64'); bytes[15] ^= 1
  assert.throws(() => cipher.decrypt(bytes.toString('base64')))
  assert.throws(() => tokenCipher('invalid'))
})
test('OAuth state is cookie-bound, expiring, single-use; foreign mutations rejected', async () => {
  assert.equal((await fetch(`${url}/connect`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403)
  const connect = await fetch(`${url}/connect`, { method: 'POST' })
  const cookie = connect.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/)
  const state = new URL((await connect.json()).url).searchParams.get('state')
  const callback = `${url}/callback?state=${state}&code=test`
  assert.equal((await fetch(callback, { redirect: 'manual' })).headers.get('location'), '/?google_calendar=error')
  const headers = { Cookie: cookie.split(';')[0] }
  assert.equal((await fetch(callback, { headers, redirect: 'manual' })).headers.get('location'), '/?google_calendar=connected')
  assert.equal((await fetch(callback, { headers, redirect: 'manual' })).headers.get('location'), '/?google_calendar=error')
  assert.deepEqual(await (await fetch(`${url}/status`)).json(), { configured: true, connected: true, lastSyncedAt: null })
  const again = await fetch(`${url}/connect`, { method: 'POST' })
  const state2 = new URL((await again.json()).url).searchParams.get('state')
  await db.googleIntegration.update({ where: { id: 1 }, data: { oauthExpiresAt: now() - 1 } })
  assert.equal((await fetch(`${url}/callback?state=${state2}&code=test`, { headers: { Cookie: again.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' })).headers.get('location'), '/?google_calendar=error')
})
test('exports once, retries uncertain insert without duplicates, retains delete mapping', async () => {
  const event = await local()
  loseInsert = true
  await assert.rejects(integration.sync())
  assert.equal(remotes.size, 1)
  await integration.sync()
  assert.equal(remotes.size, 1)
  assert.equal((await integration.sync()).exported, 0)
  await db.event.delete({ where: { id: event.id } })
  assert.equal((await db.googleEventMapping.findFirst()).eventId, null)
  assert.equal((await integration.sync()).deleted, 1)
  assert.equal((await integration.sync()).imported, 0)
})
test('imports all-day and multi-day events, remote wins conflicting edits', async () => {
  remotes.set('r', { id: 'r', summary: 'Holiday', etag: '"1"', start: { date: '2026-09-07' }, end: { date: '2026-09-10' } })
  assert.equal((await integration.sync()).imported, 1)
  const event = await db.event.findFirst()
  assert.equal(event.allDay, true); assert.equal(event.endDate, '2026-09-10')
  await db.event.update({ where: { id: event.id }, data: { title: 'Local edit' } })
  remotes.set('r', { ...remotes.get('r'), summary: 'Google edit', etag: '"2"' })
  const result = await integration.sync()
  assert.equal(result.conflicts, 1)
  assert.equal((await db.event.findFirst()).title, 'Google edit')
  assert.equal((await integration.sync()).exported, 0)
})
test('conditional ETag prevents overwriting a racing Google edit', async () => {
  const event = await local()
  await integration.sync()
  await db.event.update({ where: { id: event.id }, data: { title: 'Local edit' } })
  racePatch = true
  assert.equal((await integration.sync()).conflicts, 1)
  assert.equal((await db.event.findFirst()).title, 'Concurrent Google')
})
test('does not overwrite local edits made during remote reads; missing window item is not deletion', async () => {
  remotes.set('r', remote('r'))
  await integration.sync()
  const event = await db.event.findFirst()
  remotes.set('r', { ...remote('r', 'Google edit'), hidden: true })
  beforeGet = () => db.event.update({ where: { id: event.id }, data: { title: 'Racing local edit' } })
  const result = await integration.sync()
  assert.equal(result.skippedReasons.concurrentLocalEdit, 1)
  assert.equal((await db.event.findFirst()).title, 'Racing local edit')
  assert.equal(result.deleted, 0)
})
test('remote deletion removes local row; deadlines export and roots are counted', async () => {
  remotes.set('r', remote('r'))
  await integration.sync()
  remotes.set('r', { id: 'r', status: 'cancelled', etag: '"deleted"' })
  assert.equal((await integration.sync()).deleted, 1)
  await db.event.create({ data: { title: 'Deadline', eventDate: '2026-09-07', isDeadline: 1, endTime: '09:00' } })
  await db.event.create({ data: { title: 'Root', eventDate: '2026-09-07', recurrence: 'daily' } })
  const result = await integration.sync()
  assert.equal(result.skippedReasons.unsupportedLocalEvent, 1)
  assert.equal(result.exported, 1)
})

test('deadline insert and PATCH retries round-trip without duplicates or churn, including midnight rollover', async () => {
  const event = await db.event.create({ data: { title: 'Deadline', eventDate: '2026-09-07', eventTime: '23:59', endTime: '23:59', isDeadline: 1 } })
  loseInsert = true
  await assert.rejects(integration.sync())
  const [id] = remotes.keys()
  assert.equal(remotes.get(id).end.dateTime, '2026-09-08T00:00:00Z')
  assert.equal(remotes.get(id).extendedProperties.private.lazyOrganizerDeadline, '1')
  await integration.sync()
  assert.equal(remotes.size, 1)
  assert.equal((await db.googleEventMapping.findFirst()).pending, null)
  await db.event.update({ where: { id: event.id }, data: { title: 'Edited deadline' } })
  losePatch = true
  await assert.rejects(integration.sync())
  await integration.sync()
  const result = await integration.sync()
  assert.equal(result.exported, 0); assert.equal(result.imported, 0)
  assert.equal((await db.event.findFirst()).endTime, '23:59')
  await db.event.delete({ where: { id: event.id } })
  assert.equal((await integration.sync()).deleted, 1)
})

test('marked Google deadlines import as zero-duration deadlines and ordinary edits retain identity', async () => {
  remotes.set('d', { ...remote('d'), extendedProperties: { private: { lazyOrganizerDeadline: '1' } } })
  await integration.sync()
  let event = await db.event.findFirst()
  assert.equal(event.isDeadline, 1); assert.equal(event.endTime, event.eventTime); assert.equal(event.endDate, null)
  remotes.set('d', { ...remote('d', 'Renamed'), start: { date: '2026-09-09' }, end: { date: '2026-09-10' } })
  await integration.sync()
  event = await db.event.findFirst()
  assert.equal(event.isDeadline, 1); assert.equal(event.allDay, false); assert.equal(event.eventTime, '00:00'); assert.equal(event.endTime, '00:00')
  assert.equal((await integration.sync()).exported, 0)
})

test('Google task deadline moves and deletion reconcile only matching linked due dates, not task text', async () => {
  const list = await db.list.create({ data: { title: 'Tasks', position: 0 } })
  const card = await db.card.create({ data: { listId: list.id, title: 'Task', description: 'Task details', position: 0, dueDate: '2026-09-07' } })
  await db.$transaction((tx) => syncCardDeadline(tx, { cardId: card.id, title: card.title, description: card.description, color: 'blue', dueDate: card.dueDate, recurrence: 'none', recurrenceInterval: 1 }))
  const event = await db.event.findFirst()
  const mention = await db.card.create({ data: { listId: list.id, title: 'Mention', position: 1, dueDate: '2026-09-20', eventLinks: { create: { eventId: event.id } } } })
  await integration.sync()
  const [id] = remotes.keys()
  remotes.set(id, { ...remote(id, 'Google deadline title'), start: { dateTime: '2026-09-10T12:00:00Z' }, end: { dateTime: '2026-09-10T13:00:00Z' } })
  await integration.sync()
  const moved = await db.card.findUnique({ where: { id: card.id } })
  assert.equal(moved.dueDate, '2026-09-10'); assert.equal(moved.title, 'Task'); assert.equal(moved.description, 'Task details')
  const deadline = await db.event.findFirst()
  assert.equal(deadline.id, event.id); assert.equal(deadline.isDeadline, 1); assert.equal(deadline.endTime, '12:00')
  assert.equal((await integration.sync()).exported, 0)
  remotes.set(id, { id, status: 'cancelled', etag: 'deleted' })
  await integration.sync()
  assert.equal((await db.card.findUnique({ where: { id: card.id } })).dueDate, null)
  assert.equal((await db.card.findUnique({ where: { id: mention.id } })).dueDate, '2026-09-20')
  assert.equal(await db.event.count(), 0)
  assert.equal((await integration.sync()).exported, 0)
})

test('recurring deadline roots export individually, recover inserts and preserve recurrence on pull', async () => {
  const root = await db.event.create({ data: { title: 'Recurring deadline', eventDate: '2026-09-06', endTime: '09:00', isDeadline: 1, recurrence: 'daily', recurrenceInterval: 2 } })
  await ensureRecurringEvents('2026-09-08', db)
  loseInsert = true
  await assert.rejects(integration.sync())
  const result = await integration.sync()
  assert.equal(result.skipped, 0)
  assert.equal(remotes.size, 2)
  const mapping = await db.googleEventMapping.findUnique({ where: { eventId: root.id } })
  const google = remotes.get(mapping.remoteId)
  assert.equal(google.recurrence, undefined)
  assert.equal(google.end.dateTime, '2026-09-06T09:01:00Z')
  remotes.set(mapping.remoteId, { ...google, summary: 'Google title', etag: 'renamed' })
  assert.equal((await integration.sync()).imported, 1)
  const saved = await db.event.findUnique({ where: { id: root.id } })
  assert.equal(saved.title, 'Google title'); assert.equal(saved.recurrence, 'daily'); assert.equal(saved.recurrenceInterval, 2)
  assert.equal(saved.isDeadline, 1); assert.equal(saved.endTime, saved.eventTime)
  assert.equal((await integration.sync()).exported, 0)
  assert.equal((await integration.sync()).imported, 0)
  remotes.set(mapping.remoteId, { ...remote(mapping.remoteId), etag: 'moved' })
  assert.equal((await integration.sync()).skippedReasons.unsafeDeadlineRootScheduleChange, 1)
  assert.equal((await db.event.findUnique({ where: { id: root.id } })).eventDate, root.eventDate)
  assert.equal(await db.event.count(), 2)
  remotes.set(mapping.remoteId, { id: mapping.remoteId, status: 'cancelled', etag: 'deleted' })
  await integration.sync()
  assert.equal(await db.event.count(), 0)
  assert.equal(await db.googleEventMapping.count(), 2)
  assert.equal((await integration.sync()).deleted, 1)
  assert.equal((await integration.sync()).exported, 0)
})
test('uses calendar timezone and skips sub-minute precision', () => {
  assert.equal(remoteEvent(remote('r'), 'America/New_York').eventTime, '05:00')
  const value = remote('r'); value.start.dateTime = '2026-09-07T09:00:30Z'
  assert.equal(remoteEvent(value, 'UTC'), null)
})
test('persistent lease rejects overlapping sync', async () => {
  await db.googleIntegration.update({ where: { id: 1 }, data: { lockOwner: 'other', lockUntil: now() + 60000 } })
  await assert.rejects(integration.sync(), { status: 409 })
})
test('uncertain PATCH recovery preserves a subsequent local edit', async () => {
  const event = await local()
  await integration.sync()
  await db.event.update({ where: { id: event.id }, data: { title: 'First edit' } })
  losePatch = true
  await assert.rejects(integration.sync())
  await db.event.update({ where: { id: event.id }, data: { title: 'Second edit' } })
  await integration.sync()
  assert.equal((await db.event.findFirst()).title, 'Second edit')
  assert.equal((await integration.sync()).exported, 1)
  assert.equal([...remotes.values()][0].summary, 'Second edit')
})
test('remote edits win over a local deletion by restoring a mapped event', async () => {
  remotes.set('r', remote('r'))
  await integration.sync()
  await db.event.deleteMany()
  remotes.set('r', remote('r', 'Changed after delete'))
  const result = await integration.sync()
  assert.equal(result.conflicts, 1)
  assert.equal((await db.event.findFirst()).title, 'Changed after delete')
})
test('disconnect preserves mappings and denies sync until reconnected', async () => {
  await local(); await integration.sync()
  assert.equal((await fetch(`${url}/disconnect`, { method: 'POST' })).status, 200)
  assert.equal(await db.googleEventMapping.count(), 1)
  await assert.rejects(integration.sync(), { status: 409 })
  assert.equal((await (await fetch(`${url}/status`)).json()).connected, false)
})

test('remote-deleted recurrence tail stays deleted while generation advances beyond tombstones', async () => {
  const root = await db.event.create({ data: { title: 'Daily', eventDate: '2026-09-06', recurrence: 'daily' } })
  await ensureRecurringEvents('2026-09-08', db)
  await integration.sync()
  const mappings = await db.googleEventMapping.findMany()
  assert.equal(mappings.length, 2)
  for (const mapping of mappings) remotes.set(mapping.remoteId, { id: mapping.remoteId, status: 'cancelled', etag: '"deleted"' })
  assert.equal((await integration.sync()).deleted, 2)
  for (const mapping of await db.googleEventMapping.findMany()) {
    assert.equal(mapping.eventId, null)
    assert.equal(JSON.parse(mapping.localSnapshot).recurrenceParentId, root.id)
  }
  await ensureRecurringEvents('2026-09-08', db)
  await ensureRecurringEvents('2026-09-08', db)
  assert.equal(await db.event.count(), 1)
  assert.equal((await integration.sync()).exported, 0)
  await ensureRecurringEvents('2026-09-09', db)
  assert.deepEqual((await db.event.findMany({ where: { recurrenceParentId: root.id } })).map((event) => event.eventDate), ['2026-09-09'])
  assert.equal((await integration.sync()).exported, 1)
})

test('initial insert imports divergent returned representation instead of acknowledging stale local state', async () => {
  await local()
  afterInsert = (saved) => { saved.summary = 'Google normalized title' }
  const result = await integration.sync()
  assert.equal(result.imported, 1)
  assert.equal((await db.event.findFirst()).title, 'Google normalized title')
  assert.equal((await integration.sync()).imported, 0)
})

test('uncertain insert imports subsequent Google edits when local is unchanged', async () => {
  await local()
  loseInsert = true
  await assert.rejects(integration.sync())
  const [id] = remotes.keys()
  remotes.set(id, remote(id, 'Edited on Google'))
  assert.equal((await integration.sync()).imported, 1)
  assert.equal((await db.event.findFirst()).title, 'Edited on Google')
  assert.equal(remotes.size, 1)
  assert.equal((await integration.sync()).exported, 0)
})

test('divergent uncertain insertion preserves newer local edits and leaves recovery pending', async () => {
  const event = await local()
  loseInsert = true
  await assert.rejects(integration.sync())
  const [id] = remotes.keys()
  remotes.set(id, remote(id, 'Edited on Google'))
  await db.event.update({ where: { id: event.id }, data: { title: 'New local edit' } })
  const result = await integration.sync()
  assert.equal(result.conflicts, 1)
  assert.equal(result.skippedReasons.uncertainInsertWithNewerLocalEdit, 1)
  assert.equal((await db.event.findFirst()).title, 'New local edit')
  const mapping = await db.googleEventMapping.findFirst()
  assert.equal(mapping.remoteEtag, null)
  assert.ok(mapping.pending)
  assert.equal(remotes.get(id).summary, 'Edited on Google')
})

test('insert reconciliation rechecks local edits made during the insert request', async () => {
  const event = await local()
  afterInsert = async (saved) => {
    saved.summary = 'Google changed'
    await db.event.update({ where: { id: event.id }, data: { title: 'Concurrent local' } })
  }
  const result = await integration.sync()
  assert.equal(result.skippedReasons.concurrentLocalEdit, 1)
  assert.equal((await db.event.findFirst()).title, 'Concurrent local')
  assert.ok((await db.googleEventMapping.findFirst()).pending)
})

test('insert acknowledgement compares instants in attempted timezone without false divergence', async () => {
  const event = await db.event.create({ data: { title: 'New York', eventDate: '2026-09-07', timeZone: 'America/New_York' } })
  afterInsert = (saved) => {
    saved.start.dateTime = '2026-09-07T13:00:00Z'
    saved.end.dateTime = '2026-09-07T14:00:00Z'
  }
  const result = await integration.sync()
  assert.equal(result.imported, 0)
  assert.equal(result.conflicts, 0)
  assert.equal((await db.event.findUnique({ where: { id: event.id } })).eventTime, '09:00')
  assert.equal((await db.googleEventMapping.findFirst()).pending, null)
  assert.equal((await integration.sync()).exported, 0)
})

test('Today and month overlap filters include spans and exclude exclusive midnight and all-day ends', async () => {
  const cases = [
    { title: 'spanning', eventDate: '2026-09-05', endDate: '2026-09-08' },
    { title: 'ends later today', eventDate: '2026-09-05', endDate: '2026-09-06', endTime: '00:01' },
    { title: 'midnight excluded', eventDate: '2026-09-05', endDate: '2026-09-06', endTime: '00:00' },
    { title: 'all-day excluded', eventDate: '2026-09-05', endDate: '2026-09-06', allDay: true },
    { title: 'all-day span', eventDate: '2026-09-05', endDate: '2026-09-07', allDay: true },
    { title: 'today', eventDate: '2026-09-06' },
    { title: 'deadline', eventDate: '2026-09-06', isDeadline: 1, eventTime: '00:00', endTime: '00:00' },
    { title: 'tomorrow excluded', eventDate: '2026-09-07' },
    { title: 'past excluded', eventDate: '2026-09-05' },
  ]
  await db.event.createMany({ data: cases })
  const titles = async (start, end) => (await db.event.findMany({ where: eventOverlapWhere(start, end), orderBy: { title: 'asc' } })).map((event) => event.title)
  assert.deepEqual(await titles('2026-09-06', '2026-09-07'), ['all-day span', 'deadline', 'ends later today', 'spanning', 'today'])
  assert.deepEqual(await titles('2026-09-06', '2026-10-06'), ['all-day span', 'deadline', 'ends later today', 'spanning', 'today', 'tomorrow excluded'])
})
