import { Router } from 'express'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const DAY = 86400000
const COOKIE = '__Host-google-oauth'
const fields = ['title', 'description', 'eventDate', 'eventTime', 'endTime', 'endDate', 'allDay', 'timeZone', 'isDeadline', 'recurrence', 'recurrenceParentId']
export const snapshot = (event) => event ? JSON.stringify(Object.fromEntries(fields.map((key) => [key, event[key]]))) : null
const hash = (value) => createHash('sha256').update(value).digest('hex')
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const failure = (status, message) => Object.assign(new Error(message), { status })

export function tokenCipher(base64) {
  const key = Buffer.from(base64 || '', 'base64')
  if (key.length !== 32 || key.toString('base64') !== base64) throw new Error('invalid encryption key')
  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64')
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(-16))
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString())
    },
  }
}

export function remoteEvent(remote, zone) {
  if (remote.eventType && remote.eventType !== 'default' || remote.recurrence || !remote.etag) return null
  const allDay = Boolean(remote.start?.date && remote.end?.date)
  const parts = (value) => {
    if (!value?.dateTime || !/(Z|[+-]\d\d:\d\d)$/.test(value.dateTime)) return null
    const date = new Date(value.dateTime)
    if (!Number.isFinite(date.valueOf()) || date.getUTCSeconds() || date.getUTCMilliseconds()) return null
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(({ type, value: v }) => [type, v]))
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
  }
  const start = allDay ? { date: remote.start.date, time: '00:00' } : parts(remote.start)
  const end = allDay ? { date: remote.end.date, time: '00:00' } : parts(remote.end)
  if (!start || !end || `${end.date}T${end.time}` <= `${start.date}T${start.time}`) return null
  return { title: remote.summary || '(Untitled)', description: remote.description || '', eventDate: start.date, eventTime: start.time, endDate: end.date, endTime: end.time, allDay, timeZone: zone }
}

export function localEvent(event, zone) {
  if (event.isDeadline || event.recurrence !== 'none') return null
  const endDate = event.endDate || event.eventDate
  if (event.allDay) {
    if (endDate <= event.eventDate) return null
    return { summary: event.title, description: event.description, start: { date: event.eventDate }, end: { date: endDate } }
  }
  if (`${endDate}T${event.endTime}` <= `${event.eventDate}T${event.eventTime}`) return null
  return { summary: event.title, description: event.description, start: { dateTime: `${event.eventDate}T${event.eventTime}:00`, timeZone: event.timeZone || zone }, end: { dateTime: `${endDate}T${event.endTime}:00`, timeZone: event.timeZone || zone } }
}

function matchesAttempt(remote, attempted, zone) {
  const actual = remoteEvent(remote, attempted.timeZone || zone)
  if (!actual) return false
  const keys = ['title', 'description', 'eventDate', 'allDay', ...(attempted.allDay ? [] : ['eventTime', 'endTime'])]
  return keys.every((key) => actual[key] === attempted[key]) && actual.endDate === (attempted.endDate || attempted.eventDate)
}

