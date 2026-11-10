import { useMemo, useRef, useState, type FormEvent } from 'react'
import { commentPayload, messageOf, notifyChanged, request, send, useLiveData, type EventDetail, type EventItem, type LinkOptions, type Recurrence } from '../api'
import { addDays, parseDate } from '../dates'
import { confirmAction, toast, toastError, useRecords } from '../overlays'
import { Comments } from './Comments'
import { DescriptionEditor } from './DescriptionEditor'
import { ColorPicker, EditableText, RepeatField } from './fields'
import { CloseButton, Modal } from './Modal'

type Schedule = { date: string; allDay: boolean; startTime: string; endDate: string; endTime: string; timeZone: string; recurrence: Recurrence; interval: number }

/** The form shows an all-day end as the last day included; the server stores the day after. */
function scheduleOf(item: EventItem): Schedule {
  return {
    date: item.event_date,
    allDay: item.all_day,
    startTime: item.event_time,
    endTime: item.end_time,
    endDate: item.all_day ? addDays(item.end_date ?? addDays(item.event_date, 1), -1) : item.end_date ?? item.event_date,
    timeZone: item.time_zone ?? '',
    recurrence: item.recurrence,
    interval: item.recurrence_interval,
  }
}
function problemWith(schedule: Schedule, deadline: boolean) {
  if (!schedule.date) return 'Choose a date.'
  if (deadline) return schedule.startTime ? '' : 'Choose a time.'
  if (!schedule.endDate) return 'Choose an end date.'
  if (schedule.allDay ? schedule.endDate < schedule.date : `${schedule.endDate}T${schedule.endTime}` <= `${schedule.date}T${schedule.startTime}`) return 'The end must be after the start.'
  if (schedule.recurrence !== 'none' && (schedule.allDay || schedule.endDate !== schedule.date)) return 'Repeating events can’t be all-day or span several days.'
  return ''
}
const dayShift = (from: string, to: string) => Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000)

