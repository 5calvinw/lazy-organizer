import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { completeWithUndo, reopen } from '../actions'
import { messageOf, notifyChanged, organizerColors, request, send, useLiveData, type Card, type EventItem, type List, type OrganizerColor } from '../api'
import {
  activeFilterCount,
  buildCalendarIndex,
  dedupeEvents,
  defaultFilter,
  stepAnchorDate,
  visibleRange,
  type AgendaSpan,
  type CalendarEntry,
  type CalendarFilter,
  type CalendarViewMode,
  type ItemKind,
} from '../calendarModel'
import { Dropdown } from '../components/Dropdown'
import { CheckCircle } from '../components/fields'
import { GoogleSync } from '../components/GoogleSync'
import { CloseButton, Modal } from '../components/Modal'
import { NewEventDialog } from '../components/NewEventDialog'
import { addDays, addMonths, dayShift, formatFullDate, formatWeekday, isIsoDate, isoDate, parseDate, startOfWeek } from '../dates'
import { toastError, useRecords } from '../overlays'

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const viewTabs: Array<{ value: CalendarViewMode; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
  { value: 'agenda', label: 'Agenda' },
]
const agendaSpans: Array<{ value: AgendaSpan; label: string; short: string }> = [
  { value: 'month', label: 'Full month', short: 'Month' },
  { value: '7d', label: 'Next 7 days', short: '7 days' },
  { value: '14d', label: 'Next 14 days', short: '14 days' },
  { value: '30d', label: 'Next 30 days', short: '30 days' },
]
const kindOptions: Array<{ value: 'all' | ItemKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'event', label: 'Events' },
  { value: 'task', label: 'Tasks' },
  { value: 'deadline', label: 'Deadlines' },
]
const VIEW_KEY = 'lazy-organizer-calendar-view'
const EVENT_DRAG = 'application/x-organizer-event'
const CARD_DRAG = 'application/x-organizer-card'

const isPhone = () => window.matchMedia('(max-width: 760px)').matches

function readSavedView(): CalendarViewMode {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY)
    if (saved === 'month' || saved === 'week' || saved === 'day' || saved === 'agenda') return saved
  } catch { /* Storage can be unavailable; default to agenda. */ }
  return 'agenda'
}

function TaskCircleIcon({ completed = false }: { completed?: boolean }) {
  return <svg className="cal-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="5.75" />
    {completed && <path d="m5.4 8.2 1.8 1.8 3.4-3.7" />}
  </svg>
}

function EventFlagIcon() {
  return <svg className="cal-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 2.5v11M3.5 3.25h8.25l-1.9 2.65 1.9 2.65H3.5" />
  </svg>
}

function DeadlineDiamondIcon() {
  return <svg className="cal-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.4 13.6 8 8 13.6 2.4 8Z" />
  </svg>
}

function EntryIcon({ entry }: { entry: CalendarEntry }) {
  if (entry.kind === 'task') return <TaskCircleIcon completed={entry.completed} />
  if (entry.kind === 'deadline') return <DeadlineDiamondIcon />
  return <EventFlagIcon />
}

function FilterIcon() {
  return <svg className="cal-btn-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 3.5h11L9.5 8.2v4.3l-3-1.4V8.2Z" />
  </svg>
}

function ChevronDownIcon() {
  return <svg className="cal-btn-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4.25 6.25 3.75 3.75 3.75-3.75" />
  </svg>
}

function entryMeta(entry: CalendarEntry) {
  if (entry.kind === 'task') {
    return [
      entry.completed ? 'Done' : '',
      entry.priority === 'high' || entry.priority === 'medium' ? entry.priority : '',
      entry.card && entry.card.checklist_count > 0 ? `${entry.card.checklist_completed}/${entry.card.checklist_count}` : '',
      entry.repeats ? 'Repeats' : '',
    ].filter(Boolean)
  }
  return [
    entry.spanNote,
    entry.repeats ? 'Repeats' : '',
  ].filter(Boolean)
}

