import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { messageOf, notifyChanged, request } from '../api'
import { readableDate, readableTimestamp } from '../dates'
import { toast, toastError } from '../overlays'
import { CloseButton, Modal } from './Modal'

type GoogleStatus = { configured: boolean; connected: boolean; lastSyncedAt: string | null }
type GoogleResult = { imported: number; exported: number; deleted: number; conflicts: number; skipped: number; skippedReasons: Record<string, number>; limitations: string[]; window: { start: string; end: string }; timeZone: string }
type Action = 'connect' | 'sync' | 'disconnect'
const ATTEMPT_KEY = 'google-calendar-sync-attempt'

/** A quiet status button in the calendar header; the details and controls live in a dialog behind it. */
export function GoogleSync({ active }: { active: boolean }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [busy, setBusy] = useState<Action | ''>('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<GoogleResult | null>(null)
  const [open, setOpen] = useState(false)
  const pending = useRef(false)
  const statusRequest = useRef(0)
  const lastAttempt = useRef(0)

  async function loadStatus() {
    const ticket = ++statusRequest.current
    try {
      const next = await request<GoogleStatus>('/api/integrations/google/status')
      if (ticket === statusRequest.current) setStatus(next)
      return next
    } catch { return null }
  }
  async function act(action: Action) {
    if (pending.current) return
    pending.current = true
    // Recorded before the request so failed attempts and manual syncs also delay the next automatic one.
    if (action === 'sync') {
      lastAttempt.current = Date.now()
      try { window.localStorage.setItem(ATTEMPT_KEY, String(lastAttempt.current)) } catch { /* Storage can be blocked; the in-memory value still throttles. */ }
    }
    setBusy(action); setError('')
    try {
      if (action === 'connect') {
        const { url } = await request<{ url: string }>('/api/integrations/google/connect', { method: 'POST' })
        window.location.assign(url)
      } else if (action === 'sync') {
        setResult(await request<GoogleResult>('/api/integrations/google/sync', { method: 'POST' }))
      } else {
        await request('/api/integrations/google/disconnect', { method: 'POST' })
        setResult(null)
        toast('Google Calendar disconnected. Your events are kept.')
      }
    } catch (cause) {
      setError(`${messageOf(cause, 'Google Calendar did not respond')}${action === 'sync' ? ' Some changes may already have been applied — sync again to finish.' : ''}`)
    } finally {
      // A failed sync can still have committed changes on either side.
      if (action === 'sync') notifyChanged()
      await loadStatus()
      pending.current = false; setBusy('')
    }
  }
  const autoSync = useEffectEvent(async (isCurrent: () => boolean) => {
    if (pending.current || document.visibilityState !== 'visible') return
    const next = await loadStatus()
    if (!isCurrent() || document.visibilityState !== 'visible' || !next?.configured || !next.connected || pending.current) return
    let attemptedAt = lastAttempt.current
    try {
      const stored = Number(window.localStorage.getItem(ATTEMPT_KEY))
      if (Number.isFinite(stored)) attemptedAt = Math.max(attemptedAt, stored)
    } catch { /* In-memory throttling still works without storage. */ }
    const syncedAt = Date.parse(next.lastSyncedAt || '')
    if (Date.now() - Math.max(attemptedAt, Number.isFinite(syncedAt) ? syncedAt : 0) < 120_000) return
    await act('sync')
  })
  useEffect(() => {
    if (!active) return
    let current = true
    let checking = false
    const refresh = async () => {
      if (checking) return
      checking = true
      try { await autoSync(() => current) } finally { checking = false }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { current = false; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [active])
  // Returning from Google's consent screen.
  useEffect(() => {
    const url = new URL(window.location.href)
    const callback = url.searchParams.get('google_calendar')
    if (!callback) return
    if (callback === 'connected') toast('Google Calendar connected. It syncs whenever you open the calendar.')
    else toastError('Google Calendar could not be connected. Try again with the same Google account.')
    url.searchParams.delete('google_calendar')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const synced = status?.lastSyncedAt ? readableTimestamp(status.lastSyncedAt) : ''
  const summary = busy === 'sync' ? 'Syncing…' : error ? 'Sync problem' : !status?.configured ? 'Google Calendar' : status.connected ? (synced ? `Synced ${synced.toLowerCase()}` : 'Google connected') : 'Connect Google'
  const tone = error ? 'problem' : status?.connected ? 'on' : 'off'

  return <>
    <button type="button" className={`sync-status sync-${tone}`} onClick={() => setOpen(true)} aria-haspopup="dialog"><span className="sync-dot" aria-hidden="true" />{summary}</button>
    {open && <Modal className="modal-form" onClose={() => setOpen(false)} labelledBy="google-title">
      <div className="form google-panel" aria-busy={Boolean(busy)}>
        <header className="form-header"><h2 id="google-title">Google Calendar</h2><CloseButton onClick={() => setOpen(false)} /></header>
        <p className="google-state">
          {!status ? 'Checking the connection…'
            : !status.configured ? 'Google Calendar isn’t set up on this server yet. Add the Google credentials to the backend to enable two-way sync.'
            : status.connected ? `Connected to your primary calendar. ${synced ? `Last synced ${synced.toLowerCase()}.` : 'Not synced yet.'}`
            : 'Connect to sync events and deadlines with your primary Google calendar, in both directions.'}
        </p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {result && <dl className="sync-result">
          {([['Imported', result.imported], ['Exported', result.exported], ['Deleted', result.deleted], ['Conflicts', result.conflicts], ['Skipped', result.skipped]] as const).map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count}</dd></div>)}
        </dl>}
        {status?.configured && <div className="form-actions form-actions-start">
          {status.connected
            ? <><button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => void act('sync')}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
              <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('connect')}>Reconnect</button>
              <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('disconnect')}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button></>
            : <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => void act('connect')}>{busy === 'connect' ? 'Opening Google…' : 'Connect Google Calendar'}</button>}
        </div>}
        <details className="fine-print">
          <summary>How sync works</summary>
          <ul>
            <li>Syncs when you open the calendar or come back to this tab, at most every 2 minutes. “Sync now” skips the wait.</li>
            <li>If the same event changed on both sides, Google’s version wins.</li>
            <li>Covers events from 30 days back to a year ahead; events already linked keep syncing outside that range.</li>
            <li>Deadlines appear in Google as one-minute events. Moving or deleting one updates the matching task’s due date.</li>
            <li>Repeat rules don’t sync: each occurrence syncs as its own event. Move a repeating deadline here, not in Google.</li>
            <li>Disconnecting keeps your events. Reconnect with the same Google account to resume.</li>
          </ul>
          {result && <>
            <p>Last run covered {readableDate(result.window.start.slice(0, 10))} to {readableDate(result.window.end.slice(0, 10))} ({result.timeZone}).</p>
            {Object.entries(result.skippedReasons).map(([reason, count]) => <p key={reason}>Skipped, {reason.replace(/([A-Z])/g, ' $1').toLowerCase()}: {count}</p>)}
            {result.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
          </>}
        </details>
      </div>
    </Modal>}
  </>
}
