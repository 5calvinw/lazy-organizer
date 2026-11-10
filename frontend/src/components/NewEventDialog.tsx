import { useState, type FormEvent } from 'react'
import { messageOf, notifyChanged, send, type OrganizerColor, type Recurrence } from '../api'
import { addDays } from '../dates'
import { ColorPicker, RepeatField, Segmented } from './fields'
import { CloseButton, Modal } from './Modal'

type Kind = 'event' | 'deadline'
const kinds: Array<{ value: Kind; label: string }> = [{ value: 'event', label: 'Event' }, { value: 'deadline', label: 'Deadline' }]

/** Mounted only while open, so every visit starts from a clean form. */
export function NewEventDialog({ date, kind: initialKind = 'event', onClose }: { date: string; kind?: Kind; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(date)
  const [end, setEnd] = useState(date)
  const [allDay, setAllDay] = useState(false)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [interval, setEvery] = useState(1)
  const [color, setColor] = useState<OrganizerColor>('blue')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const deadline = kind === 'deadline'
  const canRepeat = deadline || (!allDay && end === start)
  const problem = !start ? 'Choose a date.'
    : deadline ? ''
    : allDay ? (end < start ? 'The end must not be before the start.' : '')
    : `${end}T${endTime}` <= `${start}T${startTime}` ? 'The end must be after the start.' : ''

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !title.trim()) return
    if (problem) { setError(problem); return }
    setBusy(true)
    const repeat = canRepeat ? { recurrence, recurrenceInterval: interval } : { recurrence: 'none', recurrenceInterval: 1 }
    try {
      if (deadline) await send('POST', '/api/deadlines', { title: title.trim(), eventDate: start, eventTime: startTime, ...repeat })
      else await send('POST', '/api/events', { title: title.trim(), eventDate: start, eventTime: allDay ? '00:00' : startTime, endTime: allDay ? '00:00' : endTime, endDate: allDay ? addDays(end, 1) : end === start ? null : end, allDay, color, ...repeat })
      notifyChanged()
      onClose()
    } catch (cause) { setError(messageOf(cause, `Could not add the ${kind}.`)); setBusy(false) }
  }

  return <Modal className="modal-form" onClose={onClose} labelledBy="new-event-title">
    <form className="form" onSubmit={(event) => void submit(event)}>
      <header className="form-header"><h2 id="new-event-title">New {kind}</h2><CloseButton onClick={onClose} label="Cancel" /></header>
      <input className="form-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={deadline ? 'What is due?' : 'What are you planning?'} aria-label="Title" required data-autofocus />
      <Segmented label="Kind" value={kind} options={kinds} onChange={setKind} />
      <div className="properties">
        <div className="property"><label htmlFor="new-start">{deadline ? 'Due' : 'Starts'}</label><div>
          <input id="new-start" type="date" required value={start} onChange={(event) => { setStart(event.target.value); if (end < event.target.value || end === start) setEnd(event.target.value) }} />
          {(deadline || !allDay) && <input type="time" required value={startTime} aria-label={deadline ? 'Due time' : 'Start time'} onChange={(event) => { setStartTime(event.target.value); if (!deadline && end === start && event.target.value >= endTime) { const [hours, minutes] = event.target.value.split(':').map(Number); setEndTime(`${String(Math.min(23, hours + 1)).padStart(2, '0')}:${String(hours === 23 ? 59 : minutes).padStart(2, '0')}`) } }} />}
          {!deadline && <label className="check-label"><input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.target.checked)} />All day</label>}
        </div></div>
        {!deadline && <div className="property"><label htmlFor="new-end">Ends</label><div>
          <input id="new-end" type="date" required value={end} min={start} onChange={(event) => setEnd(event.target.value)} />
          {!allDay && <input type="time" required value={endTime} aria-label="End time" onChange={(event) => setEndTime(event.target.value)} />}
        </div></div>}
        <div className="property"><span className="property-label">Repeat</span><div>
          <RepeatField recurrence={canRepeat ? recurrence : 'none'} interval={interval} disabled={!canRepeat} onChange={(next, every) => { setRecurrence(next); setEvery(every) }} />
          {!canRepeat && <small className="field-hint">Only single-day timed events can repeat.</small>}
        </div></div>
        {!deadline && <div className="property"><span className="property-label">Color</span><div><ColorPicker value={color} onChange={setColor} /></div></div>}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="form-actions">
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Adding…' : `Add ${kind}`}</button>
      </footer>
    </form>
  </Modal>
}
