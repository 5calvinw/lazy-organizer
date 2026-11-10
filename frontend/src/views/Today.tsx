import { useEffect, useRef, useState, type FormEvent } from 'react'
import { completeWithUndo } from '../actions'
import { messageOf, notifyChanged, request, send, todayQuery, useLiveData, type Card, type EventItem, type TodayData } from '../api'
import { Dropdown } from '../components/Dropdown'
import { CheckCircle } from '../components/fields'
import { NewEventDialog } from '../components/NewEventDialog'
import { addDays, isoDate, parseDate, readableDate, readableTime, relativePhrase } from '../dates'
import { toast, toastError, useRecords } from '../overlays'

type When = 'today' | 'tomorrow' | 'none' | 'custom'

function nextMonday(today: string) {
  const day = parseDate(today).getDay()
  return addDays(today, ((8 - day) % 7) || 7)
}

export function Today({ active }: { active: boolean }) {
  const records = useRecords()
  const [data, setData] = useState<TodayData | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [when, setWhen] = useState<When>('today')
  const [customDate, setCustomDate] = useState('')
  const [panel, setPanel] = useState<'tasks' | 'schedule'>('tasks')
  const [addingEvent, setAddingEvent] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  async function load() {
    try { setData(await request<TodayData>(`/api/today?${todayQuery()}`)); setError('') }
    catch (cause) { setError(messageOf(cause, 'Could not load today.')) }
  }
  useLiveData(() => void load(), active)
  // Keeps the page honest across midnight and for changes made from other devices.
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [active])

  const today = data?.date ?? isoDate(new Date())

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = titleRef.current?.value.trim()
    if (busy || !title) return
    const dueDate = when === 'today' ? today : when === 'tomorrow' ? addDays(today, 1) : when === 'custom' ? customDate || null : null
    setBusy(true)
    try {
      const card = await send<Card>('POST', '/api/today/tasks', { title, dueDate })
      titleRef.current!.value = ''
      notifyChanged()
      if (dueDate !== today) toast(dueDate ? `Added for ${relativePhrase(dueDate, today)}` : `Added to ${card.list_title}, no date`, { label: 'Open', run: () => records.open({ type: 'card', id: card.id }) })
    } catch (cause) { toastError(messageOf(cause, 'Could not add the task.')) }
    finally { setBusy(false); titleRef.current?.focus() }
  }
  async function reschedule(card: Card, dueDate: string | null) {
    try {
      // A repeating task can't lose its date without also losing its repeat.
      await send('PATCH', `/api/cards/${card.id}`, dueDate === null && card.recurrence !== 'none' ? { dueDate, recurrence: 'none' } : { dueDate })
      notifyChanged()
      toast(dueDate ? `Moved to ${relativePhrase(dueDate, today)}` : 'Due date removed', { label: 'Undo', run: () => { send('PATCH', `/api/cards/${card.id}`, { dueDate: card.due_date, recurrence: card.recurrence }).then(notifyChanged, () => toastError('Could not undo.')) } })
    } catch (cause) { toastError(messageOf(cause, 'Could not reschedule the task.')) }
  }
  const openEvent = (item: EventItem) => records.open(item.card_id != null ? { type: 'card', id: item.card_id } : { type: 'event', id: item.id })

  function rows(cards: Card[]) {
    return <ul className="task-rows">{cards.map((card) => {
      const meta = [
        card.list_title,
        card.due_date && card.due_date !== today ? `Due ${relativePhrase(card.due_date, today)}` : '',
        card.checklist_count ? `${card.checklist_completed}/${card.checklist_count} steps` : '',
        card.recurrence !== 'none' ? 'Repeats' : '',
      ].filter(Boolean)
      return <li className={`task-row tone-${card.color}`} key={card.id}>
        <CheckCircle checked={false} onToggle={() => void completeWithUndo(card)} label={`Complete ${card.title}`} />
        <button type="button" className="task-row-main" onClick={() => records.open({ type: 'card', id: card.id })}>
          <strong>{card.title}</strong>
          <small>{card.priority === 'high' || card.priority === 'medium' ? <em className={`priority priority-${card.priority}`}>{card.priority}</em> : null}{meta.join(' · ')}</small>
        </button>
        <Dropdown label="Later" ariaLabel={`Reschedule ${card.title}`} className="task-row-later">{(close) => {
          const pick = (date: string | null) => { close(); void reschedule(card, date) }
          return <>
            {card.due_date !== today && <button type="button" role="menuitem" onClick={() => pick(today)}>Today</button>}
            <button type="button" role="menuitem" onClick={() => pick(addDays(today, 1))}>Tomorrow <small>{parseDate(addDays(today, 1)).toLocaleDateString(undefined, { weekday: 'short' })}</small></button>
            <button type="button" role="menuitem" onClick={() => pick(nextMonday(today))}>Next week <small>{readableDate(nextMonday(today))}</small></button>
            <label className="menu-field">Pick a date<input type="date" defaultValue={card.due_date ?? ''} onChange={(event) => { if (event.target.value) pick(event.target.value) }} /></label>
            {card.due_date && <button type="button" role="menuitem" onClick={() => pick(null)}>No date</button>}
          </>
        }}</Dropdown>
      </li>
    })}</ul>
  }

  const summary = data && [
    `${data.dueToday.length} ${data.dueToday.length === 1 ? 'task' : 'tasks'} today`,
    data.overdue.length ? `${data.overdue.length} overdue` : '',
    `${data.events.length} ${data.events.length === 1 ? 'event' : 'events'}`,
  ].filter(Boolean).join(' · ')

  return <div className="view today">
    <header className="view-header today-header">
      <div className="view-heading">
        <p className="eyebrow"><time dateTime={today}>{parseDate(today).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</time></p>
        <h1>Today</h1>
        <p className="view-summary">{summary ?? 'A little clarity for the day ahead.'}</p>
      </div>
      <form className="capture" onSubmit={(event) => void capture(event)}>
        <input ref={titleRef} name="title" placeholder="Add a task…" aria-label="New task" required disabled={busy} enterKeyHint="done" />
        <select aria-label="Due" value={when} onChange={(event) => setWhen(event.target.value as When)} disabled={busy}>
          <option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="custom">Pick a date</option><option value="none">No date</option>
        </select>
        {when === 'custom' && <input type="date" aria-label="Due date" required value={customDate} min={today} onChange={(event) => setCustomDate(event.target.value)} disabled={busy} />}
        <button type="submit" className="button button-primary" disabled={busy}>Add</button>
      </form>
    </header>

    {error && <p className="banner-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>}
    {!data ? !error && <p className="view-loading" role="status">Gathering today…</p> : <>
      <div className="panel-tabs" role="tablist" aria-label="Today">
        <button type="button" role="tab" aria-selected={panel === 'tasks'} onClick={() => setPanel('tasks')}>Tasks <span>{data.dueToday.length + data.overdue.length}</span></button>
        <button type="button" role="tab" aria-selected={panel === 'schedule'} onClick={() => setPanel('schedule')}>Schedule <span>{data.events.length}</span></button>
      </div>
      <div className="today-layout" data-panel={panel}>
        <div className="today-tasks">
          {data.overdue.length > 0 && <section className="group group-overdue">
            <header><h2>Overdue</h2><span>{data.overdue.length}</span></header>
            {rows(data.overdue)}
          </section>}
          <section className="group">
            <header><h2>Due today</h2><span>{data.dueToday.length}</span></header>
            {data.dueToday.length ? rows(data.dueToday) : <p className="empty">{data.overdue.length ? 'Nothing else due today.' : 'Nothing due today. Add a task above, or pick up something in progress.'}</p>}
          </section>
          {data.doing.length > 0 && <section className="group">
            <header><h2>In progress</h2><span>{data.doing.length}</span></header>
            {rows(data.doing)}
          </section>}
        </div>
        <aside className="today-schedule">
          <section className="group">
            <header><h2>Schedule</h2><button type="button" className="text-button" onClick={() => setAddingEvent(true)}>Add event</button></header>
            {data.events.length ? <ul className="agenda">{data.events.map((item) => <li key={item.id}>
              <button type="button" className={`agenda-item tone-${item.is_deadline ? 'deadline' : item.color}`} onClick={() => openEvent(item)}>
                <time dateTime={item.all_day ? item.event_date : `${item.event_date}T${item.event_time}`}>{item.all_day ? 'All day' : item.event_date < today ? 'Ongoing' : readableTime(item.event_time)}</time>
                <span><strong>{item.title}</strong><small>{item.is_deadline ? 'Deadline' : item.all_day ? (item.end_date && addDays(item.end_date, -1) > today ? `Through ${readableDate(addDays(item.end_date, -1))}` : 'All day') : `Until ${item.end_date && item.end_date !== today ? `${readableDate(item.end_date)}, ` : ''}${readableTime(item.end_time)}`}</small></span>
              </button>
            </li>)}</ul> : <p className="empty">No events today.</p>}
            <a className="text-button" href="#/calendar">Open calendar</a>
          </section>
        </aside>
      </div>
    </>}
    {addingEvent && <NewEventDialog date={today} onClose={() => setAddingEvent(false)} />}
  </div>
}
