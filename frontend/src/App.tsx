import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import './App.css'

type OrganizerColor = 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'gray'
type Priority = 'none' | 'low' | 'medium' | 'high'
type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
type Card = {
  id: number
  list_id: number
  list_title: string
  title: string
  description: string
  color: OrganizerColor
  due_date: string | null
  priority: Priority
  recurrence: Recurrence
  recurrence_interval: number
  checklist_count: number
  checklist_completed: number
  attachment_count: number
  created_at: string
}
type List = { id: number; title: string; cards: Card[] }
type Comment = { id: number; body: string; image: string | null; file_name?: string | null; file_mime_type?: string | null; file_data?: string | null; file_size?: number | null; created_at: string }
type CommentAttachment = { name: string; mimeType: string; data: string; size: number }
type ChecklistItem = { id: number; title: string; completed: number; position: number; created_at: string }
type Attachment = { id: number; name: string; mime_type: string; data: string; size: number; created_at: string }
type LinkedEvent = { id: number; title: string; event_date: string; event_time: string; is_deadline: number }
type LinkedNotebook = { id: number; title: string }
type CardDetail = Card & {
  comments: Comment[]
  checklist: ChecklistItem[]
  attachments: Attachment[]
  links: { events: LinkedEvent[]; notebooks: LinkedNotebook[] }
}
type EventItem = {
  id: number
  title: string
  description: string
  event_date: string
  event_time: string
  end_time: string
  is_deadline: number
  color: OrganizerColor
  recurrence: Recurrence
  recurrence_interval: number
  recurrence_parent_id: number | null
  created_at: string
}
type EventDetail = EventItem & { comments: Comment[]; notebooks: LinkedNotebook[] }
type Notebook = { id: number; title: string; content: string; images: string[]; created_at: string }
type LinkOptions = { notebooks: LinkedNotebook[]; events: EventItem[] }
type TodayData = { date: string; overdue: Card[]; dueToday: Card[]; doing: Card[]; events: EventItem[] }
type Backlinks = { cards: Array<{ id: number; title: string; list_title: string }>; events: LinkedEvent[] }
type View = 'today' | 'tasks' | 'calendar' | 'notebooks'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(body.error ?? 'Request failed')
  }
  return response.json()
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const organizerColors: OrganizerColor[] = ['blue', 'green', 'yellow', 'purple', 'orange', 'gray']
const recurrenceLabels: Record<Recurrence, string> = { none: 'Does not repeat', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' }
type RecordMention = { id: number; title: string; type: 'event' | 'notebook'; detail: string }
const recordLinkPattern = /\$\[(?:(event|notebook):(\d+)|([^\]\r\n]+))\]/g

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function readableDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function readableTime(value: string) {
  return new Date(`2000-01-01T${value}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
function descriptionHtml(value: string, records: RecordMention[]) {
  let position = 0
  const html = Array.from(value.matchAll(recordLinkPattern)).map((match) => {
    const prefix = escapeHtml(value.slice(position, match.index)).replace(/\n/g, '<br>')
    position = match.index + match[0].length
    const record = match[1] && match[2]
      ? records.find((item) => item.type === match[1] && item.id === Number(match[2]))
      : records.find((item) => item.type === 'notebook' && item.title.localeCompare(match[3].trim(), undefined, { sensitivity: 'base' }) === 0)
    if (!record) return `${prefix}${escapeHtml(match[0])}`
    return `${prefix}<button type="button" class="record-chip record-${record.type}" data-record-type="${record.type}" data-record-id="${record.id}" contenteditable="false"><span>${record.type === 'event' ? '◷' : '▮'}</span>${escapeHtml(record.title)}</button>`
  }).join('') + escapeHtml(value.slice(position)).replace(/\n/g, '<br>')
  return html.replace(/(^|<br>)!checklist(?=<br>|$)/g, '$1<span class="checklist-marker" data-checklist="true" contenteditable="false" aria-hidden="true"></span>')
}
function serializeDescription(element: HTMLElement) {
  return Array.from(element.childNodes).map((node) => {
    if (node instanceof HTMLElement && node.dataset.recordType && node.dataset.recordId) return `$[${node.dataset.recordType}:${node.dataset.recordId}]`
    if (node instanceof HTMLElement && node.dataset.checklist) return '!checklist'
    if (node.nodeName === 'BR') return '\n'
    return node.textContent ?? ''
  }).join('')
}
function ColorPicker({ name = 'color', value, onChange }: { name?: string; value?: OrganizerColor; onChange?: (color: OrganizerColor) => void }) {
  return <fieldset className="color-picker"><legend>Color</legend>{organizerColors.map((color) => <label key={color} title={color}><input type="radio" name={name} value={color} defaultChecked={color === (value ?? 'blue')} onChange={() => onChange?.(color)} /><span className={`color-swatch color-${color}`} /><span className="sr-only">{color}</span></label>)}</fieldset>
}
function RecurrenceFields({ value = 'none', interval = 1 }: { value?: Recurrence; interval?: number }) {
  return <div className="recurrence-fields"><label>Repeat<select name="recurrence" defaultValue={value}>{(Object.keys(recurrenceLabels) as Recurrence[]).map((item) => <option value={item} key={item}>{recurrenceLabels[item]}</option>)}</select></label><label>Every<input name="recurrenceInterval" type="number" min="1" max="365" defaultValue={interval} /></label></div>
}
function CardMeta({ card }: { card: Card }) {
  const dueClass = card.due_date && card.due_date < isoDate(new Date()) ? ' overdue' : ''
  return <span className="card-meta">{card.due_date && <time className={dueClass} dateTime={card.due_date}>{readableDate(card.due_date)}</time>}{card.priority !== 'none' && <span className={`priority priority-${card.priority}`}>{card.priority}</span>}{card.checklist_count > 0 && <span>{card.checklist_completed}/{card.checklist_count}</span>}{card.attachment_count > 0 && <span>{card.attachment_count} file{card.attachment_count === 1 ? '' : 's'}</span>}{card.recurrence !== 'none' && <span>Repeats</span>}</span>
}
function RecordDescription({ value, label, options, checklist, onSave, onAddChecklist, onChangeChecklist, onDeleteChecklist, openNotebook, openEvent }: { value: string; label: string; options: LinkOptions | null; checklist?: ChecklistItem[]; onSave: (value: string) => void; onAddChecklist?: (event: FormEvent<HTMLFormElement>) => void; onChangeChecklist?: (id: number, changes: Record<string, unknown>) => void; onDeleteChecklist?: (id: number) => void; openNotebook: (id: number) => void; openEvent?: (id: number) => void }) {
  const [query, setQuery] = useState<string | null>(null)
  const [checklistEnabled, setChecklistEnabled] = useState(/^!checklist$/m.test(value))
  const [active, setActive] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const matchRange = useRef<Range | null>(null)
  const records = useMemo<RecordMention[]>(() => [
    ...(options?.notebooks.map((item) => ({ ...item, type: 'notebook' as const, detail: 'Notebook' })) ?? []),
    ...(options?.events.map((item) => ({ ...item, type: 'event' as const, detail: `${item.is_deadline ? 'Deadline' : 'Event'} · ${readableDate(item.event_date)}` })) ?? []),
  ], [options])
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = descriptionHtml(value, records)
    setChecklistEnabled(/^!checklist$/m.test(value))
  }, [value, records])
  const matches = query === null ? [] : records.filter((record) => record.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 8)
  function update() {
    if (editorRef.current) {
      const description = serializeDescription(editorRef.current)
      const nextChecklistEnabled = /^!checklist$/m.test(description)
      if (nextChecklistEnabled && !checklistEnabled) onSave(description)
      setChecklistEnabled(nextChecklistEnabled)
    }
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const fragment = range?.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.textContent?.slice(0, range.startOffset).match(/\$([\p{L}\p{N}_ -]*)$/u)?.[1] : undefined
    matchRange.current = fragment === undefined || !range ? null : range.cloneRange()
    setQuery(fragment ?? null)
    setActive(0)
  }
  function choose(record: RecordMention) {
    const selection = window.getSelection()
    const range = matchRange.current
    if (!selection || !range || query === null || range.startContainer.nodeType !== Node.TEXT_NODE) return
    range.setStart(range.startContainer, Math.max(0, range.startOffset - query.length - 1))
    range.deleteContents()
    const wrapper = document.createElement('span')
    wrapper.innerHTML = `<button type="button" class="record-chip record-${record.type}" data-record-type="${record.type}" data-record-id="${record.id}" contenteditable="false"><span>${record.type === 'event' ? '◷' : '▮'}</span>${escapeHtml(record.title)}</button>&nbsp;`
    const fragment = document.createDocumentFragment()
    while (wrapper.firstChild) fragment.append(wrapper.firstChild)
    range.insertNode(fragment)
    selection.collapseToEnd()
    setQuery(null)
    editorRef.current?.focus()
  }
  const hasChecklist = checklistEnabled || /^!checklist$/m.test(value)
  return <div className="description-autocomplete"><div ref={editorRef} className="description-editor" contentEditable suppressContentEditableWarning data-placeholder="Add details… Type $ to link records or !checklist to add a checklist." onInput={update} onKeyDown={(event) => { if (!matches.length || query === null) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length) } if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(matches[active]) } if (event.key === 'Escape') { event.preventDefault(); setQuery(null) } }} onBlur={(event) => onSave(serializeDescription(event.currentTarget))} onClick={(event) => { const chip = (event.target as HTMLElement).closest<HTMLElement>('.record-chip'); const id = Number(chip?.dataset.recordId); if (chip?.dataset.recordType === 'notebook') openNotebook(id); if (chip?.dataset.recordType === 'event') openEvent?.(id) }} role="textbox" aria-multiline="true" aria-label={label} />{query !== null && matches.length > 0 && <div className="record-suggestions" role="listbox" aria-label="Linked record suggestions">{matches.map((record, index) => <button className={index === active ? 'active' : ''} type="button" role="option" aria-selected={index === active} key={`${record.type}-${record.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(record)}><span>{record.type === 'event' ? '◷' : '▮'}</span><strong>{record.title}</strong><small>{record.detail}</small></button>)}</div>}{hasChecklist && checklist && <div className="inline-checklist">{checklist.map((item) => <div className="inline-checklist-item" key={item.id}><input type="checkbox" checked={Boolean(item.completed)} onChange={(event) => onChangeChecklist?.(item.id, { completed: event.target.checked })} /><input className={item.completed ? 'completed' : ''} defaultValue={item.title} onBlur={(event) => { const title = event.target.value.trim(); if (title && title !== item.title) onChangeChecklist?.(item.id, { title }) }} aria-label="Checklist item" /><button type="button" onClick={() => onDeleteChecklist?.(item.id)} aria-label="Remove checklist item">×</button></div>)}<form onSubmit={onAddChecklist}><span>＋</span><input name="title" placeholder="Add an item" aria-label="New checklist item" /></form></div>}</div>
}

