import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import { completeWithUndo, reopen } from '../actions'
import { isDoneList, messageOf, notifyChanged, request, send, todayQuery, useLiveData, type Card, type EventItem, type List } from '../api'
import { CheckCircle } from '../components/fields'
import { NewEventDialog } from '../components/NewEventDialog'
import { isoDate, readableTime, relativeDate } from '../dates'
import { confirmAction, toast, toastError, useRecords } from '../overlays'

type DropTarget = { listId: number; index: number }

function CardMeta({ card, today, done }: { card: Card; today: string; done: boolean }) {
  const overdue = !done && card.due_date !== null && card.due_date < today
  const items = [
    card.due_date && <time key="due" className={overdue ? 'is-overdue' : ''} dateTime={card.due_date}>{relativeDate(card.due_date, today)}</time>,
    card.priority !== 'none' && <span key="priority" className={`priority priority-${card.priority}`}>{card.priority}</span>,
    card.checklist_count > 0 && <span key="checklist">{card.checklist_completed}/{card.checklist_count}</span>,
    card.attachment_count > 0 && <span key="files">{card.attachment_count} {card.attachment_count === 1 ? 'file' : 'files'}</span>,
    card.recurrence !== 'none' && <span key="repeat">Repeats</span>,
  ].filter(Boolean)
  return items.length ? <span className="card-meta">{items}</span> : null
}