export function EventDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const records = useRecords()
  const [detail, setDetail] = useState<EventDetail | null>(null)
  const [options, setOptions] = useState<LinkOptions | null>(null)
  const [draft, setDraft] = useState<Schedule | null>(null)
  const [seen, setSeen] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const latest = useRef(0)
  const gone = useRef(false)
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone') } catch { return [] } }, [])
  const notebookOptions = useMemo(() => options && { notebooks: options.notebooks, events: [] }, [options])

  async function load() {
    // Once deleted there is nothing left to refresh.
    if (gone.current) return
    const ticket = ++latest.current
    try {
      const event = await request<EventDetail>(`/api/events/${id}`)
      if (ticket === latest.current) setDetail(event)
    } catch (cause) {
      if (ticket === latest.current && !detail) { toastError(messageOf(cause, 'Could not open that event.')); onClose() }
    }
  }
  useLiveData(() => {
    void load()
    if (!options) request<LinkOptions>('/api/link-options').then(setOptions).catch(() => {})
  }, true, id)

  const server = detail ? scheduleOf(detail) : null
  const signature = JSON.stringify(server)
  // Adopt the saved schedule whenever it changes on the server; edits in progress stay local until Save.
  if (signature !== seen) { setSeen(signature); setDraft(server) }

  if (!detail || !draft) return <Modal className="modal-record" onClose={onClose} label="Event"><div className="record record-loading"><p role="status">Opening event…</p><CloseButton onClick={onClose} /></div></Modal>

  const deadline = Boolean(detail.is_deadline)
  const occurrence = detail.recurrence_parent_id !== null
  const noun = deadline ? 'deadline' : 'event'
  const dirty = JSON.stringify(draft) !== signature
  const problem = dirty ? problemWith(draft, deadline) : ''
  const edit = (changes: Partial<Schedule>) => setDraft({ ...draft, ...changes })

  async function save(changes: Record<string, unknown>, fallback: string) {
    try { await send('PATCH', `/api/events/${id}`, changes); setError(''); return true }
    catch (cause) { setError(messageOf(cause, fallback)); return false }
    finally { notifyChanged() }
  }
  async function saveSchedule(event: FormEvent) {
    event.preventDefault()
    if (!draft || problem || saving) return
    setSaving(true)
    await save({
      eventDate: draft.date,
      eventTime: draft.allDay ? '00:00' : draft.startTime,
      ...(!deadline && { endTime: draft.allDay ? '00:00' : draft.endTime, endDate: draft.allDay ? addDays(draft.endDate, 1) : draft.endDate === draft.date ? null : draft.endDate, allDay: draft.allDay, timeZone: draft.timeZone.trim() || null }),
      ...(!occurrence && { recurrence: draft.recurrence, recurrenceInterval: draft.interval }),
    }, `Could not save the ${noun}.`)
    setSaving(false)
  }
  async function remove() {
    const body = occurrence ? 'Only this occurrence is deleted.' : detail!.recurrence !== 'none' ? 'Every occurrence of this repeating series is deleted.' : 'This can’t be undone.'
    if (!await confirmAction({ title: `Delete “${detail!.title}”?`, body, confirmLabel: `Delete ${noun}` })) return
    try { await send('DELETE', `/api/events/${id}`); gone.current = true; onClose(); notifyChanged(); toast(`${deadline ? 'Deadline' : 'Event'} deleted`) }
    catch (cause) { setError(messageOf(cause, `Could not delete the ${noun}.`)) }
  }

  return <Modal className="modal-record" onClose={onClose} labelledBy="event-title">
    <article className={`record tone-${deadline ? 'deadline' : detail.color}`}>
      <header className="record-header">
        <span className={`kind-mark ${deadline ? 'kind-deadline' : ''}`} aria-hidden="true" />
        <div className="record-heading">
          <EditableText id="event-title" className="record-title" value={detail.title} label={`${deadline ? 'Deadline' : 'Event'} title`} onCommit={(title) => void save({ title }, `Could not rename the ${noun}.`)} />
          <p className="record-kind">
            {deadline ? 'Deadline' : 'Event'}
            {occurrence && <> · one of a repeating series <button type="button" className="text-button" onClick={() => records.open({ type: 'event', id: detail.recurrence_parent_id! })}>Edit the series</button></>}
            {detail.card_id != null && <> · <button type="button" className="text-button" onClick={() => records.open({ type: 'card', id: detail.card_id! })}>Open its task</button></>}
          </p>
        </div>
        <CloseButton onClick={onClose} label={`Close ${noun}`} />
      </header>
      {error && <p className="inline-error" role="alert">{error}</p>}

      <form className="properties" onSubmit={(event) => void saveSchedule(event)}>
        <div className="property"><label htmlFor="event-start">{deadline ? 'Due' : 'Starts'}</label><div>
          <input id="event-start" type="date" required value={draft.date} onChange={(event) => { const date = event.target.value; edit({ date, ...(date && draft.date && { endDate: addDays(draft.endDate, dayShift(draft.date, date)) }) }) }} />
          {!draft.allDay && <input type="time" required value={draft.startTime} aria-label={deadline ? 'Due time' : 'Start time'} onChange={(event) => edit({ startTime: event.target.value })} />}
          {!deadline && <label className="check-label"><input type="checkbox" checked={draft.allDay} onChange={(event) => edit({ allDay: event.target.checked, ...(!event.target.checked && draft.startTime === draft.endTime && { startTime: '09:00', endTime: '10:00' }), ...(event.target.checked && { recurrence: 'none' as Recurrence }) })} />All day</label>}
        </div></div>
        {!deadline && <div className="property"><label htmlFor="event-end">Ends</label><div>
          <input id="event-end" type="date" required value={draft.endDate} min={draft.date} onChange={(event) => edit({ endDate: event.target.value })} />
          {!draft.allDay && <input type="time" required value={draft.endTime} aria-label="End time" onChange={(event) => edit({ endTime: event.target.value })} />}
        </div></div>}
        {!occurrence && <div className="property"><span className="property-label">Repeat</span><div>
          <RepeatField recurrence={draft.recurrence} interval={draft.interval} disabled={!deadline && (draft.allDay || draft.endDate !== draft.date)} onChange={(recurrence, interval) => edit({ recurrence, interval })} />
          {!deadline && (draft.allDay || draft.endDate !== draft.date) && <small className="field-hint">Only single-day timed events can repeat.</small>}
        </div></div>}
        {!deadline && <div className="property"><label htmlFor="event-zone">Time zone</label><div>
          <input id="event-zone" list="time-zones" value={draft.timeZone} placeholder="Calendar default" onChange={(event) => edit({ timeZone: event.target.value })} />
          <datalist id="time-zones">{zones.map((zone) => <option value={zone} key={zone} />)}</datalist>
        </div></div>}
        {!deadline && <div className="property"><span className="property-label">Color</span><div>
          <ColorPicker value={detail.color} onChange={(color) => { setDetail({ ...detail, color }); void save({ color }, 'Could not change the color.') }} />
        </div></div>}
        {dirty && <div className="property property-actions"><span /><div>
          <button type="submit" className="button button-primary" disabled={Boolean(problem) || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="button" onClick={() => setDraft(server)}>Discard</button>
          {problem && <span className="inline-error" role="alert">{problem}</span>}
        </div></div>}
      </form>

      <section className="record-section">
        <h3>Description</h3>
        <DescriptionEditor value={detail.description} label={`${deadline ? 'Deadline' : 'Event'} description`} options={notebookOptions} onSave={(description) => void save({ description }, 'Could not save the description.')} />
      </section>

      <section className="record-section">
        <h3>Comments{detail.comments.length > 0 && <span>{detail.comments.length}</span>}</h3>
        <Comments comments={detail.comments} onPost={async (comment) => { await send('POST', `/api/events/${id}/comments`, commentPayload(comment)); notifyChanged() }} />
      </section>

      <footer className="record-footer">
        <span />
        <button type="button" className="text-button text-danger" onClick={() => void remove()}>Delete {noun}</button>
      </footer>
    </article>
  </Modal>
}