function TodayApp({ active, openCard, openEvent, openCalendar }: { active: boolean; openCard: (id: number) => void; openEvent: (id: number) => void; openCalendar: () => void }) {
  const [data, setData] = useState<TodayData | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [captureDate, setCaptureDate] = useState('none')
  const [panel, setPanel] = useState('tasks')
  const [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<{ id: number; listId: number; index: number } | null>(null)
  async function load() {
    try { setData(await request<TodayData>('/api/today')); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load today') }
  }
  useEffect(() => {
    if (!active) return
    void load()
    const refresh = () => void load()
    const openError = (event: Event) => setError((event as CustomEvent<string>).detail)
    window.addEventListener('task-open-error', openError)
    window.addEventListener('organizer-changed', refresh)
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { window.removeEventListener('task-open-error', openError); window.removeEventListener('organizer-changed', refresh); window.removeEventListener('focus', refresh); window.clearInterval(timer) }
  }, [active])
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const title = String(fields.get('title') ?? '').trim()
    if (!title) return
    const dueDate = captureDate === 'today' ? data?.date ?? isoDate(new Date()) : captureDate === 'custom' ? String(fields.get('dueDate')) : null
    setBusy(true)
    try { const card = await request<Card>('/api/today/tasks', { method: 'POST', ...json({ title, dueDate }) }); form.reset(); setCaptureDate('none'); setNotice(dueDate ? 'Task added.' : `Task added to ${card.list_title}, without a due date.`); setUndo(null); await load(); window.dispatchEvent(new Event('organizer-changed')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add task') }
    finally { setBusy(false) }
  }
  async function changeTask(card: Card, dueDate?: string | null) {
    if (busy) return
    setBusy(true)
    try {
      if (dueDate !== undefined) {
        await request(`/api/cards/${card.id}`, { method: 'PATCH', ...json({ dueDate }) })
        setUndo(null); setNotice(dueDate ? 'Task rescheduled.' : 'Due date removed.')
      } else {
        const board = await request<List[]>('/api/board')
        const done = board.find((list) => list.title.toLowerCase() === 'done')
        if (!done) throw new Error('Create a list named Done in Tasks before completing tasks.')
        const index = board.find((list) => list.id === card.list_id)?.cards.findIndex((item) => item.id === card.id) ?? 0
        await request(`/api/cards/${card.id}/move`, { method: 'PATCH', ...json({ listId: done.id, index: done.cards.length }) })
        setUndo(card.recurrence === 'none' ? { id: card.id, listId: card.list_id, index: Math.max(0, index) } : null)
        setNotice(card.recurrence === 'none' ? `Completed: ${card.title}` : `Completed: ${card.title}. The next occurrence is managed in Tasks.`)
      }
      await load(); window.dispatchEvent(new Event('organizer-changed'))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update task') }
    finally { setBusy(false) }
  }
  async function undoCompletion() {
    if (!undo || busy) return
    setBusy(true)
    try { await request(`/api/cards/${undo.id}/move`, { method: 'PATCH', ...json({ listId: undo.listId, index: undo.index }) }); setUndo(null); setNotice('Task restored.'); await load(); window.dispatchEvent(new Event('organizer-changed')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore task') }
    finally { setBusy(false) }
  }
  function taskRows(cards: Card[]) {
    const tomorrow = new Date(`${data?.date ?? isoDate(new Date())}T12:00:00`)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return <div className="today-task-list">{cards.map((card) => <div className="today-task-row" key={card.id}>
      <input type="checkbox" checked={false} disabled={busy} aria-label={`Complete ${card.title}`} onChange={() => void changeTask(card)} />
      <button type="button" className="today-task-title" onClick={() => openCard(card.id)}><strong>{card.title}</strong><small>{[card.list_title, card.due_date && card.due_date !== data?.date ? `Due ${readableDate(card.due_date)}` : '', card.priority !== 'none' ? `${card.priority} priority` : '', card.checklist_count ? `${card.checklist_completed}/${card.checklist_count} steps` : ''].filter(Boolean).join(' / ')}</small></button>
      <details className="today-task-actions"><summary aria-label={`Reschedule ${card.title}`}>Reschedule</summary><div><button disabled={busy} onClick={() => void changeTask(card, isoDate(tomorrow))}>Tomorrow</button><button disabled={busy} onClick={() => void changeTask(card, null)}>Remove due date</button><label>Choose date<input type="date" disabled={busy} value={card.due_date ?? ''} onChange={(event) => { if (event.target.value) void changeTask(card, event.target.value) }} /></label></div></details>
    </div>)}</div>
  }
  return <main className="workspace today-workspace">
    <header className="today-header"><div className="today-heading"><time dateTime={data?.date}>{data ? new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Your daily workspace'}</time><h1>Today</h1><p>{data ? `${data.dueToday.length} tasks due today / ${data.events.length} scheduled` : 'A little clarity for the day ahead.'}</p></div>
      <form className="quick-capture" onSubmit={(event) => void capture(event)}><label htmlFor="quick-capture">Capture a task</label><div className="capture-fields"><input id="quick-capture" name="title" placeholder="What needs your attention?" required disabled={busy} /><select aria-label="Task due date" value={captureDate} onChange={(event) => setCaptureDate(event.target.value)} disabled={busy}><option value="none">No date</option><option value="today">Today</option><option value="custom">Choose date</option></select>{captureDate === 'custom' && <input type="date" name="dueDate" aria-label="Choose task due date" required disabled={busy} />}<button type="submit" disabled={busy}>Add task</button></div></form>
    </header>
    <div className="today-body">{error && <div className="error" role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></div>}{notice && <div className="today-notice" role="status"><span>{notice}</span>{undo && <button disabled={busy} onClick={() => void undoCompletion()}>Undo</button>}<button aria-label="Dismiss notification" onClick={() => { setNotice(''); setUndo(null) }}>Dismiss</button></div>}
      {!data ? !error && <p className="today-loading" role="status">Gathering today...</p> : <><div className="today-mobile-tabs" aria-label="Today panels"><button aria-pressed={panel === 'tasks'} onClick={() => setPanel('tasks')}>Tasks</button><button aria-pressed={panel === 'schedule'} onClick={() => setPanel('schedule')}>Schedule ({data.events.length})</button></div><div className="today-layout" data-panel={panel}>
        <div className="today-task-scroll"><section className="today-task-group"><header><h2>Your tasks</h2><span>{data.dueToday.length}</span></header>{data.dueToday.length ? taskRows(data.dueToday) : <p className="today-empty">Nothing due today. Add a task for today, or pick up where you left off.</p>}</section>
          {data.overdue.length > 0 && <details className="today-task-group today-overdue" open><summary><strong>Overdue</strong><span>{data.overdue.length}</span></summary>{taskRows(data.overdue)}</details>}
          {data.doing.length > 0 && <details className="today-task-group"><summary><strong>Continue working</strong><span>{data.doing.length}</span></summary>{taskRows(data.doing)}</details>}
        </div>
        <aside className="today-schedule"><header><h2>Schedule</h2><span>{data.events.length}</span></header>{data.events.length ? <div className="today-agenda-list">{data.events.map((item) => <button className="today-event" key={item.id} onClick={() => openEvent(item.id)}><time dateTime={`${item.event_date}T${item.event_time}`}>{readableTime(item.event_time)}</time><span><strong>{item.title}</strong><small>{item.is_deadline ? 'Deadline' : `Until ${readableTime(item.end_time)}`}</small></span></button>)}</div> : <p className="today-empty">No events today.<br />Room to focus on your own time.</p>}<button className="today-calendar-link" onClick={openCalendar}>Open calendar</button></aside>
      </div></>}
    </div>
  </main>
}

function TasksApp({ active, initialCardId, onCardOpened, openNotebook, openEvent }: { active: boolean; initialCardId: number | null; onCardOpened: () => void; openNotebook: (id: number) => void; openEvent: (id: number) => void }) {
  const [lists, setLists] = useState<List[]>([])
  const [deadlines, setDeadlines] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<CardDetail | null>(null)
  const [linkOptions, setLinkOptions] = useState<LinkOptions | null>(null)
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [addingDeadline, setAddingDeadline] = useState(false)
  const [commentImage, setCommentImage] = useState<string | null>(null)
  const [commentAttachment, setCommentAttachment] = useState<CommentAttachment | null>(null)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deadlineDialogRef = useRef<HTMLDialogElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [trashActive, setTrashActive] = useState(false)
  const dragOrigin = useRef<List[] | null>(null)
  async function loadBoard() {
    try {
      const [board, upcoming] = await Promise.all([request<List[]>('/api/board'), request<EventItem[]>('/api/deadlines')])
      setLists(board); setDeadlines(upcoming); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load tasks') }
  }
  useEffect(() => {
    if (!active) return
    void loadBoard()
  }, [active])
  useEffect(() => { if (initialCardId) { void openCard(initialCardId); onCardOpened() } }, [initialCardId, onCardOpened])
  useEffect(() => { if (addingDeadline) deadlineDialogRef.current?.showModal(); else deadlineDialogRef.current?.close() }, [addingDeadline])
  useEffect(() => { if (selected) dialogRef.current?.showModal(); else dialogRef.current?.close() }, [selected])
  async function openCard(id: number) {
    try {
      const [detail, options] = await Promise.all([request<CardDetail>(`/api/cards/${id}`), request<LinkOptions>('/api/link-options')])
      setSelected(detail); setLinkOptions(options); setDialogError(''); setCommentImage(null); setCommentAttachment(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open task'); window.dispatchEvent(new CustomEvent('task-open-error', { detail: cause instanceof Error ? cause.message : 'Could not open task' })) }
  }
  function closeCard() { setSelected(null); setDialogError(''); setCommentImage(null); setCommentAttachment(null) }
  async function reloadSelected() { if (selected) setSelected(await request<CardDetail>(`/api/cards/${selected.id}`)) }
  async function saveCard(changes: Record<string, unknown>) {
    if (!selected) return
    try {
      await request(`/api/cards/${selected.id}`, { method: 'PATCH', ...json(changes) })
      await Promise.all([reloadSelected(), loadBoard()]); setDialogError(''); window.dispatchEvent(new Event('organizer-changed'))
    } catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not save task') }
  }
  async function addDeadline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await request('/api/deadlines', { method: 'POST', ...json({ title: String(data.get('title')).trim(), eventDate: String(data.get('date')), eventTime: String(data.get('time')), recurrence: String(data.get('recurrence')), recurrenceInterval: Number(data.get('recurrenceInterval')) }) })
      setAddingDeadline(false); window.dispatchEvent(new Event('organizer-changed')); await loadBoard()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add deadline') }
  }
  function moveLocally(cardId: number, listId: number, index: number) {
    setLists((current) => {
      const next = current.map((list) => ({ ...list, cards: [...list.cards] }))
      const source = next.find((list) => list.cards.some((card) => card.id === cardId))
      const destination = next.find((list) => list.id === listId)
      if (!source || !destination) return current
      const [card] = source.cards.splice(source.cards.findIndex((item) => item.id === cardId), 1)
      destination.cards.splice(Math.min(index, destination.cards.length), 0, { ...card, list_id: listId, list_title: destination.title })
      return next
    })
  }
  async function moveCard(cardId: number, listId: number, index: number) {
    await request(`/api/cards/${cardId}/move`, { method: 'PATCH', ...json({ listId, index }) })
    await loadBoard(); window.dispatchEvent(new Event('organizer-changed'))
  }
  async function dropCard(event: DragEvent, listId: number, index: number) {
    event.preventDefault()
    if (dragging === null) return
    moveLocally(dragging, listId, index)
    try { await moveCard(dragging, listId, index) }
    catch (cause) { setLists(dragOrigin.current ?? lists); setError(cause instanceof Error ? cause.message : 'Could not move task') }
    finally { setDragging(null); dragOrigin.current = null }
  }
  async function dropCardInTrash(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (dragging === null) return
    const cardId = dragging
    const previousLists = dragOrigin.current ?? lists
    setLists((current) => current.map((list) => ({ ...list, cards: list.cards.filter((card) => card.id !== cardId) })))
    setTrashActive(false); setDragging(null); dragOrigin.current = null
    try {
      await request(`/api/cards/${cardId}`, { method: 'DELETE' })
      window.dispatchEvent(new Event('organizer-changed'))
    } catch (cause) {
      setLists(previousLists)
      setError(cause instanceof Error ? cause.message : 'Could not delete task')
    }
  }
  async function addCard(event: FormEvent<HTMLFormElement>, listId: number) {
    event.preventDefault()
    const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
    if (!title) return
    try { await request(`/api/lists/${listId}/cards`, { method: 'POST', ...json({ title }) }); setAddingTo(null); await loadBoard() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add task') }
  }
  async function deleteCard() {
    if (!selected || !window.confirm(`Delete task “${selected.title}”? This cannot be undone.`)) return
    try { await request(`/api/cards/${selected.id}`, { method: 'DELETE' }); closeCard(); await loadBoard(); window.dispatchEvent(new Event('organizer-changed')) }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not delete task') }
  }
  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const body = String(new FormData(form).get('comment') ?? '').trim()
    if (!body && !commentImage && !commentAttachment) return
    try { await request(`/api/cards/${selected.id}/comments`, { method: 'POST', ...json({ body, image: commentImage, fileName: commentAttachment?.name ?? null, fileMimeType: commentAttachment?.mimeType ?? null, fileData: commentAttachment?.data ?? null, fileSize: commentAttachment?.size ?? null }) }); form.reset(); setCommentImage(null); setCommentAttachment(null); await reloadSelected() }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not add comment') }
  }
  async function pasteCommentImage(event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile()
    if (!image) return
    event.preventDefault()
    if (image.size > 5_000_000) { setDialogError('Image must be 5 MB or smaller'); return }
    setCommentAttachment(null); setCommentImage(await fileToDataUrl(image))
  }
  async function attachCommentFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    if (file.size > 5_000_000) { setDialogError(`${file.name} must be 5 MB or smaller`); return }
    try {
      setCommentImage(null); setDialogError('')
      setCommentAttachment({ name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file), size: file.size })
    } catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not attach file') }
  }
  async function addChecklist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return
    const form = event.currentTarget
    const title = String(new FormData(form).get('title') ?? '').trim()
    if (!title) return
    await request(`/api/cards/${selected.id}/checklist`, { method: 'POST', ...json({ title }) }); form.reset(); await reloadSelected(); await loadBoard()
  }
  async function changeChecklist(id: number, changes: Record<string, unknown>) { await request(`/api/checklist/${id}`, { method: 'PATCH', ...json(changes) }); await reloadSelected(); await loadBoard() }
  async function deleteChecklist(id: number) { await request(`/api/checklist/${id}`, { method: 'DELETE' }); await reloadSelected(); await loadBoard() }
  async function addAttachments(files: FileList | null) {
    if (!selected || !files) return
    try {
      for (const file of Array.from(files)) {
        if (file.size > 5_000_000) throw new Error(`${file.name} is larger than 5 MB`)
        await request(`/api/cards/${selected.id}/attachments`, { method: 'POST', ...json({ name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file) }) })
      }
      await reloadSelected(); await loadBoard()
    } catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not attach file') }
  }
  async function deleteAttachment(id: number) { await request(`/api/attachments/${id}`, { method: 'DELETE' }); await reloadSelected(); await loadBoard() }
  return <main className="workspace tasks-workspace">{error && <p className="error" role="alert">{error}</p>}<section className="board" aria-label="Task board">{lists.map((list) => <article className={`list${dragging !== null ? ' is-dragging' : ''}`} key={list.id} onDragOver={(event) => { event.preventDefault(); if (dragging !== null) moveLocally(dragging, list.id, list.cards.length) }} onDrop={(event) => void dropCard(event, list.id, list.cards.length)}><header className="list-header"><h2>{list.title}</h2><span>{list.cards.length}</span></header><div className="card-stack">{list.cards.map((card, index) => <button className={`task-card color-${card.color}${dragging === card.id ? ' dragging' : ''}`} key={card.id} type="button" draggable onDragStart={(event) => { dragOrigin.current = lists; setDragging(card.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(card.id)) }} onDragEnd={() => { setTrashActive(false); setDragging(null); dragOrigin.current = null }} onDragOver={(event) => { event.stopPropagation(); event.preventDefault(); if (dragging !== null) moveLocally(dragging, list.id, index) }} onDrop={(event) => { event.stopPropagation(); void dropCard(event, list.id, index) }} onClick={() => { if (dragging === null) void openCard(card.id) }}><strong>{card.title}</strong><CardMeta card={card} /></button>)}</div>{addingTo === list.id ? <form className="add-form" onSubmit={(event) => void addCard(event, list.id)}><textarea name="title" autoFocus placeholder="Enter a task title…" aria-label="Task title" /><div><button className="primary" type="submit">Add task</button><button type="button" onClick={() => setAddingTo(null)} aria-label="Cancel">×</button></div></form> : <button className="add-card" type="button" onClick={() => setAddingTo(list.id)}><span>＋</span> Add a task</button>}</article>)}<aside className="deadlines" aria-labelledby="deadlines-title"><header><h2 id="deadlines-title">Deadlines</h2><button className="deadline-add" type="button" onClick={() => setAddingDeadline(true)} aria-label="Add deadline">＋</button></header>{deadlines.length ? <ol>{deadlines.map((deadline) => <li key={deadline.id}><button type="button" onClick={() => openEvent(deadline.id)}><time dateTime={`${deadline.event_date}T${deadline.event_time}`}><strong>{readableDate(deadline.event_date)}</strong><span>{readableTime(deadline.event_time)}</span></time><span>{deadline.title}</span></button></li>)}</ol> : <p className="deadlines-empty">No upcoming deadlines.</p>}</aside></section><aside className={`task-trash${dragging !== null ? ' visible' : ''}${trashActive ? ' active' : ''}`} aria-label="Delete task drop zone" onDragEnter={(event) => { event.preventDefault(); if (dragging !== null) setTrashActive(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTrashActive(false) }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => void dropCardInTrash(event)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg><span>Drop to delete</span></aside><dialog ref={deadlineDialogRef} className="event-dialog" aria-labelledby="add-deadline-title" onCancel={() => setAddingDeadline(false)}><form className="event-popup" onSubmit={(event) => void addDeadline(event)}><header><div><h2 id="add-deadline-title">Add deadline</h2><p>This also appears in your calendar.</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDeadline(false)}>×</button></header><label>Title<input name="title" autoFocus required placeholder="What is due?" /></label><label>Date<input name="date" type="date" defaultValue={isoDate(new Date())} required /></label><label>Time<input name="time" type="time" defaultValue="09:00" required /></label><RecurrenceFields /><button className="event-submit" type="submit">Add deadline</button></form></dialog><dialog ref={dialogRef} className="card-dialog" aria-labelledby="task-dialog-title" onCancel={closeCard}>{selected && <div className="dialog-layout"><section className="card-details"><button className="close" type="button" onClick={closeCard} aria-label="Close task">×</button><div className="title-row"><span className={`circle color-${selected.color}`} /><div><input id="task-dialog-title" className="editable-title" defaultValue={selected.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== selected.title) void saveCard({ title: event.target.value.trim() }) }} aria-label="Task title" /><p>in list <strong>{selected.list_title}</strong></p></div></div>{dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
<details className="task-properties">
  <summary>
    <span className="property-values">
      {selected.due_date && <span className={selected.due_date < isoDate(new Date()) ? 'property-chip overdue' : 'property-chip'}>Due {readableDate(selected.due_date)}</span>}
      {selected.priority !== 'none' && <span className={`property-chip priority-${selected.priority}`}>{selected.priority} priority</span>}
      {selected.recurrence !== 'none' && <span className="property-chip">Repeats {recurrenceLabels[selected.recurrence].toLowerCase()}</span>}
      {!selected.due_date && selected.priority === 'none' && selected.recurrence === 'none' && <span className="add-details">＋ Add details</span>}
    </span>
  </summary>
  <div className="property-popover">
    <label>Due date<input name="dueDate" type="date" value={selected.due_date ?? ''} onChange={(event) => void saveCard({ dueDate: event.target.value || null })} /></label>
    <label>Priority<select name="priority" value={selected.priority} onChange={(event) => void saveCard({ priority: event.target.value })}><option value="none">No priority</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
    <label>Repeat<select name="recurrence" value={selected.recurrence} onChange={(event) => void saveCard({ recurrence: event.target.value })}>{(Object.keys(recurrenceLabels) as Recurrence[]).map((item) => <option value={item} key={item}>{recurrenceLabels[item]}</option>)}</select></label>
    <label>Every<input name="recurrenceInterval" type="number" min="1" max="365" value={selected.recurrence_interval} onChange={(event) => setSelected({ ...selected, recurrence_interval: Number(event.target.value) })} onBlur={(event) => void saveCard({ recurrenceInterval: Number(event.target.value) })} /></label>
    <ColorPicker name="card-color" value={selected.color} onChange={(color) => void saveCard({ color })} />
  </div>
</details>
<section className="detail-section"><h3>Description</h3><RecordDescription key={selected.id} value={selected.description} label="Task description" options={linkOptions} checklist={selected.checklist} onSave={(description) => void saveCard({ description })} onAddChecklist={(event) => void addChecklist(event)} onChangeChecklist={(id, changes) => void changeChecklist(id, changes)} onDeleteChecklist={(id) => void deleteChecklist(id)} openNotebook={openNotebook} openEvent={openEvent} /></section><section className="detail-section"><header><h3>Attachments</h3><span>{selected.attachments.length}</span></header><div className="attachments">{selected.attachments.map((item) => <div key={item.id}><a href={item.data} download={item.name}>{item.mime_type.startsWith('image/') ? <img src={item.data} alt="" /> : <span className="file-mark">FILE</span>}<span><strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small></span></a><button type="button" onClick={() => void deleteAttachment(item.id)} aria-label={`Remove ${item.name}`}>×</button></div>)}</div><label className="attachment-add">Attach files<input type="file" multiple onChange={(event) => { void addAttachments(event.target.files); event.target.value = '' }} /></label></section><button className="danger-action" type="button" onClick={() => void deleteCard()}>Delete task</button></section><aside className="activity"><header><h3>Comments and activity</h3></header><form className="comment-form" onSubmit={(event) => void addComment(event)}><div className="comment-composer"><textarea name="comment" rows={3} placeholder="Add a comment…" aria-label="Comment" onPaste={(event) => void pasteCommentImage(event)} /><div className="comment-toolbar"><div className="comment-tools" aria-label="Comment tools"><button type="button" className="comment-tool" aria-label="Bold" title="Bold" disabled><strong>B</strong></button><button type="button" className="comment-tool comment-tool-italic" aria-label="Italic" title="Italic" disabled><em>I</em></button><button type="button" className="comment-tool comment-tool-underline" aria-label="Underline" title="Underline" disabled><u>U</u></button><span className="comment-toolbar-divider" aria-hidden="true" /><label className="comment-attach" title="Attach image or file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg><input type="file" onChange={(event) => { void attachCommentFile(event.target.files); event.target.value = '' }} aria-label="Attach image or file" /></label></div><button className="comment-submit" type="submit">Post</button></div></div>{commentImage && <div className="comment-image-preview"><img src={commentImage} alt="Pasted attachment preview" /><button type="button" onClick={() => setCommentImage(null)} aria-label="Remove pasted image">×</button></div>}{commentAttachment && <div className="comment-file-preview">{commentAttachment.mimeType.startsWith('image/') ? <img src={commentAttachment.data} alt={commentAttachment.name + ' preview'} /> : <span className="file-mark">FILE</span>}<span className="comment-file-details"><strong>{commentAttachment.name}</strong><small>{Math.max(1, Math.round(commentAttachment.size / 1024))} KB</small></span><button type="button" onClick={() => setCommentAttachment(null)} aria-label="Remove attached file">×</button></div>}</form>{selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong>{comment.body && <> {comment.body}</>}{comment.image && <img src={comment.image} alt={comment.body || 'Comment attachment'} />}{comment.file_data && (comment.file_mime_type?.startsWith('image/') ? <img src={comment.file_data} alt={comment.file_name || 'Comment attachment'} /> : <a className="comment-file-link" href={comment.file_data} download={comment.file_name || 'attachment'}><span className="file-mark">FILE</span><span>{comment.file_name || 'Attachment'}</span></a>)}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}</aside></div>}</dialog></main>
}

function CalendarApp({ active, initialEventId, openNotebook }: { active: boolean; initialEventId: number | null; openNotebook: (id: number) => void }) {
  const today = new Date()
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [events, setEvents] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<EventDetail | null>(null)
  const [notebooks, setNotebooks] = useState<LinkedNotebook[]>([])
  const [addingDate, setAddingDate] = useState<string | null>(null)
  const [commentImage, setCommentImage] = useState<string | null>(null)
  const [commentAttachment, setCommentAttachment] = useState<CommentAttachment | null>(null)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const addDialogRef = useRef<HTMLDialogElement>(null)
  const monthKey = isoDate(month).slice(0, 7)
  const loadEvents = useCallback(async () => { try { setEvents(await request<EventItem[]>(`/api/events?month=${monthKey}`)); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load calendar') } }, [monthKey])
  useEffect(() => {
    if (!active) return
    void loadEvents()
  }, [active, loadEvents])
  useEffect(() => {
    const refresh = () => { if (active) void loadEvents() }
    window.addEventListener('organizer-changed', refresh)
    return () => window.removeEventListener('organizer-changed', refresh)
  }, [active, loadEvents])
  useEffect(() => { if (initialEventId) void openEvent(initialEventId) }, [initialEventId])
  useEffect(() => { if (addingDate) addDialogRef.current?.showModal(); else addDialogRef.current?.close() }, [addingDate])
  useEffect(() => { if (selected) dialogRef.current?.showModal(); else dialogRef.current?.close() }, [selected])
  async function openEvent(id: number) { try { const [detail, options] = await Promise.all([request<EventDetail>(`/api/events/${id}`), request<LinkOptions>('/api/link-options')]); setSelected(detail); setNotebooks(options.notebooks); setDialogError(''); setCommentImage(null); setCommentAttachment(null) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open event') } }
  function closeEvent() { setSelected(null); setDialogError(''); setCommentImage(null); setCommentAttachment(null) }
  async function reloadSelected() { if (selected) setSelected(await request<EventDetail>(`/api/events/${selected.id}`)) }
  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!addingDate) return
    const data = new FormData(event.currentTarget)
    try { await request('/api/events', { method: 'POST', ...json({ title: String(data.get('title')).trim(), eventDate: addingDate, eventTime: String(data.get('startTime')), endTime: String(data.get('endTime')), color: String(data.get('color')), recurrence: String(data.get('recurrence')), recurrenceInterval: Number(data.get('recurrenceInterval')) }) }); setAddingDate(null); await loadEvents(); window.dispatchEvent(new Event('organizer-changed')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add event') }
  }
  async function saveEvent(changes: Record<string, unknown>) {
    if (!selected) return
    try { await request(`/api/events/${selected.id}`, { method: 'PATCH', ...json(changes) }); await reloadSelected(); await loadEvents(); setDialogError(''); window.dispatchEvent(new Event('organizer-changed')) }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not save event') }
  }
  async function deleteEvent() { if (!selected || !window.confirm(`Delete ${selected.is_deadline ? 'deadline' : 'event'} “${selected.title}”? This cannot be undone.`)) return; try { await request(`/api/events/${selected.id}`, { method: 'DELETE' }); closeEvent(); await loadEvents(); window.dispatchEvent(new Event('organizer-changed')) } catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not delete event') } }
  async function moveEvent(id: number, eventDate: string) { try { await request(`/api/events/${id}`, { method: 'PATCH', ...json({ eventDate }) }); await loadEvents() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not move event') } }
  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return
    const form = event.currentTarget
    const body = String(new FormData(form).get('comment') ?? '').trim()
    if (!body && !commentImage && !commentAttachment) return
    try { await request(`/api/events/${selected.id}/comments`, { method: 'POST', ...json({ body, image: commentImage, fileName: commentAttachment?.name ?? null, fileMimeType: commentAttachment?.mimeType ?? null, fileData: commentAttachment?.data ?? null, fileSize: commentAttachment?.size ?? null }) }); form.reset(); setCommentImage(null); setCommentAttachment(null); await reloadSelected() }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not add comment') }
  }
  async function pasteCommentImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile()
    if (!image) return
    event.preventDefault()
    if (image.size > 5_000_000) { setDialogError('Image must be 5 MB or smaller'); return }
    setCommentAttachment(null); setCommentImage(await fileToDataUrl(image))
  }
  async function attachCommentFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    if (file.size > 5_000_000) { setDialogError(`${file.name} must be 5 MB or smaller`); return }
    try { setCommentImage(null); setDialogError(''); setCommentAttachment({ name: file.name, mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file), size: file.size }) }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not attach file') }
  }
  const firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, index) => new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index))
  return <main className="workspace calendar-workspace"><nav className="calendar-nav" aria-label="Calendar controls"><button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button><h1>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1><button type="button" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button><button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></nav>{error && <p className="error" role="alert">{error}</p>}<section className="calendar-shell" aria-label={`${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} calendar`}><div className="weekday-row">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((day) => { const date = isoDate(day); const isToday = date === isoDate(today); const dayEvents = events.filter((item) => item.event_date === date); return <article className={`calendar-day${day.getMonth() !== month.getMonth() ? ' muted' : ''}${isToday ? ' today' : ''}`} key={date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveEvent(Number(event.dataTransfer.getData('text/plain')), date) }}><button className="day-number" type="button" onClick={() => setAddingDate(date)} aria-label={`Add event on ${day.toLocaleDateString()}`} aria-current={isToday ? 'date' : undefined}>{day.getDate()}</button><div className="day-events">{dayEvents.map((item) => <button className={`calendar-event color-${item.is_deadline ? 'red' : item.color}${item.is_deadline ? ' deadline' : ''}`} type="button" draggable key={item.id} onDragStart={(event) => event.dataTransfer.setData('text/plain', String(item.id))} onClick={() => void openEvent(item.id)}><time dateTime={`${item.event_date}T${item.event_time}`}>{readableTime(item.event_time)}{item.is_deadline ? '' : `–${readableTime(item.end_time)}`}</time><span>{item.title}</span>{item.recurrence_parent_id && <span aria-label="Recurring">↻</span>}</button>)}</div></article> })}</div></section><dialog ref={addDialogRef} className="event-dialog" aria-labelledby="add-event-title" onCancel={() => setAddingDate(null)}><form className="event-popup" onSubmit={(event) => void addEvent(event)}><header><div><h2 id="add-event-title">Add event</h2><p>{addingDate && readableDate(addingDate)}</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDate(null)}>×</button></header><label>Event<input name="title" autoFocus required placeholder="What are you planning?" /></label><div className="event-times"><label>Start<input name="startTime" type="time" defaultValue="09:00" required /></label><label>End<input name="endTime" type="time" defaultValue="10:00" required /></label></div><RecurrenceFields /><ColorPicker /><button className="event-submit" type="submit">Add event</button></form></dialog><dialog ref={dialogRef} className="card-dialog" aria-labelledby="event-dialog-title" onCancel={closeEvent}>{selected && <div className="dialog-layout"><section className="card-details"><button className="close" type="button" onClick={closeEvent} aria-label="Close event">×</button><div className="title-row"><span className={`circle color-${selected.color}`} /><div><input id="event-dialog-title" className="editable-title" defaultValue={selected.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== selected.title) void saveEvent({ title: event.target.value.trim() }) }} aria-label="Event title" /><p>{selected.is_deadline ? 'Deadline' : 'Scheduled event'}</p></div></div>{dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}{!selected.is_deadline && <ColorPicker name="event-color" value={selected.color} onChange={(color) => void saveEvent({ color })} />}<form className="schedule-block" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void saveEvent({ eventDate: String(data.get('date')), eventTime: String(data.get('startTime')), endTime: String(data.get('endTime')), recurrence: String(data.get('recurrence')), recurrenceInterval: Number(data.get('recurrenceInterval')) }) }}><label>Date<input name="date" type="date" defaultValue={selected.event_date} required /></label><label>Start time<input name="startTime" type="time" defaultValue={selected.event_time} required /></label>{!selected.is_deadline && <label>End time<input name="endTime" type="time" defaultValue={selected.end_time} required /></label>}<RecurrenceFields value={selected.recurrence} interval={selected.recurrence_interval} /><button type="submit">Save schedule</button></form><section className="detail-section"><h3>Description</h3><RecordDescription key={selected.id} value={selected.description} label="Event description" options={{ notebooks, events: [] }} onSave={(description) => void saveEvent({ description })} openNotebook={openNotebook} /></section><button className="danger-action" type="button" onClick={() => void deleteEvent()}>Delete {selected.is_deadline ? 'deadline' : 'event'}</button></section><aside className="activity"><header><h3>Comments and activity</h3></header><form className="comment-form" onSubmit={(event) => void addComment(event)}><div className="comment-composer"><textarea name="comment" rows={3} placeholder="Add a comment…" aria-label="Comment" onPaste={(event) => void pasteCommentImage(event)} /><div className="comment-toolbar"><div className="comment-tools" aria-label="Comment tools"><button type="button" className="comment-tool" aria-label="Bold" title="Bold" disabled><strong>B</strong></button><button type="button" className="comment-tool comment-tool-italic" aria-label="Italic" title="Italic" disabled><em>I</em></button><button type="button" className="comment-tool comment-tool-underline" aria-label="Underline" title="Underline" disabled><u>U</u></button><span className="comment-toolbar-divider" aria-hidden="true" /><label className="comment-attach" title="Attach image or file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg><input type="file" onChange={(event) => { void attachCommentFile(event.target.files); event.target.value = '' }} aria-label="Attach image or file" /></label></div><button className="comment-submit" type="submit">Post</button></div></div>{commentImage && <div className="comment-image-preview"><img src={commentImage} alt="Pasted attachment preview" /><button type="button" onClick={() => setCommentImage(null)} aria-label="Remove pasted image">×</button></div>}{commentAttachment && <div className="comment-file-preview">{commentAttachment.mimeType.startsWith('image/') ? <img src={commentAttachment.data} alt={commentAttachment.name + ' preview'} /> : <span className="file-mark">FILE</span>}<span className="comment-file-details"><strong>{commentAttachment.name}</strong><small>{Math.max(1, Math.round(commentAttachment.size / 1024))} KB</small></span><button type="button" onClick={() => setCommentAttachment(null)} aria-label="Remove attached file">×</button></div>}</form>{selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong>{comment.body && <> {comment.body}</>}{comment.image && <img src={comment.image} alt={comment.body || 'Comment attachment'} />}{comment.file_data && (comment.file_mime_type?.startsWith('image/') ? <img src={comment.file_data} alt={comment.file_name || 'Comment attachment'} /> : <a className="comment-file-link" href={comment.file_data} download={comment.file_name || 'attachment'}><span className="file-mark">FILE</span><span>{comment.file_name || 'Attachment'}</span></a>)}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}</aside></div>}</dialog></main>
}

function NotebooksApp({ active, initialNotebookId, openCard, openEvent }: { active: boolean; initialNotebookId: number | null; openCard: (id: number) => void; openEvent: (id: number) => void }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [selected, setSelected] = useState<Notebook | null>(null)
  const [backlinks, setBacklinks] = useState<Backlinks>({ cards: [], events: [] })
  const [error, setError] = useState('')
  const [addingNotebook, setAddingNotebook] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  async function loadNotebooks() { try { setNotebooks(await request<Notebook[]>('/api/notebooks')); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load notebooks') } }
  useEffect(() => { if (active) void loadNotebooks() }, [active])
  useEffect(() => { if (initialNotebookId && notebooks.length) { const notebook = notebooks.find((item) => item.id === initialNotebookId); if (notebook) void openNotebook(notebook) } }, [initialNotebookId, notebooks])
  useEffect(() => { if (selected) dialogRef.current?.showModal(); else dialogRef.current?.close() }, [selected])
  async function openNotebook(notebook: Notebook) { setSelected(notebook); setBacklinks(await request<Backlinks>(`/api/notebooks/${notebook.id}/backlinks`)) }
  function closeNotebook() { setSelected(null) }
  async function addNotebook(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const title = String(new FormData(form).get('title') ?? '').trim(); if (!title) return; try { await request('/api/notebooks', { method: 'POST', ...json({ title }) }); form.reset(); setAddingNotebook(false); await loadNotebooks() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add notebook') } }
  async function saveNotebook(changes: Partial<Pick<Notebook, 'title' | 'content' | 'images'>>) { if (!selected) return; try { const updated = await request<Notebook>(`/api/notebooks/${selected.id}`, { method: 'PATCH', ...json(changes) }); setSelected(updated); setNotebooks((current) => current.map((item) => item.id === updated.id ? updated : item)); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save notebook') } }
  async function deleteNotebook() { if (!selected || !window.confirm(`Delete notebook “${selected.title}”? This cannot be undone.`)) return; try { await request(`/api/notebooks/${selected.id}`, { method: 'DELETE' }); const id = selected.id; closeNotebook(); setNotebooks((current) => current.filter((item) => item.id !== id)) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete notebook') } }
  function insertImages(target: HTMLDivElement, files: File[]) { const images = files.filter((file) => file.type.startsWith('image/')); if (!images.length) return; void Promise.all(images.map(fileToDataUrl)).then((sources) => { target.focus(); for (const source of sources) document.execCommand('insertImage', false, source) }).catch(() => setError('Could not read image')) }
  function formatNotebook(command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList' | 'formatBlock', value?: string) { contentRef.current?.focus(); document.execCommand(command, false, value) }
  return <main className="workspace notebooks-workspace"><header className="notebooks-header"><div><h1>Notebooks</h1></div><span>{notebooks.length} {notebooks.length === 1 ? 'notebook' : 'notebooks'}</span></header>{error && <p className="error" role="alert">{error}</p>}<section className="notebook-board" aria-label="Notebooks"><article className="notebook-column"><header><h2>My notebooks</h2></header><div className="notebook-list">{notebooks.map((notebook) => <button className="notebook-card" type="button" key={notebook.id} onClick={() => void openNotebook(notebook)}><span aria-hidden="true">▮</span><strong>{notebook.title}</strong></button>)}</div>{addingNotebook ? <form className="notebook-add" onSubmit={(event) => void addNotebook(event)}><input name="title" autoFocus required placeholder="New notebook" aria-label="Notebook title" /><div><button type="submit">Add</button><button type="button" onClick={() => setAddingNotebook(false)}>Cancel</button></div></form> : <button className="notebook-add-trigger" type="button" onClick={() => setAddingNotebook(true)}>＋ Add notebook</button>}</article></section><dialog ref={dialogRef} className="notebook-dialog" aria-label={selected ? `Notebook: ${selected.title}` : 'Notebook'} onCancel={closeNotebook}>{selected && <div className="notebook-editor"><header><input key={`${selected.id}-title`} defaultValue={selected.title} aria-label="Notebook title" onBlur={(event) => void saveNotebook({ title: event.target.value })} /><button type="button" onClick={closeNotebook} aria-label="Close notebook">×</button></header><div className="notebook-toolbar" role="toolbar" aria-label="Text formatting" onMouseDown={(event) => event.preventDefault()}><button type="button" onClick={() => formatNotebook('bold')} aria-label="Bold"><strong>B</strong></button><button type="button" onClick={() => formatNotebook('italic')} aria-label="Italic"><em>I</em></button><button type="button" onClick={() => formatNotebook('underline')} aria-label="Underline"><u>U</u></button><span aria-hidden="true" /><button type="button" onClick={() => formatNotebook('formatBlock', 'h2')} aria-label="Heading">H</button><button type="button" onClick={() => formatNotebook('insertUnorderedList')} aria-label="Bulleted list">• List</button><button type="button" onClick={() => formatNotebook('insertOrderedList')} aria-label="Numbered list">1. List</button></div><div className="notebook-layout"><div className="notebook-content" ref={contentRef} key={`${selected.id}-content`} contentEditable suppressContentEditableWarning data-placeholder="Start writing or paste pictures…" dangerouslySetInnerHTML={{ __html: selected.content + selected.images.map((image) => `<img src="${image}" alt="">`).join('') }} onBlur={(event) => void saveNotebook({ content: event.currentTarget.innerHTML, images: [] })} onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); insertImages(event.currentTarget, files) } }} onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); insertImages(event.currentTarget, files) } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith('image/'))) event.preventDefault() }} aria-label="Notebook content" /><aside className="backlinks"><h2>Linked from</h2>{!backlinks.cards.length && !backlinks.events.length && <p>No linked records yet.</p>}{backlinks.cards.map((card) => <button type="button" key={`card-${card.id}`} onClick={() => openCard(card.id)}><strong>{card.title}</strong><small>{card.list_title}</small></button>)}{backlinks.events.map((event) => <button type="button" key={`event-${event.id}`} onClick={() => openEvent(event.id)}><strong>{event.title}</strong><small>{readableDate(event.event_date)}</small></button>)}</aside></div><footer><button className="danger-action" type="button" onClick={() => void deleteNotebook()}>Delete notebook</button></footer></div>}</dialog></main>
}