export function Tasks({ active }: { active: boolean }) {
  const records = useRecords()
  const [lists, setLists] = useState<List[] | null>(null)
  const [deadlines, setDeadlines] = useState<EventItem[]>([])
  const [error, setError] = useState('')
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [addingDeadline, setAddingDeadline] = useState(false)
  const [tab, setTab] = useState<number | 'upcoming' | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [overTrash, setOverTrash] = useState(false)
  const latest = useRef(0)
  const today = isoDate(new Date())

  async function load() {
    const ticket = ++latest.current
    try {
      const [board, upcoming] = await Promise.all([request<List[]>('/api/board'), request<EventItem[]>(`/api/deadlines?${todayQuery()}`)])
      if (ticket !== latest.current) return
      setLists(board); setDeadlines(upcoming); setError('')
    } catch (cause) { if (ticket === latest.current) setError(messageOf(cause, 'Could not load tasks.')) }
  }
  useLiveData(() => void load(), active)

  async function addCard(event: FormEvent<HTMLFormElement>, listId: number) {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('title') as HTMLInputElement
    const title = input.value.trim()
    if (!title) return
    input.value = ''
    try { await send('POST', `/api/lists/${listId}/cards`, { title }); notifyChanged() }
    catch (cause) { input.value = title; toastError(messageOf(cause, 'Could not add the task.')) }
  }

  // Dragging only moves a marker; the board itself changes once, on drop.
  function endDrag() { setDragging(null); setTarget(null); setOverTrash(false) }
  function dragOver(event: DragEvent<HTMLElement>, list: List) {
    if (dragging === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')).filter((element) => Number(element.dataset.cardId) !== dragging)
    const index = cards.filter((element) => { const box = element.getBoundingClientRect(); return event.clientY > box.top + box.height / 2 }).length
    if (target?.listId !== list.id || target.index !== index) setTarget({ listId: list.id, index })
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const cardId = dragging
    const destination = target
    endDrag()
    if (cardId === null || !destination || !lists) return
    const source = lists.find((list) => list.cards.some((card) => card.id === cardId))
    const card = source?.cards.find((item) => item.id === cardId)
    if (!source || !card) return
    if (source.id === destination.listId && source.cards.indexOf(card) === destination.index) return
    setLists(lists.map((list) => {
      const cards = list.cards.filter((item) => item.id !== cardId)
      if (list.id === destination.listId) cards.splice(destination.index, 0, { ...card, list_id: list.id, list_title: list.title })
      return { ...list, cards }
    }))
    try { await send('PATCH', `/api/cards/${cardId}/move`, { listId: destination.listId, index: destination.index }) }
    catch (cause) { toastError(messageOf(cause, 'Could not move the task.')) }
    finally { notifyChanged() }
  }
  async function dropOnTrash(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const card = lists?.flatMap((list) => list.cards).find((item) => item.id === dragging)
    endDrag()
    if (!card || !await confirmAction({ title: `Delete “${card.title}”?`, body: 'The task, its checklist, files and comments are deleted. This can’t be undone.', confirmLabel: 'Delete task' })) return
    try { await send('DELETE', `/api/cards/${card.id}`); toast('Task deleted') }
    catch (cause) { toastError(messageOf(cause, 'Could not delete the task.')) }
    finally { notifyChanged() }
  }

  const activeTab = tab ?? lists?.find((list) => list.title.trim().toLowerCase() === 'to do')?.id ?? lists?.[0]?.id ?? null
  const marker = <li className="drop-marker" aria-hidden="true" />

  return <div className="view tasks">
    <header className="view-header">
      <div className="view-heading"><h1>Tasks</h1></div>
    </header>
    {error && <p className="banner-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>}
    {!lists ? !error && <p className="view-loading" role="status">Loading tasks…</p> : <>
      <div className="panel-tabs panel-tabs-scroll" role="tablist" aria-label="Lists">
        {lists.map((list) => <button type="button" role="tab" key={list.id} aria-selected={activeTab === list.id} onClick={() => setTab(list.id)}>{list.title} <span>{list.cards.length}</span></button>)}
        <button type="button" role="tab" aria-selected={activeTab === 'upcoming'} onClick={() => setTab('upcoming')}>Upcoming <span>{deadlines.length}</span></button>
      </div>
      <div className="board">
        <div className="columns">
          {lists.map((list) => {
            const done = isDoneList(list.title)
            const visible = list.cards.filter((card) => card.id !== dragging)
            return <section className={`column${done ? ' column-done' : ''}${target?.listId === list.id ? ' is-target' : ''}`} key={list.id} data-current={activeTab === list.id} aria-label={list.title} onDragOver={(event) => dragOver(event, list)} onDrop={(event) => void drop(event)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget((current) => current?.listId === list.id ? null : current) }}>
              <header className="column-header"><h2>{list.title}</h2><span>{list.cards.length}</span></header>
              <ul className="cards">
                {list.cards.map((card) => {
                  const position = visible.indexOf(card)
                  return [
                    target?.listId === list.id && position === target.index && <li className="drop-marker" aria-hidden="true" key="marker" />,
                    <li key={card.id} className={`card tone-${card.color}${dragging === card.id ? ' is-dragging' : ''}`} data-card-id={card.id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(card.id)); setDragging(card.id) }} onDragEnd={endDrag}>
                      <CheckCircle checked={done} onToggle={() => void (done ? reopen(card) : completeWithUndo(card))} label={done ? `Reopen ${card.title}` : `Complete ${card.title}`} />
                      <div className="card-open" role="button" tabIndex={0} onClick={() => records.open({ type: 'card', id: card.id })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); records.open({ type: 'card', id: card.id }) } }}>
                        <strong>{card.title}</strong>
                        <CardMeta card={card} today={today} done={done} />
                      </div>
                    </li>,
                  ]
                })}
                {target?.listId === list.id && target.index >= visible.length && marker}
                {!list.cards.length && target?.listId !== list.id && <li className="cards-empty">{done ? 'Finished tasks land here.' : 'No tasks yet.'}</li>}
              </ul>
              {addingTo === list.id
                ? <form className="card-add" onSubmit={(event) => void addCard(event, list.id)}>
                  <input name="title" placeholder="Task title, then Enter" aria-label={`New task in ${list.title}`} data-list-add autoFocus enterKeyHint="done" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setAddingTo(null) } }} onBlur={(event) => { if (!event.target.value.trim()) setAddingTo(null) }} />
                </form>
                : <button type="button" className="text-button column-add" onClick={() => setAddingTo(list.id)}>+ Add task</button>}
            </section>
          })}
        </div>
        <aside className="upcoming" data-current={activeTab === 'upcoming'} aria-labelledby="upcoming-title">
          <header className="column-header"><h2 id="upcoming-title">Upcoming</h2><button type="button" className="text-button" onClick={() => setAddingDeadline(true)}>Add deadline</button></header>
          {deadlines.length ? <ol className="upcoming-list">{deadlines.map((deadline) => <li key={deadline.id}>
            <button type="button" onClick={() => records.open(deadline.card_id != null ? { type: 'card', id: deadline.card_id } : { type: 'event', id: deadline.id })}>
              <time dateTime={deadline.event_date} className={deadline.event_date === today ? 'is-today' : ''}>{relativeDate(deadline.event_date, today)}</time>
              <strong>{deadline.title}</strong>
              <small>{[deadline.card_id != null ? 'Task' : `Deadline · ${readableTime(deadline.event_time)}`, deadline.repeats ? 'Repeats' : ''].filter(Boolean).join(' · ')}</small>
            </button>
          </li>)}</ol> : <p className="empty">Nothing coming up. Tasks with a due date and deadlines you add appear here.</p>}
        </aside>
      </div>
      <div className={`trash${dragging !== null ? ' is-visible' : ''}${overTrash ? ' is-over' : ''}`} aria-hidden={dragging === null} onDragEnter={(event) => { event.preventDefault(); setOverTrash(true); setTarget(null) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverTrash(false) }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => void dropOnTrash(event)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
        <span>Drop here to delete</span>
      </div>
    </>}
    {addingDeadline && <NewEventDialog date={today} kind="deadline" onClose={() => setAddingDeadline(false)} />}
  </div>
}