function MonthChip({ entry, onOpen, draggable = false }: { entry: CalendarEntry; onOpen: (entry: CalendarEntry) => void; draggable?: boolean }) {
  const canDrag = draggable && (entry.kind !== 'task' || entry.card !== null)
  const chipClass = entry.kind === 'task'
    ? 'chip-task'
    : entry.kind === 'deadline'
      ? 'chip-deadline'
      : entry.allDay
        ? 'chip-allday'
        : 'chip-timed'
  return <div
    className={`chip ${chipClass} tone-${entry.tone}${entry.completed ? ' is-completed' : ''}`}
    role="button"
    tabIndex={0}
    draggable={canDrag}
    onDragStart={(event) => {
      if (!canDrag) return
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(entry.kind === 'task' ? CARD_DRAG : EVENT_DRAG, String(entry.id))
    }}
    onClick={(event) => { event.stopPropagation(); onOpen(entry) }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(entry) } }}
  >
    <span className="chip-icon" aria-hidden="true"><EntryIcon entry={entry} /></span>
    {!entry.allDay && entry.compactTimeLabel && <time dateTime={`${entry.date}T${entry.sortTime}`}>{entry.compactTimeLabel}</time>}
    <span className="chip-title">
      {entry.kind === 'task' ? <span className="sr-only">Task: </span>
        : entry.kind === 'deadline' ? <span className="sr-only">Deadline: </span>
        : entry.allDay ? <span className="sr-only">All day: </span> : null}
      {entry.title}
    </span>
  </div>
}

function AgendaRow({ entry, onOpen }: { entry: CalendarEntry; onOpen: (entry: CalendarEntry) => void }) {
  const meta = entryMeta(entry)
  const kindClass = `is-${entry.kind}`
  const completedClass = entry.completed ? ' is-completed' : ''

  if (entry.kind === 'task' && entry.card) {
    const card = entry.card
    return <li className={`cal-agenda-row ${kindClass} tone-${entry.tone}${completedClass}`}>
      <div className="cal-agenda-check">
        <CheckCircle
          checked={entry.completed}
          onToggle={() => void (entry.completed ? reopen(card) : completeWithUndo(card))}
          label={entry.completed ? `Reopen ${entry.title}` : `Complete ${entry.title}`}
        />
      </div>
      <button type="button" className="cal-agenda-task-btn" onClick={() => onOpen(entry)}>
        <span className={`cal-agenda-time${entry.allDay ? ' is-allday' : ''}`}>{entry.timeLabel}</span>
        <span className="cal-agenda-title">{entry.title}</span>
        {meta.length > 0 && <span className="cal-agenda-meta">{meta.join(' · ')}</span>}
      </button>
    </li>
  }

  return <li className={`cal-agenda-row ${kindClass} tone-${entry.tone}${completedClass}`}>
    <button type="button" className="cal-agenda-row-btn" onClick={() => onOpen(entry)}>
      <span className="cal-agenda-icon" aria-hidden="true"><EntryIcon entry={entry} /></span>
      <span className={`cal-agenda-time${entry.allDay ? ' is-allday' : ''}`}>
        {entry.allDay ? entry.timeLabel : <time dateTime={`${entry.date}T${entry.sortTime}`}>{entry.timeLabel}</time>}
      </span>
      <span className="cal-agenda-title">{entry.title}</span>
      {meta.length > 0 && <span className="cal-agenda-meta">{meta.join(' · ')}</span>}
    </button>
  </li>
}