function App() {
  const [activeView, setActiveView] = useState<View>('today')
  const viewStackRef = useRef<HTMLElement>(null)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [openEventId, setOpenEventId] = useState<number | null>(null)
  const [openNotebookId, setOpenNotebookId] = useState<number | null>(null)
  const clearCardRequest = useCallback(() => setOpenCardId(null), [])
  const sectionRefs = {
    today: useRef<HTMLElement>(null),
    tasks: useRef<HTMLElement>(null),
    calendar: useRef<HTMLElement>(null),
    notebooks: useRef<HTMLElement>(null),
  }

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]
      const view = visible?.target.getAttribute('data-view') as View | null
      if (view) setActiveView(view)
    }, { threshold: [0.6] })
    viewStackRef.current?.querySelectorAll<HTMLElement>('.workspace-view').forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [])

  function navigate(next: View, id: number | null = null) {
    if (next === 'tasks') setOpenCardId(id)
    if (next === 'calendar') setOpenEventId(id)
    if (next === 'notebooks') setOpenNotebookId(id)
    sectionRefs[next].current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    })
  }

  return <div className="app-shell"><main className="view-stack" ref={viewStackRef} tabIndex={-1} aria-label="Organizer workspace"><section className="workspace-view" data-view="today" ref={sectionRefs.today} aria-label="Today"><TodayApp active={activeView === 'today'} openCard={setOpenCardId} openEvent={(id) => navigate('calendar', id)} openCalendar={() => navigate('calendar')} /></section><section className="workspace-view" data-view="tasks" ref={sectionRefs.tasks} aria-label="Tasks"><TasksApp active={activeView === 'tasks'} initialCardId={openCardId} onCardOpened={clearCardRequest} openNotebook={(id) => navigate('notebooks', id)} openEvent={(id) => navigate('calendar', id)} /></section><section className="workspace-view" data-view="calendar" ref={sectionRefs.calendar} aria-label="Calendar"><CalendarApp active={activeView === 'calendar'} initialEventId={openEventId} openNotebook={(id) => navigate('notebooks', id)} /></section><section className="workspace-view" data-view="notebooks" ref={sectionRefs.notebooks} aria-label="Notebooks"><NotebooksApp active={activeView === 'notebooks'} initialNotebookId={openNotebookId} openCard={(id) => navigate('tasks', id)} openEvent={(id) => navigate('calendar', id)} /></section></main></div>
}

export default App
