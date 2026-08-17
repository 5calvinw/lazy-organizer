import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
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
type Comment = { id: number; body: string; image: string | null; created_at: string }
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
const notebookLinkPattern = /\$\[([^\]\r\n]+)\]/g

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
function descriptionHtml(value: string) {
  let position = 0
  return Array.from(value.matchAll(notebookLinkPattern)).map((match) => {
    const prefix = escapeHtml(value.slice(position, match.index)).replace(/\n/g, '<br>')
    position = match.index + match[0].length
    return `${prefix}<button type="button" class="notebook-chip" data-notebook="${escapeHtml(match[1].trim())}" contenteditable="false">${escapeHtml(match[1].trim())}</button>`
  }).join('') + escapeHtml(value.slice(position)).replace(/\n/g, '<br>')
}
function serializeDescription(element: HTMLElement) {
  return Array.from(element.childNodes).map((node) => {
    if (node instanceof HTMLElement && node.dataset.notebook) return `$[${node.dataset.notebook}]`
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
function NotebookDescription({ value, label, onSave, openNotebook }: { value: string; label: string; onSave: (value: string) => void; openNotebook: (title: string) => void }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const matchRange = useRef<Range | null>(null)
  useEffect(() => { void request<Notebook[]>('/api/notebooks').then(setNotebooks) }, [])
  useEffect(() => { if (editorRef.current) editorRef.current.innerHTML = descriptionHtml(value) }, [value])
  const matches = query === null || query.length < 2 ? [] : notebooks.filter((notebook) => notebook.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 6)
  function update() {
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const fragment = range?.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.textContent?.slice(0, range.startOffset).match(/\$([\p{L}\p{N}_ -]*)$/u)?.[1] : undefined
    matchRange.current = fragment === undefined || !range ? null : range.cloneRange()
    setQuery(fragment !== undefined && fragment.length >= 2 ? fragment : null)
    setActive(0)
  }
  function choose(title: string) {
    const selection = window.getSelection()
    const range = matchRange.current
    if (!selection || !range || query === null || range.startContainer.nodeType !== Node.TEXT_NODE) return
    range.setStart(range.startContainer, Math.max(0, range.startOffset - query.length - 1))
    range.deleteContents()
    const wrapper = document.createElement('span')
    wrapper.innerHTML = `<button type="button" class="notebook-chip" data-notebook="${escapeHtml(title)}" contenteditable="false">${escapeHtml(title)}</button>&nbsp;`
    const fragment = document.createDocumentFragment()
    while (wrapper.firstChild) fragment.append(wrapper.firstChild)
    range.insertNode(fragment)
    selection.collapseToEnd()
    setQuery(null)
    editorRef.current?.focus()
  }
  return <div className="description-autocomplete"><div ref={editorRef} className="description-editor" contentEditable suppressContentEditableWarning data-placeholder="Add a more detailed description…" onInput={update} onKeyDown={(event) => { if (!matches.length || query === null) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length) } if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(matches[active].title) } if (event.key === 'Escape') { event.preventDefault(); setQuery(null) } }} onBlur={(event) => onSave(serializeDescription(event.currentTarget))} onClick={(event) => { const chip = (event.target as HTMLElement).closest<HTMLElement>('.notebook-chip'); if (chip?.dataset.notebook) openNotebook(chip.dataset.notebook) }} role="textbox" aria-multiline="true" aria-label={label} />{query !== null && matches.length > 0 && <div className="notebook-suggestions" role="listbox" aria-label="Notebook suggestions">{matches.map((notebook, index) => <button className={index === active ? 'active' : ''} type="button" role="option" aria-selected={index === active} key={notebook.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(notebook.title)}>{notebook.title}</button>)}</div>}</div>
}