export function Calendar({ active }: { active: boolean }) {
  const records = useRecords()
  const today = isoDate(new Date())
  const [view, setView] = useState<CalendarViewMode>(readSavedView)
  const [anchorDate, setAnchorDate] = useState(() => today)
  const [jumpInput, setJumpInput] = useState(() => today)
  const [agendaSpan, setAgendaSpan] = useState<AgendaSpan>('month')
  const [showUnscheduled, setShowUnscheduled] = useState(false)
  const [filter, setFilter] = useState<CalendarFilter>(defaultFilter)
  const [events, setEvents] = useState<EventItem[]>([])
  const [lists, setLists] = useState<List[]>([])
  const [loadedKey, setLoadedKey] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dropDate, setDropDate] = useState<string | null>(null)
  const [highlightedDate, setHighlightedDate] = useState<string | null>(null)
  const [capacity, setCapacity] = useState(3)

  const gridRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dayRefs = useRef<Map<string, HTMLElement>>(new Map())
  const pendingScrollDate = useRef<string | null>(null)
  const latest = useRef(0)

  const range = useMemo(() => visibleRange(view, anchorDate, agendaSpan), [view, anchorDate, agendaSpan])
  const monthsKey = range.months.join(',')

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_KEY, view) } catch { /* Ignore storage failures. */ }
  }, [view])

  async function load() {
    const ticket = ++latest.current
    try {
      const [eventBatches, board] = await Promise.all([
        Promise.all(range.months.map((month) => request<EventItem[]>(`/api/events?month=${month}`))),
        request<List[]>('/api/board'),
      ])
      if (ticket !== latest.current) return
      setEvents(dedupeEvents(eventBatches))
      setLists(board)
      setLoadedKey(monthsKey)
      setError('')
    } catch (cause) {
      if (ticket === latest.current) setError(messageOf(cause, 'Could not load the calendar.'))
    }
  }
  useLiveData(() => void load(), active, monthsKey)
  const loadedOnce = loadedKey !== ''

  const index = useMemo(() => buildCalendarIndex(events, lists), [events, lists])
  const filterCount = activeFilterCount(filter)

  // Month grid geometry
  const anchorMonth = useMemo(() => {
    const parsed = parseDate(anchorDate)
    return new Date(parsed.getFullYear(), parsed.getMonth(), 1)
  }, [anchorDate])
  const monthDays = useMemo(() => {
    const firstCell = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth(), 1 - ((anchorMonth.getDay() + 6) % 7))
    const lastOfMonth = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth() + 1, 0)
    const weeks = Math.ceil((dayShift(isoDate(firstCell), isoDate(lastOfMonth)) + 1) / 7)
    const days = Array.from({ length: weeks * 7 }, (_, idx) => new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + idx))
    return { weeks, days }
  }, [anchorMonth])

  // How many chips fit in a month cell at the current size; the rest collapse into "+N more".
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || view !== 'month') return
    const measure = () => setCapacity(Math.max(1, Math.floor((grid.clientHeight / monthDays.weeks - 34) / 23)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [monthDays.weeks, active, view])

  const agendaGroups = useMemo(
    () => (view === 'agenda' ? index.agendaDays(range.start, range.end, filter) : []),
    [view, index, range.start, range.end, filter],
  )
  const unscheduled = useMemo(
    () => (view === 'agenda' && showUnscheduled ? index.unscheduledTasks(filter) : []),
    [view, showUnscheduled, index, filter],
  )
  const weekDates = useMemo(() => {
    const start = startOfWeek(anchorDate)
    return Array.from({ length: 7 }, (_, idx) => addDays(start, idx))
  }, [anchorDate])

  // Scroll to jumped day in Agenda view once items for the target range finish loading.
  useEffect(() => {
    if (view !== 'agenda' || !pendingScrollDate.current || loadedKey !== monthsKey) return
    const target = pendingScrollDate.current
    pendingScrollDate.current = null
    const exact = dayRefs.current.get(target)
    const fallbackKey = agendaGroups.find((group) => group.date >= target)?.date
    const node = exact ?? (fallbackKey ? dayRefs.current.get(fallbackKey) : undefined)
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [view, agendaGroups, anchorDate, loadedKey, monthsKey])

  useEffect(() => {
    if (!highlightedDate) return
    const timer = window.setTimeout(() => setHighlightedDate(null), 2200)
    return () => window.clearTimeout(timer)
  }, [highlightedDate])

  function navigateTo(nextDate: string, { scroll = false } = {}) {
    setAnchorDate(nextDate)
    setJumpInput(nextDate)
    if (scroll) {
      pendingScrollDate.current = nextDate
      setHighlightedDate(nextDate)
    }
  }

  function goToday() {
    navigateTo(today, { scroll: view === 'agenda' })
  }

  function step(direction: -1 | 1) {
    navigateTo(stepAnchorDate(view, anchorDate, agendaSpan, direction))
  }

  function handleJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isIsoDate(jumpInput)) return
    navigateTo(jumpInput, { scroll: view === 'agenda' })
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % viewTabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + viewTabs.length) % viewTabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = viewTabs.length - 1
    else return
    event.preventDefault()
    setView(viewTabs[nextIndex].value)
    tabRefs.current[nextIndex]?.focus()
  }

  const openEntry = (entry: CalendarEntry) => records.open(entry.kind === 'task' ? { type: 'card', id: entry.id } : { type: 'event', id: entry.id })

  async function moveEvent(id: number, date: string) {
    const item = events.find((event) => event.id === id)
    if (!item || item.event_date === date) return
    const endDate = item.end_date ? addDays(item.end_date, dayShift(item.event_date, date)) : null
    setEvents((current) => current.map((event) => event.id === id ? { ...event, event_date: date, end_date: endDate } : event))
    try { await send('PATCH', `/api/events/${id}`, { eventDate: date, endDate }) }
    catch (cause) { toastError(messageOf(cause, 'Could not move that event.')) }
    finally { notifyChanged() }
  }

  async function moveCardDueDate(id: number, date: string) {
    const card = lists.flatMap((list) => list.cards).find((item) => item.id === id)
    if (!card || card.due_date === date) return
    setLists((current) => current.map((list) => ({
      ...list,
      cards: list.cards.map((item) => item.id === id ? { ...item, due_date: date } : item),
    })))
    try { await send('PATCH', `/api/cards/${id}`, { dueDate: date }) }
    catch (cause) { toastError(messageOf(cause, 'Could not move that task.')) }
    finally { notifyChanged() }
  }

  function handleDropOnDate(dataTransfer: DataTransfer, date: string) {
    const eventId = dataTransfer.getData(EVENT_DRAG)
    if (eventId) { void moveEvent(Number(eventId), date); return }
    const cardId = dataTransfer.getData(CARD_DRAG)
    if (cardId) void moveCardDueDate(Number(cardId), date)
  }

  const canAcceptDrop = (types: readonly string[]) => types.includes(EVENT_DRAG) || types.includes(CARD_DRAG)

  const rangeSummary = useMemo(() => {
    const count = dayShift(range.start, range.end) + 1
    let taskCount = 0
    let eventCount = 0
    for (let offset = 0; offset < count; offset += 1) {
      for (const entry of index.entriesOn(addDays(range.start, offset), filter)) {
        if (entry.kind === 'task') taskCount += 1
        else eventCount += 1
      }
    }
    const parts = [
      eventCount > 0 ? `${eventCount} ${eventCount === 1 ? 'event' : 'events'}` : '',
      taskCount > 0 ? `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}` : '',
    ].filter(Boolean)
    return parts.join(' · ') || 'Nothing scheduled'
  }, [range.start, range.end, index, filter])

  const prevLabel = view === 'month' || (view === 'agenda' && agendaSpan === 'month') ? 'Previous month'
    : view === 'week' ? 'Previous week'
    : view === 'day' ? 'Previous day'
    : 'Previous period'
  const nextLabel = view === 'month' || (view === 'agenda' && agendaSpan === 'month') ? 'Next month'
    : view === 'week' ? 'Next week'
    : view === 'day' ? 'Next day'
    : 'Next period'

  const activeSpanInfo = agendaSpans.find((item) => item.value === agendaSpan)!
  const selectedDayEntries = index.entriesOn(anchorDate, filter)
  const dayAllDayEntries = selectedDayEntries.filter((entry) => entry.allDay)
  const dayTimedEntries = selectedDayEntries.filter((entry) => !entry.allDay)

  return <div className={`view calendar${view === 'month' ? ' is-month' : ''}`}>
    <header className="view-header calendar-header">
      <div className="view-heading"><h1>Calendar</h1></div>
      <div className="calendar-tools">
        <GoogleSync active={active} />
        <button type="button" className="button button-primary" onClick={() => setAdding(anchorDate)}>New event</button>
      </div>
    </header>

    <div className="calendar-controls">
      <div className="calendar-tabs" role="tablist" aria-label="Calendar views">
        {viewTabs.map((tab, idx) => <button
          key={tab.value}
          ref={(node) => { tabRefs.current[idx] = node }}
          id={`cal-tab-${tab.value}`}
          type="button"
          role="tab"
          aria-selected={view === tab.value}
          aria-controls="cal-panel"
          tabIndex={view === tab.value ? 0 : -1}
          onClick={() => setView(tab.value)}
          onKeyDown={(event) => handleTabKeyDown(event, idx)}
        >{tab.label}</button>)}
      </div>

      <div className="calendar-toolbar">
        <form className="cal-jump" onSubmit={handleJump}>
          <input
            type="date"
            aria-label="Go to date"
            value={jumpInput}
            onChange={(event) => setJumpInput(event.target.value)}
          />
          <button type="submit" className="button">Go</button>
        </form>

        <Dropdown
          buttonClassName={`button cal-tool-btn${filterCount > 0 ? ' is-active' : ''}`}
          menuClassName="cal-filter-menu"
          role="dialog"
          ariaLabel="Filter calendar items"
          label={<><FilterIcon /><span>Filter</span>{filterCount > 0 && <span className="cal-badge">{filterCount}</span>}</>}
        >{(close) => <div className="cal-filter-panel">
          <div className="cal-filter-group">
            <span className="cal-filter-label">Show</span>
            <div className="cal-filter-pills" role="group" aria-label="Filter by type">
              {kindOptions.map((option) => <button
                key={option.value}
                type="button"
                className={filter.kind === option.value ? 'is-selected' : ''}
                aria-pressed={filter.kind === option.value}
                onClick={() => setFilter((current) => ({ ...current, kind: option.value }))}
              >{option.label}</button>)}
            </div>
          </div>

          <div className="cal-filter-group">
            <span className="cal-filter-label">Color</span>
            <div className="cal-color-filter" role="group" aria-label="Filter by color">
              <button
                type="button"
                className={`cal-color-any${filter.color === 'all' ? ' is-selected' : ''}`}
                aria-pressed={filter.color === 'all'}
                onClick={() => setFilter((current) => ({ ...current, color: 'all' }))}
              >Any</button>
              {organizerColors.map((color: OrganizerColor) => <button
                key={color}
                type="button"
                className={`cal-color-dot tone-${color}${filter.color === color ? ' is-selected' : ''}`}
                title={color === 'gray' ? 'No color' : color}
                aria-label={color === 'gray' ? 'No color' : color}
                aria-pressed={filter.color === color}
                onClick={() => setFilter((current) => ({ ...current, color: current.color === color ? 'all' : color }))}
              />)}
            </div>
          </div>

          <label className="check-label cal-filter-check">
            <input
              type="checkbox"
              checked={filter.showCompleted}
              onChange={(event) => setFilter((current) => ({ ...current, showCompleted: event.target.checked }))}
            />
            Show completed tasks
          </label>

          {filterCount > 0 && <div className="cal-filter-footer">
            <button type="button" className="text-button" onClick={() => { setFilter(defaultFilter); close() }}>Reset filters</button>
          </div>}
        </div>}</Dropdown>

        <Dropdown
          buttonClassName={`button cal-tool-btn${(view === 'agenda' && agendaSpan !== 'month') || showUnscheduled ? ' is-active' : ''}`}
          menuClassName="cal-schedule-menu"
          ariaLabel="Schedule range and shortcuts"
          label={<><span>Schedule{view === 'agenda' && agendaSpan !== 'month' ? `: ${activeSpanInfo.short}` : ''}</span><ChevronDownIcon /></>}
        >{(close) => <>
          <span className="cal-menu-heading">Agenda range</span>
          {agendaSpans.map((span) => <button
            key={span.value}
            type="button"
            role="menuitemradio"
            aria-checked={agendaSpan === span.value}
            className={agendaSpan === span.value ? 'active' : ''}
            onClick={() => { setAgendaSpan(span.value); setView('agenda'); close() }}
          >
            <span>{span.label}</span>
            {agendaSpan === span.value && <small>Active</small>}
          </button>)}

          <span className="cal-menu-heading">Jump to</span>
          <button type="button" role="menuitem" onClick={() => { navigateTo(startOfWeek(today), { scroll: true }); close() }}>
            <span>This week</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { navigateTo(addDays(startOfWeek(today), 7), { scroll: true }); close() }}>
            <span>Next week</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { navigateTo(`${addMonths(today, 1).slice(0, 7)}-01`, { scroll: true }); close() }}>
            <span>Next month</span>
          </button>

          <span className="cal-menu-heading">Tasks without dates</span>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showUnscheduled}
            onClick={() => { setShowUnscheduled((current) => !current); setView('agenda'); close() }}
          >
            <span>{showUnscheduled ? 'Hide unscheduled' : 'Show unscheduled'}</span>
            <small>{index.unscheduledCount}</small>
          </button>
        </>}</Dropdown>
      </div>
    </div>

    <div className="calendar-range">
      <div className="calendar-range-title">
        <h2>{range.heading}</h2>
        <span className="calendar-range-summary">
          {rangeSummary}
          {filterCount > 0 && ' · Filtered'}
        </span>
      </div>
      <div className="stepper" role="group" aria-label="Change date range">
        <button type="button" className="icon-button" aria-label={prevLabel} onClick={() => step(-1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
        </button>
        <button type="button" className="icon-button" aria-label={nextLabel} onClick={() => step(1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
        </button>
        <button type="button" className="button" onClick={goToday}>Today</button>
      </div>
    </div>

    {error && <p className="banner-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>}

    <div id="cal-panel" className="calendar-panel" role="tabpanel" aria-labelledby={`cal-tab-${view}`}>
      {!loadedOnce && !error ? <p className="view-loading" role="status">Loading calendar…</p> : null}

      {view === 'agenda' && loadedOnce && <div className="cal-agenda">
        {agendaGroups.length > 0 ? agendaGroups.map((group) => <section
          key={group.date}
          ref={(node) => {
            if (node) dayRefs.current.set(group.date, node)
            else dayRefs.current.delete(group.date)
          }}
          className={`cal-agenda-day${group.date === today ? ' is-today' : ''}${group.date === highlightedDate ? ' is-highlighted' : ''}`}
          aria-label={`${formatFullDate(group.date)}, ${formatWeekday(group.date)}`}
        >
          <header className="cal-agenda-day-header">
            <h3>
              <time dateTime={group.date}>{formatFullDate(group.date)}</time>
              {group.date === today && <span className="cal-today-pill">Today</span>}
            </h3>
            <span className="cal-agenda-weekday">{formatWeekday(group.date)}</span>
          </header>
          <ul className="cal-agenda-list">
            {group.entries.map((entry) => <AgendaRow key={entry.key} entry={entry} onOpen={openEntry} />)}
          </ul>
        </section>) : <div className="cal-empty">
          <p className="empty">
            {filterCount > 0 ? `No items match your filters in ${range.heading}.` : `Nothing scheduled for ${range.heading}.`}
          </p>
          <div className="cal-empty-actions">
            {filterCount > 0 && <button type="button" className="button" onClick={() => setFilter(defaultFilter)}>Clear filters</button>}
            <button type="button" className="button" onClick={() => setAdding(anchorDate)}>Add event</button>
          </div>
        </div>}

        {showUnscheduled && <section className="cal-agenda-day cal-unscheduled" aria-label="Unscheduled tasks">
          <header className="cal-agenda-day-header">
            <h3>Unscheduled tasks</h3>
            <span className="cal-agenda-weekday">{unscheduled.length} {unscheduled.length === 1 ? 'task' : 'tasks'}</span>
          </header>
          {unscheduled.length > 0 ? <ul className="cal-agenda-list">
            {unscheduled.map((card: Card) => {
              const entry: CalendarEntry = {
                key: `unscheduled-${card.id}`,
                kind: 'task',
                id: card.id,
                title: card.title,
                date: '',
                allDay: true,
                timeLabel: 'No date',
                compactTimeLabel: '',
                sortTime: '00:00',
                tone: card.color === 'gray' ? 'yellow' : card.color,
                rawColor: card.color,
                completed: false,
                card,
                priority: card.priority,
                listTitle: card.list_title,
                repeats: card.recurrence !== 'none',
              }
              return <AgendaRow key={entry.key} entry={entry} onOpen={openEntry} />
            })}
          </ul> : <p className="empty">Every open task has a due date.</p>}
        </section>}
      </div>}

      {view === 'month' && loadedOnce && <>
        <section className="month" aria-label={range.heading}>
          <div className="weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="month-grid" ref={gridRef} style={{ gridTemplateRows: `repeat(${monthDays.weeks}, minmax(0, 1fr))` }}>
            {monthDays.days.map((day) => {
              const date = isoDate(day)
              const dayEntries = index.entriesOn(date, filter)
              const shown = dayEntries.length > capacity ? dayEntries.slice(0, Math.max(0, capacity - 1)) : dayEntries
              const hidden = dayEntries.length - shown.length
              const classes = [
                'day',
                day.getMonth() !== anchorMonth.getMonth() && 'is-outside',
                date === today && 'is-today',
                date === anchorDate && 'is-selected',
                date === dropDate && 'is-drop',
                (day.getDay() === 0 || day.getDay() === 6) && 'is-weekend',
              ].filter(Boolean).join(' ')
              return <div
                className={classes}
                key={date}
                onClick={() => { navigateTo(date); if (!isPhone()) setAdding(date) }}
                onDragOver={(event) => { if (canAcceptDrop(event.dataTransfer.types)) { event.preventDefault(); if (dropDate !== date) setDropDate(date) } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDate((current) => current === date ? null : current) }}
                onDrop={(event) => { event.preventDefault(); setDropDate(null); handleDropOnDate(event.dataTransfer, date) }}
              >
                <button
                  type="button"
                  className="day-number"
                  aria-label={`${formatWeekday(date)}, ${formatFullDate(date)}, ${dayEntries.length} ${dayEntries.length === 1 ? 'item' : 'items'}. Add an event`}
                  aria-current={date === today ? 'date' : undefined}
                  onClick={(event) => { event.stopPropagation(); navigateTo(date); if (!isPhone()) setAdding(date) }}
                >{day.getDate()}</button>
                <div className="day-events">
                  {shown.map((entry) => <MonthChip key={entry.key} entry={entry} onOpen={openEntry} draggable />)}
                  {hidden > 0 && <button type="button" className="day-more" onClick={(event) => { event.stopPropagation(); setExpanded(date) }}>+{hidden} more</button>}
                </div>
                {dayEntries.length > 0 && <div className="day-dots" aria-hidden="true">{dayEntries.slice(0, 4).map((entry) => <i key={entry.key} className={`tone-${entry.tone}`} />)}</div>}
              </div>
            })}
          </div>
        </section>

        <section className="day-agenda" aria-label={formatFullDate(anchorDate)}>
          <header>
            <h3>{formatWeekday(anchorDate)}, {formatFullDate(anchorDate)}</h3>
            <button type="button" className="text-button" onClick={() => setAdding(anchorDate)}>Add event</button>
          </header>
          {selectedDayEntries.length > 0
            ? <ul className="cal-agenda-list">{selectedDayEntries.map((entry) => <AgendaRow key={entry.key} entry={entry} onOpen={openEntry} />)}</ul>
            : <p className="empty">Nothing planned.</p>}
        </section>
      </>}

      {view === 'week' && loadedOnce && <section className="cal-week" aria-label={`Week of ${range.heading}`}>
        {weekDates.map((date) => {
          const parsed = parseDate(date)
          const entries = index.entriesOn(date, filter)
          const classes = [
            'cal-week-col',
            date === today && 'is-today',
            date === anchorDate && 'is-selected',
            date === dropDate && 'is-drop',
          ].filter(Boolean).join(' ')
          return <div
            key={date}
            className={classes}
            onDragOver={(event) => { if (canAcceptDrop(event.dataTransfer.types)) { event.preventDefault(); if (dropDate !== date) setDropDate(date) } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDate((current) => current === date ? null : current) }}
            onDrop={(event) => { event.preventDefault(); setDropDate(null); handleDropOnDate(event.dataTransfer, date) }}
          >
            <header className="cal-week-col-header">
              <button
                type="button"
                className="cal-week-day-btn"
                aria-current={date === today ? 'date' : undefined}
                onClick={() => { navigateTo(date); setView('day') }}
              >
                <span className="cal-week-weekday">{parsed.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <span className="cal-week-date">{parsed.getDate()}</span>
              </button>
              <button
                type="button"
                className="icon-button cal-week-add"
                aria-label={`Add event on ${formatFullDate(date)}`}
                onClick={() => setAdding(date)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
              </button>
            </header>
            <div className="cal-week-items">
              {entries.length > 0 ? entries.map((entry) => {
                const canDrag = entry.kind !== 'task' || entry.card !== null
                return <button
                  key={entry.key}
                  type="button"
                  draggable={canDrag}
                  className={`cal-week-item is-${entry.kind} tone-${entry.tone}${entry.completed ? ' is-completed' : ''}`}
                  onDragStart={(event) => {
                    if (!canDrag) return
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData(entry.kind === 'task' ? CARD_DRAG : EVENT_DRAG, String(entry.id))
                  }}
                  onClick={() => openEntry(entry)}
                >
                  <span className="cal-week-item-top">
                    <span className="cal-week-item-icon" aria-hidden="true"><EntryIcon entry={entry} /></span>
                    <span className="cal-week-item-time">{entry.allDay ? 'All-day' : entry.compactTimeLabel || entry.timeLabel}</span>
                  </span>
                  <span className="cal-week-item-title">{entry.title}</span>
                </button>
              }) : <p className="cal-week-empty">—</p>}
            </div>
          </div>
        })}
      </section>}

      {view === 'day' && loadedOnce && <section className="cal-day-view" aria-label={formatFullDate(anchorDate)}>
        <header className="cal-agenda-day-header cal-day-view-header">
          <h3>
            <time dateTime={anchorDate}>{formatFullDate(anchorDate)}</time>
            {anchorDate === today && <span className="cal-today-pill">Today</span>}
          </h3>
          <div className="cal-day-view-right">
            <span className="cal-agenda-weekday">{formatWeekday(anchorDate)}</span>
            <button type="button" className="text-button" onClick={() => setAdding(anchorDate)}>Add event</button>
          </div>
        </header>

        {selectedDayEntries.length === 0 ? <div className="cal-empty">
          <p className="empty">
            {filterCount > 0 ? 'No items match your filters on this day.' : 'Nothing scheduled for this day.'}
          </p>
          <div className="cal-empty-actions">
            {filterCount > 0 && <button type="button" className="button" onClick={() => setFilter(defaultFilter)}>Clear filters</button>}
            <button type="button" className="button" onClick={() => setAdding(anchorDate)}>Add event</button>
          </div>
        </div> : <div className="cal-day-sections">
          {dayAllDayEntries.length > 0 && <div className="cal-day-band">
            <h4 className="cal-day-band-label">All-day &amp; Tasks</h4>
            <ul className="cal-agenda-list">
              {dayAllDayEntries.map((entry) => <AgendaRow key={entry.key} entry={entry} onOpen={openEntry} />)}
            </ul>
          </div>}
          {dayTimedEntries.length > 0 && <div className="cal-day-band">
            <h4 className="cal-day-band-label">Schedule</h4>
            <ul className="cal-agenda-list">
              {dayTimedEntries.map((entry) => <AgendaRow key={entry.key} entry={entry} onOpen={openEntry} />)}
            </ul>
          </div>}
        </div>}
      </section>}
    </div>

    {expanded && <Modal className="modal-form" onClose={() => setExpanded(null)} labelledBy="day-title">
      <div className="form">
        <header className="form-header"><h2 id="day-title">{formatWeekday(expanded)}, {formatFullDate(expanded)}</h2><CloseButton onClick={() => setExpanded(null)} /></header>
        <ul className="cal-agenda-list">
          {index.entriesOn(expanded, filter).map((entry) => <AgendaRow key={entry.key} entry={entry} onOpen={(picked) => { setExpanded(null); openEntry(picked) }} />)}
        </ul>
        <footer className="form-actions"><button type="button" className="button" onClick={() => { setAdding(expanded); setExpanded(null) }}>Add event</button></footer>
      </div>
    </Modal>}
    {adding && <NewEventDialog date={adding} onClose={() => setAdding(null)} />}
  </div>
}
