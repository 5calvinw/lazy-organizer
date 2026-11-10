import { useEffect, useRef, useState } from 'react'
import { messageOf, notifyChanged, request, send, useLiveData, type EventItem } from '../api'
import { GoogleSync } from '../components/GoogleSync'
import { CloseButton, Modal } from '../components/Modal'
import { NewEventDialog } from '../components/NewEventDialog'
import { addDays, isoDate, parseDate, readableTime } from '../dates'
import { toastError, useRecords } from '../overlays'

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const compactTime = (value: string) => readableTime(value).replace(':00', '').replace(/\s?([AP]M)/i, (_, half: string) => half.toLowerCase())
const dayShift = (from: string, to: string) => Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000)
const isPhone = () => window.matchMedia('(max-width: 760px)').matches

/** An event belongs to a day it starts on, covers, or ends in (an all-day end date is the first day not included). */
function occursOn(item: EventItem, date: string) {
  if (item.event_date === date) return true
  if (item.event_date > date || !item.end_date) return false
  return item.end_date > date || (item.end_date === date && !item.all_day && item.end_time > '00:00')
}

function EventChip({ item, date, onOpen, draggable = false }: { item: EventItem; date: string; onOpen: (item: EventItem) => void; draggable?: boolean }) {
  const continues = date !== item.event_date
  const kind = item.is_deadline ? 'deadline' : item.all_day ? 'allday' : 'timed'
  return <div
    className={`chip chip-${kind} tone-${item.is_deadline ? 'deadline' : item.color}`}
    role="button"
    tabIndex={0}
    draggable={draggable}
    onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-organizer-event', String(item.id)) }}
    onClick={(event) => { event.stopPropagation(); onOpen(item) }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) } }}
  >
    {kind === 'timed' && <time dateTime={`${date}T${continues ? '00:00' : item.event_time}`}>{continues ? '…' : compactTime(item.event_time)}</time>}
    <span>{item.is_deadline ? <span className="sr-only">Deadline: </span> : item.all_day ? <span className="sr-only">All day: </span> : null}{item.title}</span>
  </div>
}