function TodayApp({ openCard, openEvent }: { openCard: (id: number) => void; openEvent: (id: number) => void }) {
  const [data, setData] = useState<TodayData | null>(null)
  const [error, setError] = useState('')
  async function load() {
    try { setData(await request<TodayData>('/api/today')); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load today') }
  }
  useEffect(() => { void load() }, [])
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const title = String(new FormData(form).get('title') ?? '').trim()
    if (!title) return
    try { await request('/api/today/tasks', { method: 'POST', ...json({ title }) }); form.reset(); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add task') }
  }
  const TaskGroup = ({ title, cards, tone }: { title: string; cards: Card[]; tone?: string }) => <section className={`today-group${tone ? ` ${tone}` : ''}`}><header><h2>{title}</h2><span>{cards.length}</span></header>{cards.length ? <div className="today-items">{cards.map((card) => <button type="button" key={card.id} onClick={() => openCard(card.id)}><span className={`status-dot color-${card.color}`} /><span><strong>{card.title}</strong><small>{card.list_title}{card.due_date ? ` · ${readableDate(card.due_date)}` : ''}</small></span><CardMeta card={card} /></button>)}</div> : <p className="empty-copy">Nothing here.</p>}</section>
  return <main className="workspace today-workspace"><header className="today-header"><div><p>{data ? new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' }) : 'Today'}</p><h1>{data ? readableDate(data.date) : 'Today'}</h1></div><form className="quick-capture" onSubmit={(event) => void capture(event)}><label htmlFor="quick-capture">Add something for today</label><div><input id="quick-capture" name="title" placeholder="What needs your attention?" required /><button type="submit">Add task</button></div></form></header>{error && <p className="error" role="alert">{error}</p>}{!data ? <p className="loading-copy" role="status">Gathering today…</p> : <div className="today-grid"><TaskGroup title="Overdue" cards={data.overdue} tone="urgent" /><TaskGroup title="Due today" cards={data.dueToday} /><section className="today-group agenda"><header><h2>Schedule</h2><span>{data.events.length}</span></header>{data.events.length ? <div className="today-items">{data.events.map((item) => <button type="button" key={item.id} onClick={() => openEvent(item.id)}><time dateTime={`${item.event_date}T${item.event_time}`}>{readableTime(item.event_time)}</time><span><strong>{item.title}</strong><small>{item.is_deadline ? 'Deadline' : `${readableTime(item.event_time)}–${readableTime(item.end_time)}`}</small></span></button>)}</div> : <p className="empty-copy">Your day is open.</p>}</section><TaskGroup title="In progress" cards={data.doing} /></div>}</main>
}

function TasksApp({ initialCardId, openNotebook, openEvent }: { initialCardId: number | null; openNotebook: (id: number) => void; openEvent: (id: number) => void }) {
  const [lists, setLists] = useState<List[]>([])
  const [deadlines, setDeadlines] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<CardDetail | null>(null)
  const [linkOptions, setLinkOptions] = useState<LinkOptions | null>(null)
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [addingDeadline, setAddingDeadline] = useState(false)
  const [commentImage, setCommentImage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deadlineDialogRef = useRef<HTMLDialogElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const dragOrigin = useRef<List[] | null>(null)
  async function loadBoard() {
    try {
      const [board, upcoming] = await Promise.all([request<List[]>('/api/board'), request<EventItem[]>('/api/deadlines')])
      setLists(board); setDeadlines(upcoming); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load tasks') }
  }
  useEffect(() => { void loadBoard() }, [])
  useEffect(() => { if (initialCardId) void openCard(initialCardId) }, [initialCardId])
  useEffect(() => { if (addingDeadline) deadlineDialogRef.current?.showModal(); else deadlineDialogRef.current?.close() }, [addingDeadline])
  useEffect(() => { if (selected) dialogRef.current?.showModal(); else dialogRef.current?.close() }, [selected])
  async function openCard(id: number) {
    try {
      const [detail, options] = await Promise.all([request<CardDetail>(`/api/cards/${id}`), request<LinkOptions>('/api/link-options')])
      setSelected(detail); setLinkOptions(options); setDialogError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open task') }
  }
  function closeCard() { setSelected(null); setDialogError('') }
  async function reloadSelected() { if (selected) setSelected(await request<CardDetail>(`/api/cards/${selected.id}`)) }
  async function saveCard(changes: Record<string, unknown>) {
    if (!selected) return
    try {
      await request(`/api/cards/${selected.id}`, { method: 'PATCH', ...json(changes) })
      await Promise.all([reloadSelected(), loadBoard()]); setDialogError('')
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
    if (!body && !commentImage) return
    try { await request(`/api/cards/${selected.id}/comments`, { method: 'POST', ...json({ body, image: commentImage }) }); form.reset(); setCommentImage(null); await reloadSelected() }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : 'Could not add comment') }
  }
  async function pasteCommentImage(event: ClipboardEvent<HTMLInputElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile()
    if (!image) return
    event.preventDefault()
    if (image.size > 5_000_000) { setDialogError('Image must be 5 MB or smaller'); return }
    setCommentImage(await fileToDataUrl(image))
  }
  async function addChecklist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return
    const form = event.currentTarget
    const title = String(new FormData(form).get('title') ?? '').trim()
    if (!title) return
    await request(`/api/cards/${selected.id}/checklist`, { method: 'POST', ...json({ title }) }); form.reset(); await reloadSelected(); await loadBoard()
  }
  async function changeChecklist(id: number, changes: Record<string, unknown>) { await request(`/api/checklist/${id}`, { method: 'PATCH', ...json(changes) }); await reloadSelected(); await loadBoard() }
  async function checklistAction(id: number, action: 'delete' | 'convert' | 'up' | 'down') {
    if (action === 'delete') await request(`/api/checklist/${id}`, { method: 'DELETE' })
    else if (action === 'convert') await request(`/api/checklist/${id}/convert`, { method: 'POST' })
    else await request(`/api/checklist/${id}/move`, { method: 'PATCH', ...json({ direction: action }) })
    await reloadSelected(); await loadBoard()
  }
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
  async function addLink(event: FormEvent<HTMLFormElement>, type: 'event' | 'notebook') {
    event.preventDefault(); if (!selected) return
    const targetId = Number(new FormData(event.currentTarget).get('targetId'))
    if (!targetId) return
    await request(`/api/cards/${selected.id}/links`, { method: 'POST', ...json({ type, targetId }) }); await reloadSelected()
  }
  async function removeLink(type: 'event' | 'notebook', targetId: number) { if (!selected) return; await request(`/api/cards/${selected.id}/links/${type}/${targetId}`, { method: 'DELETE' }); await reloadSelected() }
  return <main className="workspace tasks-workspace">{error && <p className="error" role="alert">{error}</p>}<section className="board" aria-label="Task board">{lists.map((list) => <article className={`list${dragging !== null ? ' is-dragging' : ''}`} key={list.id} onDragOver={(event) => { event.preventDefault(); if (dragging !== null) moveLocally(dragging, list.id, list.cards.length) }} onDrop={(event) => void dropCard(event, list.id, list.cards.length)}><header className="list-header"><h2>{list.title}</h2><span>{list.cards.length}</span></header><div className="card-stack">{list.cards.map((card, index) => <button className={`task-card color-${card.color}${dragging === card.id ? ' dragging' : ''}`} key={card.id} type="button" draggable onDragStart={(event) => { dragOrigin.current = lists; setDragging(card.id); event.dataTransfer.setData('text/plain', String(card.id)) }} onDragEnd={() => { setDragging(null); dragOrigin.current = null }} onDragOver={(event) => { event.stopPropagation(); event.preventDefault(); if (dragging !== null) moveLocally(dragging, list.id, index) }} onDrop={(event) => { event.stopPropagation(); void dropCard(event, list.id, index) }} onClick={() => { if (dragging === null) void openCard(card.id) }}><strong>{card.title}</strong><CardMeta card={card} /></button>)}</div>{addingTo === list.id ? <form className="add-form" onSubmit={(event) => void addCard(event, list.id)}><textarea name="title" autoFocus placeholder="Enter a task title…" aria-label="Task title" /><div><button className="primary" type="submit">Add task</button><button type="button" onClick={() => setAddingTo(null)} aria-label="Cancel">×</button></div></form> : <button className="add-card" type="button" onClick={() => setAddingTo(list.id)}><span>＋</span> Add a task</button>}</article>)}<aside className="deadlines" aria-labelledby="deadlines-title"><header><h2 id="deadlines-title">Deadlines</h2><button className="deadline-add" type="button" onClick={() => setAddingDeadline(true)} aria-label="Add deadline">＋</button></header>{deadlines.length ? <ol>{deadlines.map((deadline) => <li key={deadline.id}><button type="button" onClick={() => openEvent(deadline.id)}><time dateTime={`${deadline.event_date}T${deadline.event_time}`}><strong>{readableDate(deadline.event_date)}</strong><span>{readableTime(deadline.event_time)}</span></time><span>{deadline.title}</span></button></li>)}</ol> : <p className="deadlines-empty">No upcoming deadlines.</p>}</aside></section><dialog ref={deadlineDialogRef} className="event-dialog" aria-labelledby="add-deadline-title" onCancel={() => setAddingDeadline(false)}><form className="event-popup" onSubmit={(event) => void addDeadline(event)}><header><div><h2 id="add-deadline-title">Add deadline</h2><p>This also appears in your calendar.</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDeadline(false)}>×</button></header><label>Title<input name="title" autoFocus required placeholder="What is due?" /></label><label>Date<input name="date" type="date" defaultValue={isoDate(new Date())} required /></label><label>Time<input name="time" type="time" defaultValue="09:00" required /></label><RecurrenceFields /><button className="event-submit" type="submit">Add deadline</button></form></dialog><dialog ref={dialogRef} className="card-dialog" aria-labelledby="task-dialog-title" onCancel={closeCard}>{selected && <div className="dialog-layout"><section className="card-details"><button className="close" type="button" onClick={closeCard} aria-label="Close task">×</button><div className="title-row"><span className={`circle color-${selected.color}`} /><div><input id="task-dialog-title" className="editable-title" defaultValue={selected.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== selected.title) void saveCard({ title: event.target.value.trim() }) }} aria-label="Task title" /><p>in list <strong>{selected.list_title}</strong></p></div></div>{dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}<form className="metadata-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void saveCard({ dueDate: String(data.get('dueDate')) || null, priority: String(data.get('priority')), recurrence: String(data.get('recurrence')), recurrenceInterval: Number(data.get('recurrenceInterval')) }) }}><label>Due date<input name="dueDate" type="date" defaultValue={selected.due_date ?? ''} /></label><label>Priority<select name="priority" defaultValue={selected.priority}><option value="none">No priority</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><RecurrenceFields value={selected.recurrence} interval={selected.recurrence_interval} /><button type="submit">Save details</button></form><div className="move-row"><label>Move to<select value={selected.list_id} onChange={(event) => { const listId = Number(event.target.value); void moveCard(selected.id, listId, lists.find((list) => list.id === listId)?.cards.length ?? 0).then(() => openCard(selected.id)) }}>{lists.map((list) => <option value={list.id} key={list.id}>{list.title}</option>)}</select></label><ColorPicker name="card-color" value={selected.color} onChange={(color) => void saveCard({ color })} /></div><section className="detail-section"><h3>Description</h3><NotebookDescription key={`${selected.id}-${selected.description}`} value={selected.description} label="Task description" onSave={(description) => void saveCard({ description })} openNotebook={(title) => { const notebook = linkOptions?.notebooks.find((item) => item.title.localeCompare(title, undefined, { sensitivity: 'base' }) === 0); if (notebook) openNotebook(notebook.id); else setDialogError(`Notebook “${title}” was not found`) }} /></section><section className="detail-section"><header><h3>Checklist</h3><span>{selected.checklist_completed}/{selected.checklist_count}</span></header><div className="checklist">{selected.checklist.map((item, index) => <div key={item.id}><input type="checkbox" checked={Boolean(item.completed)} onChange={(event) => void changeChecklist(item.id, { completed: event.target.checked })} aria-label={`Complete ${item.title}`} /><input defaultValue={item.title} onBlur={(event) => { const title = event.target.value.trim(); if (title && title !== item.title) void changeChecklist(item.id, { title }) }} aria-label="Checklist item" /><span className="checklist-actions"><button type="button" onClick={() => void checklistAction(item.id, 'up')} disabled={index === 0} aria-label="Move item up">↑</button><button type="button" onClick={() => void checklistAction(item.id, 'down')} disabled={index === selected.checklist.length - 1} aria-label="Move item down">↓</button><button type="button" onClick={() => void checklistAction(item.id, 'convert')}>Make task</button><button type="button" onClick={() => void checklistAction(item.id, 'delete')} aria-label="Delete checklist item">×</button></span></div>)}</div><form className="inline-add" onSubmit={(event) => void addChecklist(event)}><input name="title" placeholder="Add checklist item" aria-label="New checklist item" /><button type="submit">Add</button></form></section><section className="detail-section"><header><h3>Attachments</h3><span>{selected.attachments.length}</span></header><div className="attachments">{selected.attachments.map((item) => <div key={item.id}><a href={item.data} download={item.name}>{item.mime_type.startsWith('image/') ? <img src={item.data} alt="" /> : <span className="file-mark">FILE</span>}<span><strong>{item.name}</strong><small>{Math.max(1, Math.round(item.size / 1024))} KB</small></span></a><button type="button" onClick={() => void deleteAttachment(item.id)} aria-label={`Remove ${item.name}`}>×</button></div>)}</div><label className="attachment-add">Attach files<input type="file" multiple onChange={(event) => { void addAttachments(event.target.files); event.target.value = '' }} /></label></section><section className="detail-section"><header><h3>Linked records</h3></header><div className="linked-records">{selected.links.events.map((item) => <div key={`event-${item.id}`}><button type="button" onClick={() => openEvent(item.id)}><strong>{item.title}</strong><small>{readableDate(item.event_date)}</small></button><button type="button" onClick={() => void removeLink('event', item.id)} aria-label={`Unlink ${item.title}`}>×</button></div>)}{selected.links.notebooks.map((item) => <div key={`notebook-${item.id}`}><button type="button" onClick={() => openNotebook(item.id)}><strong>{item.title}</strong><small>Notebook</small></button><button type="button" onClick={() => void removeLink('notebook', item.id)} aria-label={`Unlink ${item.title}`}>×</button></div>)}</div><div className="link-forms"><form onSubmit={(event) => void addLink(event, 'event')}><select name="targetId" aria-label="Event to link"><option value="">Choose event…</option>{linkOptions?.events.filter((item) => !selected.links.events.some((link) => link.id === item.id)).map((item) => <option value={item.id} key={item.id}>{readableDate(item.event_date)} · {item.title}</option>)}</select><button type="submit">Link event</button></form><form onSubmit={(event) => void addLink(event, 'notebook')}><select name="targetId" aria-label="Notebook to link"><option value="">Choose notebook…</option>{linkOptions?.notebooks.filter((item) => !selected.links.notebooks.some((link) => link.id === item.id)).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select><button type="submit">Link notebook</button></form></div></section><button className="danger-action" type="button" onClick={() => void deleteCard()}>Delete task</button></section><aside className="activity"><header><h3>Comments and activity</h3></header><form className="comment-form" onSubmit={(event) => void addComment(event)}><input name="comment" placeholder="Write a comment or paste an image…" aria-label="Comment" onPaste={(event) => void pasteCommentImage(event)} />{commentImage && <div className="comment-image-preview"><img src={commentImage} alt="Pasted attachment preview" /><button type="button" onClick={() => setCommentImage(null)} aria-label="Remove pasted image">×</button></div>}<button type="submit">Post</button></form>{selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong>{comment.body && <> {comment.body}</>}{comment.image && <img src={comment.image} alt={comment.body || 'Comment attachment'} />}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}</aside></div>}</dialog></main>
}

function CalendarApp({ initialEventId, openNotebook }: { initialEventId: number | null; openNotebook: (id: number) => void }) {
  const today = new Date()
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [events, setEvents] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<EventDetail | null>(null)
  const [notebooks, setNotebooks] = useState<LinkedNotebook[]>([])
  const [addingDate, setAddingDate] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const addDialogRef = useRef<HTMLDialogElement>(null)
  const monthKey = isoDate(month).slice(0, 7)
  async function loadEvents() { try { setEvents(await request<EventItem[]>(`/api/events?month=${monthKey}`)); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load calendar') } }
  useEffect(() => { void loadEvents() }, [monthKey])
  useEffect(() => { if (initialEventId) void openEvent(initialEventId) }, [initialEventId])
  useEffect(() => { if (addingDate) addDialogRef.current?.showModal(); else addDialogRef.current?.close() }, [addingDate])
  useEffect(() => { if (selected) dialogRef.current?.showModal(); else dialogRef.current?.close() }, [selected])
  async function openEvent(id: number) { try { const [detail, options] = await Promise.all([request<EventDetail>(`/api/events/${id}`), request<LinkOptions>('/api/link-options')]); setSelected(detail); setNotebooks(options.notebooks); setDialogError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open event') } }
  function closeEvent() { setSelected(null); setDialogError('') }
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
  async function addComment(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!selected) return; const form = event.currentTarget; const body = String(new FormData(form).get('comment') ?? '').trim(); if (!body) return; await request(`/api/events/${selected.id}/comments`, { method: 'POST', ...json({ body }) }); form.reset(); await reloadSelected() }
  async function linkNotebook(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!selected) return; const notebookId = Number(new FormData(event.currentTarget).get('notebookId')); if (!notebookId) return; await request(`/api/events/${selected.id}/notebook-links`, { method: 'POST', ...json({ notebookId }) }); await reloadSelected() }
  async function unlinkNotebook(id: number) { if (!selected) return; await request(`/api/events/${selected.id}/notebook-links/${id}`, { method: 'DELETE' }); await reloadSelected() }
  const firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, index) => new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index))
  return <main className="workspace calendar-workspace"><nav className="calendar-nav" aria-label="Calendar controls"><button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button><h1>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1><button type="button" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button><button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></nav>{error && <p className="error" role="alert">{error}</p>}<section className="calendar-shell" aria-label={`${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} calendar`}><div className="weekday-row">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((day) => { const date = isoDate(day); const isToday = date === isoDate(today); const dayEvents = events.filter((item) => item.event_date === date); return <article className={`calendar-day${day.getMonth() !== month.getMonth() ? ' muted' : ''}${isToday ? ' today' : ''}`} key={date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void moveEvent(Number(event.dataTransfer.getData('text/plain')), date) }}><button className="day-number" type="button" onClick={() => setAddingDate(date)} aria-label={`Add event on ${day.toLocaleDateString()}`} aria-current={isToday ? 'date' : undefined}>{day.getDate()}</button><div className="day-events">{dayEvents.map((item) => <button className={`calendar-event color-${item.is_deadline ? 'red' : item.color}${item.is_deadline ? ' deadline' : ''}`} type="button" draggable key={item.id} onDragStart={(event) => event.dataTransfer.setData('text/plain', String(item.id))} onClick={() => void openEvent(item.id)}><time dateTime={`${item.event_date}T${item.event_time}`}>{readableTime(item.event_time)}{item.is_deadline ? '' : `–${readableTime(item.end_time)}`}</time><span>{item.title}</span>{item.recurrence_parent_id && <span aria-label="Recurring">↻</span>}</button>)}</div></article> })}</div></section><dialog ref={addDialogRef} className="event-dialog" aria-labelledby="add-event-title" onCancel={() => setAddingDate(null)}><form className="event-popup" onSubmit={(event) => void addEvent(event)}><header><div><h2 id="add-event-title">Add event</h2><p>{addingDate && readableDate(addingDate)}</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDate(null)}>×</button></header><label>Event<input name="title" autoFocus required placeholder="What are you planning?" /></label><div className="event-times"><label>Start<input name="startTime" type="time" defaultValue="09:00" required /></label><label>End<input name="endTime" type="time" defaultValue="10:00" required /></label></div><RecurrenceFields /><ColorPicker /><button className="event-submit" type="submit">Add event</button></form></dialog><dialog ref={dialogRef} className="card-dialog" aria-labelledby="event-dialog-title" onCancel={closeEvent}>{selected && <div className="dialog-layout"><section className="card-details"><button className="close" type="button" onClick={closeEvent} aria-label="Close event">×</button><div className="title-row"><span className={`circle color-${selected.color}`} /><div><input id="event-dialog-title" className="editable-title" defaultValue={selected.title} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== selected.title) void saveEvent({ title: event.target.value.trim() }) }} aria-label="Event title" /><p>{selected.is_deadline ? 'Deadline' : 'Scheduled event'}</p></div></div>{dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}{!selected.is_deadline && <ColorPicker name="event-color" value={selected.color} onChange={(color) => void saveEvent({ color })} />}<form className="schedule-block" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void saveEvent({ eventDate: String(data.get('date')), eventTime: String(data.get('startTime')), endTime: String(data.get('endTime')), recurrence: String(data.get('recurrence')), recurrenceInterval: Number(data.get('recurrenceInterval')) }) }}><label>Date<input name="date" type="date" defaultValue={selected.event_date} required /></label><label>Start time<input name="startTime" type="time" defaultValue={selected.event_time} required /></label>{!selected.is_deadline && <label>End time<input name="endTime" type="time" defaultValue={selected.end_time} required /></label>}<RecurrenceFields value={selected.recurrence} interval={selected.recurrence_interval} /><button type="submit">Save schedule</button></form><section className="detail-section"><h3>Description</h3><NotebookDescription key={`${selected.id}-${selected.description}`} value={selected.description} label="Event description" onSave={(description) => void saveEvent({ description })} openNotebook={(title) => { const notebook = notebooks.find((item) => item.title.localeCompare(title, undefined, { sensitivity: 'base' }) === 0); if (notebook) openNotebook(notebook.id); else setDialogError(`Notebook “${title}” was not found`) }} /></section><section className="detail-section"><header><h3>Linked notebooks</h3></header><div className="linked-records">{selected.notebooks.map((item) => <div key={item.id}><button type="button" onClick={() => openNotebook(item.id)}><strong>{item.title}</strong><small>Notebook</small></button><button type="button" onClick={() => void unlinkNotebook(item.id)} aria-label={`Unlink ${item.title}`}>×</button></div>)}</div><form className="inline-add" onSubmit={(event) => void linkNotebook(event)}><select name="notebookId" aria-label="Notebook to link"><option value="">Choose notebook…</option>{notebooks.filter((item) => !selected.notebooks.some((linked) => linked.id === item.id)).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select><button type="submit">Link</button></form></section><button className="danger-action" type="button" onClick={() => void deleteEvent()}>Delete {selected.is_deadline ? 'deadline' : 'event'}</button></section><aside className="activity"><header><h3>Comments and activity</h3></header><form className="comment-form" onSubmit={(event) => void addComment(event)}><input name="comment" placeholder="Write a comment…" aria-label="Comment" /><button type="submit">Post</button></form>{selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong> {comment.body}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}</aside></div>}</dialog></main>
}