export function createGoogleIntegration(db, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let cipher
  try { cipher = tokenCipher(env.GOOGLE_TOKEN_ENCRYPTION_KEY) } catch { /* Status reports invalid configuration without leaking secrets. */ }
  const redirectUri = env.GOOGLE_REDIRECT_URI || 'https://organizer.calvinwu.com/api/integrations/google/callback'
  const origin = env.GOOGLE_APP_ORIGIN || 'https://organizer.calvinwu.com'
  let configured = false
  try { configured = Boolean(cipher && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && new URL(redirectUri).origin === origin && new URL(origin).protocol === 'https:') } catch { /* Invalid URLs disable the integration. */ }
  const router = Router()
  const row = () => db.googleIntegration.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
  async function tokenRequest(params) {
    const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw failure(502, 'Google authorization failed; reconnect if necessary')
    const data = await response.json()
    if (!data.access_token) throw failure(502, 'Google authorization failed')
    return { ...data, expires_at: now() + Number(data.expires_in || 3600) * 1000 }
  }
  async function locked(work) {
    await row()
    const owner = randomBytes(16).toString('hex')
    const acquired = await db.googleIntegration.updateMany({ where: { id: 1, lockUntil: { lt: now() } }, data: { lockOwner: owner, lockUntil: now() + 90000 } })
    if (!acquired.count) throw failure(409, 'Google integration is busy; retry later')
    const renew = async () => {
      const result = await db.googleIntegration.updateMany({ where: { id: 1, lockOwner: owner, lockUntil: { gt: now() } }, data: { lockUntil: now() + 90000 } })
      if (!result.count) throw failure(409, 'Sync lease expired; retry')
    }
    try { return await work(renew) } finally {
      await db.googleIntegration.updateMany({ where: { id: 1, lockOwner: owner }, data: { lockOwner: null, lockUntil: 0 } })
    }
  }
  async function client(connection) {
    let tokens = cipher.decrypt(connection.tokens)
    async function refresh() {
      if (!tokens.refresh_token) throw failure(401, 'Reconnect Google Calendar')
      tokens = { ...tokens, ...await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) }
      await db.googleIntegration.update({ where: { id: 1 }, data: { tokens: cipher.encrypt(tokens) } })
    }
    if (tokens.expires_at < now() + 60000) await refresh()
    return async (path, options = {}) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(`https://www.googleapis.com/calendar/v3/${path}`, { ...options, headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(20000) })
        if (response.status === 401 && attempt === 0) { await refresh(); continue }
        if (!response.ok) throw failure(response.status, 'Google Calendar request failed')
        return response.status === 204 ? null : response.json()
      }
    }
  }
  async function sync() {
    return locked(async (renew) => {
      const connection = await row()
      if (!connection.tokens) throw failure(409, 'Connect Google Calendar first')
      const api = await client(connection)
      const calendar = await api('calendars/primary')
      if (!calendar.id || !calendar.timeZone) throw failure(502, 'Google calendar metadata unavailable')
      if (connection.calendarId && connection.calendarId !== calendar.id) throw failure(409, 'Connected calendar differs from the original calendar')
      await db.googleIntegration.update({ where: { id: 1 }, data: { calendarId: calendar.id } })
      const base = `calendars/${encodeURIComponent(calendar.id)}/events`
      const start = new Date(now() - 30 * DAY).toISOString()
      const end = new Date(now() + 366 * DAY).toISOString()
      const result = { imported: 0, exported: 0, deleted: 0, conflicts: 0, skipped: 0, skippedReasons: {}, window: { start, end }, timeZone: calendar.timeZone, limitations: ['New imports and exports are bounded to 30 days past and 366 days future; existing mappings are checked outside this window.', 'Google recurrence instances and existing local occurrence rows sync individually; recurrence rules and local recurrence roots are not synced or generated.', 'Deadlines, non-default Google event types, sub-minute times, and unsafe recurrence-root changes are skipped. Card due dates are not synced.', 'Only title, description, dates, times and timezone sync. Google attendees, reminders, location and other metadata are preserved by PATCH, not imported.'] }
      const skip = (reason) => { result.skipped++; result.skippedReasons[reason] = (result.skippedReasons[reason] || 0) + 1 }
      const remotes = new Map()
      let pageToken
      do {
        await renew()
        const query = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', timeMin: start, timeMax: end, maxResults: '2500', ...(pageToken && { pageToken }) })
        const page = await api(`${base}?${query}`)
        for (const event of page.items || []) remotes.set(event.id, event)
        pageToken = page.nextPageToken
        if (remotes.size > 20000) throw failure(422, 'Calendar window exceeds 20000 instances')
      } while (pageToken)
      // Capture local state before network writes. Transactions recheck this state before applying remote changes.
      const locals = await db.event.findMany()
      const localById = new Map(locals.map((event) => [event.id, event]))
      let mappings = await db.googleEventMapping.findMany({ where: { calendarId: calendar.id } })
      const mappedIds = new Set(mappings.map((mapping) => mapping.eventId))
      for (const event of locals) {
        if (mappedIds.has(event.id)) continue
        if (event.eventDate < start.slice(0, 10) || event.eventDate >= end.slice(0, 10)) continue
        if (!localEvent(event, calendar.timeZone)) { skip('unsupportedLocalEvent'); continue }
        // Persist a random Google-compatible ID before insertion, so uncertain writes can be retried safely.
        const mapping = await db.googleEventMapping.create({ data: { calendarId: calendar.id, remoteId: randomBytes(20).toString('hex'), eventId: event.id, pending: snapshot(event) } })
        mappings.push(mapping)
      }
      async function getRemote(id) {
        try { return await api(`${base}/${encodeURIComponent(id)}`) } catch (error) {
          if (error.status === 404 || error.status === 410) return { id, status: 'cancelled' }
          throw error
        }
      }
      async function applyRemote(mapping, local, remote) {
        const data = remote.status === 'cancelled' ? null : remoteEvent(remote, calendar.timeZone)
        if (remote.status !== 'cancelled' && !data) { skip('unsupportedRemoteEvent'); return }
        if (local && (local.isDeadline || local.recurrence !== 'none')) { skip('unsafeLocalRootOrDeadline'); return }
        await renew()
        await db.$transaction(async (tx) => {
          const current = mapping.eventId ? await tx.event.findUnique({ where: { id: mapping.eventId } }) : null
          if (snapshot(current) !== snapshot(local)) { result.conflicts++; skip('concurrentLocalEdit'); return }
          if (snapshot(local) !== mapping.localSnapshot) result.conflicts++
          if (!data) {
            if (current) { await tx.event.delete({ where: { id: current.id } }); result.deleted++ }
            await tx.googleEventMapping.update({ where: { id: mapping.id }, data: { tombstone: true, pending: null, remoteEtag: remote.etag || null, localSnapshot: snapshot(current) || mapping.localSnapshot || mapping.pending } })
          } else {
            const saved = current ? await tx.event.update({ where: { id: current.id }, data }) : await tx.event.create({ data })
            await tx.googleEventMapping.update({ where: { id: mapping.id }, data: { eventId: saved.id, localSnapshot: snapshot(saved), remoteEtag: remote.etag, pending: null, tombstone: false } })
            result.imported++
          }
        })
      }
      for (const mapping of mappings) {
        await renew()
        const local = localById.get(mapping.eventId) || null
        let remote = remotes.get(mapping.remoteId) || await getRemote(mapping.remoteId)
        remotes.delete(mapping.remoteId)
        if (mapping.tombstone) { if (remote.status !== 'cancelled') await applyRemote(mapping, local, remote); continue }
        if (mapping.remoteEtag && mapping.pending && remote.status !== 'cancelled') {
          // An uncertain PATCH must not turn a newer local edit into a remote-wins conflict.
          // Recover only when the remote synchronized fields still match the attempted write.
          const attempted = JSON.parse(mapping.pending)
          const same = matchesAttempt(remote, attempted, calendar.timeZone)
          if (same) {
            await db.googleEventMapping.update({ where: { id: mapping.id }, data: { remoteEtag: remote.etag, localSnapshot: mapping.pending, pending: null } })
            continue
          }
          if (snapshot(local) !== mapping.pending && remote.etag !== mapping.remoteEtag) { result.conflicts++; skip('uncertainWriteWithNewerLocalEdit'); continue }
        }
        if (!mapping.remoteEtag && mapping.pending) {
          if (remote.status === 'cancelled') {
            if (!local) { await db.googleEventMapping.update({ where: { id: mapping.id }, data: { tombstone: true, localSnapshot: mapping.pending, pending: null } }); continue }
            try { remote = await api(base, { method: 'POST', body: JSON.stringify({ id: mapping.remoteId, ...localEvent(JSON.parse(mapping.pending), calendar.timeZone) }) }) } catch (error) {
              if (error.status !== 409) throw error
              remote = await getRemote(mapping.remoteId)
              if (remote.status === 'cancelled') { skip('remoteIdUnavailable'); continue }
            }
            result.exported++
          }
          if (matchesAttempt(remote, JSON.parse(mapping.pending), calendar.timeZone)) {
            await db.googleEventMapping.update({ where: { id: mapping.id }, data: { remoteEtag: remote.etag, localSnapshot: mapping.pending, pending: null } })
          } else if (snapshot(local) !== mapping.pending) {
            result.conflicts++
            skip('uncertainInsertWithNewerLocalEdit')
          } else {
            await applyRemote({ ...mapping, localSnapshot: mapping.pending }, local, remote)
          }
          continue
        }
        const remoteChanged = remote.status === 'cancelled' || remote.etag !== mapping.remoteEtag
        if (remoteChanged) { await applyRemote(mapping, local, remote); continue }
        if (snapshot(local) === mapping.localSnapshot) continue
        if (local && !localEvent(local, calendar.timeZone)) { skip('unsupportedLocalEvent'); continue }
        try {
          if (!local) {
            await api(`${base}/${encodeURIComponent(mapping.remoteId)}`, { method: 'DELETE', headers: { 'If-Match': remote.etag } })
            await db.googleEventMapping.update({ where: { id: mapping.id }, data: { tombstone: true, pending: null } })
            result.deleted++
          } else {
            await db.googleEventMapping.update({ where: { id: mapping.id }, data: { pending: snapshot(local) } })
            const written = await api(`${base}/${encodeURIComponent(mapping.remoteId)}`, { method: 'PATCH', headers: { 'If-Match': remote.etag }, body: JSON.stringify(localEvent(local, calendar.timeZone)) })
            await db.googleEventMapping.update({ where: { id: mapping.id }, data: { remoteEtag: written.etag, localSnapshot: snapshot(local), pending: null } })
            result.exported++
          }
        } catch (error) {
          if (![404, 410, 412].includes(error.status)) throw error
          await applyRemote(mapping, local, await getRemote(mapping.remoteId))
        }
      }
      for (const remote of remotes.values()) {
        if (remote.status === 'cancelled') continue
        const data = remoteEvent(remote, calendar.timeZone)
        if (!data) { skip('unsupportedRemoteEvent'); continue }
        await renew()
        await db.$transaction(async (tx) => {
          const event = await tx.event.create({ data })
          await tx.googleEventMapping.create({ data: { calendarId: calendar.id, remoteId: remote.id, eventId: event.id, remoteEtag: remote.etag, localSnapshot: snapshot(event) } })
        })
        result.imported++
      }
      await renew()
      await db.googleIntegration.update({ where: { id: 1 }, data: { lastSyncedAt: new Date(now()).toISOString() } })
      return result
    })
  }
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (req.method !== 'GET' && ((req.get('origin') && req.get('origin') !== origin) || req.get('sec-fetch-site') === 'cross-site')) return res.status(403).json({ error: 'same-origin request required' })
    next()
  })
  router.get('/status', async (_req, res) => {
    const connection = await row()
    res.json({ configured, connected: Boolean(configured && connection.tokens), lastSyncedAt: connection.lastSyncedAt })
  })
  router.use((req, res, next) => configured ? next() : req.path === '/callback' ? res.redirect('/?google_calendar=error') : res.status(503).json({ error: 'Google Calendar is not configured' }))
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }
  router.post('/connect', async (_req, res) => {
    const state = randomBytes(32).toString('base64url')
    await row()
    await db.googleIntegration.update({ where: { id: 1 }, data: { oauthState: hash(state), oauthExpiresAt: now() + 600000 } })
    res.cookie(COOKIE, state, { ...cookieOptions, maxAge: 600000 })
    const query = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly', access_type: 'offline', prompt: 'consent', state })
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` })
  })
  router.get('/callback', async (req, res) => {
    res.clearCookie(COOKIE, cookieOptions)
    try {
      const cookie = (req.get('cookie') || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
      if (!equal(req.query.state, cookie) || typeof req.query.code !== 'string' || req.query.error) throw new Error('invalid callback')
      await locked(async () => {
        const consumed = await db.googleIntegration.updateMany({ where: { id: 1, oauthState: hash(cookie), oauthExpiresAt: { gt: now() } }, data: { oauthState: null, oauthExpiresAt: null } })
        if (!consumed.count) throw new Error('expired state')
        const tokens = await tokenRequest({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri })
        if (!tokens.refresh_token) throw new Error('offline consent required')
        const api = await client({ tokens: cipher.encrypt(tokens) })
        const calendar = await api('calendars/primary')
        const connection = await row()
        if (!calendar.id || connection.calendarId && connection.calendarId !== calendar.id) throw new Error('different calendar')
        await db.googleIntegration.update({ where: { id: 1 }, data: { tokens: cipher.encrypt(tokens), calendarId: calendar.id } })
      })
      res.redirect('/?google_calendar=connected')
    } catch { res.redirect('/?google_calendar=error') }
  })
  router.post('/sync', async (_req, res) => res.json(await sync()))
  router.post('/disconnect', async (_req, res) => {
    await locked(async () => db.googleIntegration.update({ where: { id: 1 }, data: { tokens: null, oauthState: null, oauthExpiresAt: null } }))
    res.clearCookie(COOKIE, cookieOptions)
    res.json({ disconnected: true })
  })
  router.use((error, _req, res, _next) => res.status([401, 409, 422].includes(error.status) ? error.status : 502).json({ error: 'Google Calendar operation failed; retry or reconnect', retryable: true }))
  return { router, sync }
}