export function Calendar({ active }: { active: boolean }) {
  const records = useRecords()
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1) })
  const [events, setEvents] = useState<EventItem[]>([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [selected, setSelected] = useState(() => isoDate(new Date()))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dropDate, setDropDate] = useState<string | null>(null)
  const [capacity, setCapacity] = useState(3)
  const gridRef = useRef<HTMLDivElement>(null)
  const latest = useRef(0)
  const today = isoDate(new Date())
  const monthKey = isoDate(month).slice(0, 7)

  async function load() {
    const ticket = ++latest.current
    try {
      const loaded = await request<EventItem[]>(`/api/events?month=${monthKey}`)
      if (ticket === latest.current) { setEvents(loaded); setError('') }
    } catch (cause) { if (ticket === latest.current) setError(messageOf(cause, 'Could not load the calendar.')) }
  }
  useLiveData(() => void load(), active, monthKey)

  const firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))
  const lastOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const weeks = Math.ceil((dayShift(isoDate(firstCell), isoDate(lastOfMonth)) + 1) / 7)
  const days = Array.from({ length: weeks * 7 }, (_, index) => new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index))

  // How many event rows fit in a day cell at the current size; the rest collapse into "+N more".
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => setCapacity(Math.max(1, Math.floor((grid.clientHeight / weeks - 34) / 23)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [weeks, active])

  function show(next: Date) {
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1))
  }
  function goToday() {
    show(new Date()); setSelected(today)
  }
  const openItem = (item: EventItem) => records.open(item.card_id != null ? { type: 'card', id: item.card_id } : { type: 'event', id: item.id })
  async function moveEvent(id: number, date: string) {
    const item = events.find((event) => event.id === id)
    if (!item || item.event_date === date) return
    const endDate = item.end_date ? addDays(item.end_date, dayShift(item.event_date, date)) : null
    setEvents(events.map((event) => event.id === id ? { ...event, event_date: date, end_date: endDate } : event))
    try { await send('PATCH', `/api/events/${id}`, { eventDate: date, endDate }) }
    catch (cause) { toastError(messageOf(cause, 'Could not move that.')) }
    finally { notifyChanged() }
  }
  const eventsOn = (date: string) => events.filter((item) => occursOn(item, date)).sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.event_date < date ? '00:00' : a.event_time).localeCompare(b.event_date < date ? '00:00' : b.event_time))
  const longDate = (date: string) => parseDate(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const title = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const selectedEvents = eventsOn(selected)

  return <div className="view calendar">
    <header className="view-header calendar-header">
      <div className="view-heading"><h1>{title}</h1></div>
      <div className="calendar-tools">
        <GoogleSync active={active} />
        <div className="stepper" role="group" aria-label="Change month">
          <button type="button" className="icon-button" aria-label="Previous month" onClick={() => show(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg></button>
          <button type="button" className="button" onClick={goToday}>Today</button>
          <button type="button" className="icon-button" aria-label="Next month" onClick={() => show(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></button>
        </div>
        <button type="button" className="button button-primary" onClick={() => setAdding(selected.startsWith(monthKey) ? selected : today.startsWith(monthKey) ? today : `${monthKey}-01`)}>New event</button>
      </div>
    </header>
    {error && <p className="banner-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>}

    <section className="month" aria-label={title}>
      <div className="weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="month-grid" ref={gridRef} style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {days.map((day) => {
          const date = isoDate(day)
          const dayEvents = eventsOn(date)
          const shown = dayEvents.length > capacity ? dayEvents.slice(0, Math.max(0, capacity - 1)) : dayEvents
          const hidden = dayEvents.length - shown.length
          const classes = ['day', day.getMonth() !== month.getMonth() && 'is-outside', date === today && 'is-today', date === selected && 'is-selected', date === dropDate && 'is-drop', (day.getDay() === 0 || day.getDay() === 6) && 'is-weekend'].filter(Boolean).join(' ')
          return <div
            className={classes}
            key={date}
            onClick={() => { setSelected(date); if (!isPhone()) setAdding(date) }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-organizer-event')) { event.preventDefault(); if (dropDate !== date) setDropDate(date) } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDate((current) => current === date ? null : current) }}
            onDrop={(event) => { event.preventDefault(); setDropDate(null); void moveEvent(Number(event.dataTransfer.getData('application/x-organizer-event')), date) }}
          >
            <button type="button" className="day-number" aria-label={`${longDate(date)}, ${dayEvents.length} ${dayEvents.length === 1 ? 'item' : 'items'}. Add an event`} aria-current={date === today ? 'date' : undefined} onClick={(event) => { event.stopPropagation(); setSelected(date); if (!isPhone()) setAdding(date) }}>{day.getDate()}</button>
            <div className="day-events">
              {shown.map((item) => <EventChip key={item.id} item={item} date={date} onOpen={openItem} draggable />)}
              {hidden > 0 && <button type="button" className="day-more" onClick={(event) => { event.stopPropagation(); setExpanded(date) }}>+{hidden} more</button>}
            </div>
            {dayEvents.length > 0 && <div className="day-dots" aria-hidden="true">{dayEvents.slice(0, 4).map((item) => <i key={item.id} className={`tone-${item.is_deadline ? 'deadline' : item.color}`} />)}</div>}
          </div>
        })}
      </div>
    </section>

    <section className="day-agenda" aria-label={longDate(selected)}>
      <header><h2>{longDate(selected)}</h2><button type="button" className="text-button" onClick={() => setAdding(selected)}>Add event</button></header>
      {selectedEvents.length ? <div className="day-list">{selectedEvents.map((item) => <EventChip key={item.id} item={item} date={selected} onOpen={openItem} />)}</div> : <p className="empty">Nothing planned.</p>}
    </section>

    {expanded && <Modal className="modal-form" onClose={() => setExpanded(null)} labelledBy="day-title">
      <div className="form">
        <header className="form-header"><h2 id="day-title">{longDate(expanded)}</h2><CloseButton onClick={() => setExpanded(null)} /></header>
        <div className="day-list">{eventsOn(expanded).map((item) => <EventChip key={item.id} item={item} date={expanded} onOpen={(event) => { setExpanded(null); openItem(event) }} />)}</div>
        <footer className="form-actions"><button type="button" className="button" onClick={() => { setAdding(expanded); setExpanded(null) }}>Add event</button></footer>
      </div>
    </Modal>}
    {adding && <NewEventDialog date={adding} onClose={() => setAdding(null)} />}
  </div>
}