function NotebooksApp({ initialNotebookId, openCard, openEvent }: { initialNotebookId: number | null; openCard: (id: number) => void; openEvent: (id: number) => void }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [selected, setSelected] = useState<Notebook | null>(null)
  const [backlinks, setBacklinks] = useState<Backlinks>({ cards: [], events: [] })
  const [error, setError] = useState('')
  const [addingNotebook, setAddingNotebook] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  async function loadNotebooks() { try { setNotebooks(await request<Notebook[]>('/api/notebooks')); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load notebooks') } }
  useEffect(() => { void loadNotebooks() }, [])
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
  const [view, setView] = useState<View>('today')
  const [openId, setOpenId] = useState<number | null>(null)
  function navigate(next: View, id: number | null = null) { setOpenId(id); setView(next) }
  return <div className="app-shell"><nav className="app-nav" aria-label="Main navigation"><strong>Lazy organizer</strong><div>{(['today', 'tasks', 'calendar', 'notebooks'] as View[]).map((item) => <button type="button" key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => navigate(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></nav><div className="view-host">{view === 'today' && <TodayApp openCard={(id) => navigate('tasks', id)} openEvent={(id) => navigate('calendar', id)} />}{view === 'tasks' && <TasksApp initialCardId={openId} openNotebook={(id) => navigate('notebooks', id)} openEvent={(id) => navigate('calendar', id)} />}{view === 'calendar' && <CalendarApp initialEventId={openId} openNotebook={(id) => navigate('notebooks', id)} />}{view === 'notebooks' && <NotebooksApp initialNotebookId={openId} openCard={(id) => navigate('tasks', id)} openEvent={(id) => navigate('calendar', id)} />}</div></div>
}

export default App
