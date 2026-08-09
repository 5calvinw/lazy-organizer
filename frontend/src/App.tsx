import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import './App.css'

type Card = { id: number; list_id: number; title: string; description: string; created_at: string }
type List = { id: number; title: string; cards: Card[] }
type Comment = { id: number; body: string; created_at: string }
type CardDetail = Card & { list_title: string; comments: Comment[] }
type EventItem = { id: number; title: string; description: string; event_date: string; event_time: string; end_time: string; is_deadline: number; created_at: string }
type EventDetail = EventItem & { comments: Comment[] }
type Notebook = { id: number; title: string; content: string; images: string[]; created_at: string }
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed')
  return response.json()
}

function TasksApp() {
  const [lists, setLists] = useState<List[]>([])
  const [deadlines, setDeadlines] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<CardDetail | null>(null)
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [addingDeadline, setAddingDeadline] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const deadlineDialogRef = useRef<HTMLDialogElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const dragOrigin = useRef<List[] | null>(null)

  async function loadBoard() {
    try {
      const [board, upcoming] = await Promise.all([request<List[]>('/api/board'), request<EventItem[]>('/api/deadlines')])
      setLists(board)
      setDeadlines(upcoming)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load board')
    }
  }

  useEffect(() => { void loadBoard() }, [])

  useEffect(() => {
    if (addingDeadline) deadlineDialogRef.current?.showModal()
    else deadlineDialogRef.current?.close()
  }, [addingDeadline])

  async function addDeadline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await request('/api/deadlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: String(data.get('title') ?? '').trim(), eventDate: String(data.get('date')), eventTime: String(data.get('time')) }),
      })
      form.reset()
      setAddingDeadline(false)
      await loadBoard()
      window.dispatchEvent(new Event('calendar-events-changed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add deadline')
    }
  }


  async function openCard(id: number) {
    try {
      setSelected(await request<CardDetail>(`/api/cards/${id}`))
      dialogRef.current?.showModal()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open card')
    }
  }

  function closeCard() {
    dialogRef.current?.close()
    setSelected(null)
  }

  function moveLocally(cardId: number, listId: number, index: number) {
    setLists((current) => {
      const next = current.map((list) => ({ ...list, cards: [...list.cards] }))
      const source = next.find((list) => list.cards.some((card) => card.id === cardId))
      const destination = next.find((list) => list.id === listId)
      if (!source || !destination) return current
      const [card] = source.cards.splice(source.cards.findIndex((item) => item.id === cardId), 1)
      destination.cards.splice(Math.min(index, destination.cards.length), 0, { ...card, list_id: listId })
      return next
    })
  }

  function dragStart(event: DragEvent<HTMLButtonElement>, cardId: number) {
    dragOrigin.current = lists
    setDragging(cardId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(cardId))
  }

  function dragOver(event: DragEvent, listId: number, index: number) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragging !== null) moveLocally(dragging, listId, index)
  }

  async function dropCard(event: DragEvent, listId: number, index: number) {
    event.preventDefault()
    if (dragging === null) return
    moveLocally(dragging, listId, index)
    const snapshot = lists
    setDragging(null)
    try {
      await request(`/api/cards/${dragging}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listId, index }),
      })
      await loadBoard()
    } catch (cause) {
      setLists(dragOrigin.current ?? snapshot)
      setError(cause instanceof Error ? cause.message : 'Could not move card')
    } finally {
      dragOrigin.current = null
    }
  }

  async function addCard(event: FormEvent<HTMLFormElement>, listId: number) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    if (!title) return
    await request(`/api/lists/${listId}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    setAddingTo(null)
    await loadBoard()
  }

  async function saveDescription(description: string) {
    if (!selected) return
    const card = await request<CardDetail>(`/api/cards/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    })
    setSelected((current) => current ? { ...current, ...card } : current)
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const formElement = event.currentTarget
    const body = String(new FormData(formElement).get('comment') ?? '').trim()
    if (!body) return
    const comment = await request<Comment>(`/api/cards/${selected.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    setSelected({ ...selected, comments: [comment, ...selected.comments] })
    formElement.reset()
  }

  return (
    <main className="workspace">


      {error && <p className="error" role="alert">{error}</p>}

      <section className="board" aria-label="Task board">
        {lists.map((list) => (
          <article
            className={`list${dragging !== null ? ' is-dragging' : ''}`}
            key={list.id}
            onDragOver={(event) => dragOver(event, list.id, list.cards.length)}
            onDrop={(event) => void dropCard(event, list.id, list.cards.length)}
          >
            <header className="list-header">
              <h2>{list.title}</h2>
              <span>{list.cards.length}</span>
            </header>
            <div className="card-stack">
              {list.cards.map((card, index) => (
                <button
                  className={`task-card${dragging === card.id ? ' dragging' : ''}`}
                  key={card.id}
                  type="button"
                  draggable
                  onDragStart={(event) => dragStart(event, card.id)}
                  onDragEnd={() => { setDragging(null); dragOrigin.current = null }}
                  onDragOver={(event) => { event.stopPropagation(); dragOver(event, list.id, index) }}
                  onDrop={(event) => { event.stopPropagation(); void dropCard(event, list.id, index) }}
                  onClick={() => { if (dragging === null) void openCard(card.id) }}
                >
                  {card.title}
                </button>
              ))}
            </div>
            {addingTo === list.id ? (
              <form className="add-form" onSubmit={(event) => void addCard(event, list.id)}>
                <textarea name="title" autoFocus placeholder="Enter a title for this card…" aria-label="Card title" />
                <div>
                  <button className="primary" type="submit">Add card</button>
                  <button type="button" onClick={() => setAddingTo(null)} aria-label="Cancel">×</button>
                </div>
              </form>
            ) : (
              <button className="add-card" type="button" onClick={() => setAddingTo(list.id)}><span>＋</span> Add a card</button>
            )}
          </article>
        ))}
        <aside className="deadlines" aria-labelledby="deadlines-title">
          <header>
            <h2 id="deadlines-title">Deadlines</h2>
            <button className="deadline-add" type="button" onClick={() => setAddingDeadline(true)} aria-label="Add deadline">＋</button>
          </header>
          {deadlines.length ? (
            <ol>
              {deadlines.map((deadline) => (
                <li key={deadline.id}>
                  <time dateTime={`${deadline.event_date}T${deadline.event_time}`}>
                    <strong>{new Date(`${deadline.event_date}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</strong>
                    <span>{new Date(`${deadline.event_date}T${deadline.event_time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  </time>
                  <p>{deadline.title}</p>
                </li>
              ))}
            </ol>
          ) : <p className="deadlines-empty">No upcoming deadlines.</p>}
        </aside>
      </section>

      <dialog ref={deadlineDialogRef} className="event-dialog" onCancel={() => setAddingDeadline(false)} onClick={(event) => { if (event.target === deadlineDialogRef.current) setAddingDeadline(false) }}>
        <form className="event-popup" onSubmit={(event) => void addDeadline(event)}>
          <header><div><h2>Add deadline</h2><p>This will also appear in your calendar.</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDeadline(false)}>×</button></header>
          <label>Title<input name="title" autoFocus required placeholder="What is due?" /></label>
          <label>Date<input name="date" type="date" defaultValue={isoDate(new Date())} required /></label>
          <label>Time<input name="time" type="time" defaultValue="09:00" required /></label>
          <button className="event-submit" type="submit">Add deadline</button>
        </form>
      </dialog>

      <dialog ref={dialogRef} className="card-dialog" onCancel={closeCard} onClick={(event) => {
        if (event.target === dialogRef.current) closeCard()
      }}>
        {selected && (
          <div className="dialog-layout">
            <section className="card-details">
              <button className="close" type="button" onClick={closeCard} aria-label="Close card">×</button>
              <div className="title-row"><span className="circle" /><div><h2>{selected.title}</h2><p>in list <strong>{selected.list_title}</strong></p></div></div>
              <div className="description-block">
                <h3><span>☰</span> Description</h3>
                <textarea
                  key={`${selected.id}-${selected.description}`}
                  defaultValue={selected.description}
                  placeholder="Add a more detailed description…"
                  onBlur={(event) => void saveDescription(event.target.value)}
                  aria-label="Card description"
                />
              </div>
            </section>
            <aside className="activity">
              <header><h3>▣ Comments and activity</h3></header>
              <form onSubmit={(event) => void addComment(event)}>
                <input name="comment" placeholder="Write a comment…" aria-label="Comment" />
              </form>
              {selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong> {comment.body}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}
              <div className="activity-item"><span className="avatar">C</span><p><strong>You</strong> added this card to {selected.list_title}<small>{new Date(selected.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>
            </aside>
          </div>
        )}
      </dialog>
    </main>
  )
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function CalendarApp() {
  const today = new Date()
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [events, setEvents] = useState<EventItem[]>([])
  const [selected, setSelected] = useState<EventDetail | null>(null)
  const [addingDate, setAddingDate] = useState<string | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const addDialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (addingDate) addDialogRef.current?.showModal()
    else addDialogRef.current?.close()
  }, [addingDate])

  const monthKey = isoDate(month).slice(0, 7)
  async function loadEvents() {
    try { setEvents(await request<EventItem[]>(`/api/events?month=${monthKey}`)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load calendar') }
  }
  useEffect(() => {
    void loadEvents()
    window.addEventListener('calendar-events-changed', loadEvents)
    return () => window.removeEventListener('calendar-events-changed', loadEvents)
  }, [monthKey])

  const firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, index) => new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index))

  async function addEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!addingDate) return
    const form = event.currentTarget
    const data = new FormData(form)
    const title = String(data.get('title') ?? '').trim()
    const eventTime = String(data.get('startTime') ?? '')
    const endTime = String(data.get('endTime') ?? '')
    if (!title) return
    await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, eventDate: addingDate, eventTime, endTime }) })
    setAddingDate(null)
    await loadEvents()
  }
  async function openEvent(id: number) {
    setSelected(await request<EventDetail>(`/api/events/${id}`))
    dialogRef.current?.showModal()
  }
  function closeEvent() { dialogRef.current?.close(); setSelected(null) }
  async function moveEvent(id: number, eventDate: string) {
    const original = events
    setEvents((current) => current.map((item) => item.id === id ? { ...item, event_date: eventDate } : item))
    try { await request(`/api/events/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventDate }) }) }
    catch (cause) { setEvents(original); setError(cause instanceof Error ? cause.message : 'Could not move event') }
  }
  async function saveDescription(description: string) {
    if (!selected) return
    const updated = await request<EventItem>(`/api/events/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }) })
    setSelected({ ...selected, ...updated })
  }
  async function saveSchedule(eventDate: string, eventTime: string, endTime: string) {
    if (!selected) return
    try {
      const updated = await request<EventItem>(`/api/events/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventDate, eventTime, endTime }) })
      setSelected({ ...selected, ...updated })
      if (eventDate.slice(0, 7) !== monthKey) setMonth(new Date(`${eventDate}T00:00:00`))
      else await loadEvents()
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reschedule event') }
  }
  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget
    const body = String(new FormData(form).get('comment') ?? '').trim()
    if (!body) return
    const comment = await request<Comment>(`/api/events/${selected.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })
    setSelected({ ...selected, comments: [comment, ...selected.comments] }); form.reset()
  }

  return <main className="workspace calendar-workspace">
    <nav className="calendar-nav" aria-label="Calendar controls">
      <button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>&lt;</button>
      <h1>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1>
      <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>&gt;</button>
    </nav>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="calendar-shell" aria-label={`${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} calendar`}>
      <div className="weekday-row">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="month-grid">{days.map((day) => { const date = isoDate(day); const dayEvents = events.filter((item) => item.event_date === date).sort((a, b) => a.event_time.localeCompare(b.event_time) || a.id - b.id); return <article className={`calendar-day${day.getMonth() !== month.getMonth() ? ' muted' : ''}`} key={date} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void moveEvent(Number(e.dataTransfer.getData('text/plain')), date) }}>
        <button className="day-number" type="button" onClick={() => setAddingDate(date)} aria-label={`Add event on ${day.toLocaleDateString()}`}>{day.getDate()}</button>
        <div className="day-events">{dayEvents.map((item) => <button className="calendar-event" type="button" draggable key={item.id} onDragStart={(e) => e.dataTransfer.setData('text/plain', String(item.id))} onClick={() => void openEvent(item.id)}><time dateTime={`${item.event_date}T${item.event_time}`}>{new Date(`${item.event_date}T${item.event_time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{item.is_deadline ? '' : ` - ${new Date(`${item.event_date}T${item.end_time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</time><span>{item.title}</span></button>)}</div>
      </article> })}</div>
    </section>
    <dialog ref={addDialogRef} className="event-dialog" onCancel={() => setAddingDate(null)} onClick={(event) => { if (event.target === addDialogRef.current) setAddingDate(null) }}>
      <form className="event-popup" onSubmit={(event) => void addEvent(event)}>
        <header><div><h2>Add event</h2><p>{addingDate && new Date(`${addingDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p></div><button type="button" aria-label="Cancel" onClick={() => setAddingDate(null)}>×</button></header>
        <label>Event<input name="title" autoFocus required placeholder="What are you planning?" /></label>
        <div className="event-times"><label>Start<input name="startTime" type="time" defaultValue="09:00" required /></label><label>End<input name="endTime" type="time" defaultValue="10:00" required /></label></div>
        <button className="event-submit" type="submit">Add event</button>
      </form>
    </dialog>
    <dialog ref={dialogRef} className="card-dialog" onCancel={closeEvent} onClick={(e) => { if (e.target === dialogRef.current) closeEvent() }}>
      {selected && <div className="dialog-layout"><section className="card-details"><button className="close" type="button" onClick={closeEvent} aria-label="Close event">×</button><div className="title-row"><span className="circle" /><div><h2>{selected.title}</h2><p>Scheduled event</p></div></div><form className="schedule-block" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void saveSchedule(String(data.get('date')), String(data.get('startTime')), String(data.get('endTime'))) }}><label>Date<input name="date" type="date" defaultValue={selected.event_date} required /></label><label>Start time<input name="startTime" type="time" defaultValue={selected.event_time} required /></label><label>End time<input name="endTime" type="time" defaultValue={selected.end_time} required /></label><button type="submit">Save date & time</button></form><div className="description-block"><h3>Description</h3><textarea key={`${selected.id}-${selected.description}`} defaultValue={selected.description} placeholder="Add a more detailed description…" onBlur={(e) => void saveDescription(e.target.value)} aria-label="Event description" /></div></section><aside className="activity"><header><h3>Comments and activity</h3></header><form onSubmit={(e) => void addComment(e)}><input name="comment" placeholder="Write a comment…" aria-label="Comment" /></form>{selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong> {comment.body}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}</aside></div>}
    </dialog>
  </main>
}

function NotebooksApp() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [selected, setSelected] = useState<Notebook | null>(null)
  const [error, setError] = useState('')
  const [addingNotebook, setAddingNotebook] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  async function loadNotebooks() {
    try { setNotebooks(await request<Notebook[]>('/api/notebooks')); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load notebooks') }
  }

  useEffect(() => { void loadNotebooks() }, [])

  async function addNotebook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const title = String(new FormData(form).get('title') ?? '').trim()
    if (!title) return
    try {
      const notebook = await request<Notebook>('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })
      setNotebooks((current) => [notebook, ...current]); form.reset(); setAddingNotebook(false); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add notebook') }
  }

  function openNotebook(notebook: Notebook) { setSelected(notebook); dialogRef.current?.showModal() }
  function closeNotebook() { dialogRef.current?.close(); setSelected(null) }

  async function saveNotebook(changes: Partial<Pick<Notebook, 'title' | 'content' | 'images'>>) {
    if (!selected) return
    try {
      const updated = await request<Notebook>(`/api/notebooks/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) })
      setSelected(updated); setNotebooks((current) => current.map((item) => item.id === updated.id ? updated : item)); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save notebook') }
  }

  function insertImages(target: HTMLDivElement, files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    Promise.all(images.map((file) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })))
      .then((sources) => {
        target.focus()
        for (const source of sources) document.execCommand('insertImage', false, source)
      })
      .catch(() => setError('Could not read image'))
  }

  return <main className="workspace notebooks-workspace">
    <header className="notebooks-header"><div><p>Workspace</p><h1>Notebooks</h1></div><span>{notebooks.length} {notebooks.length === 1 ? 'notebook' : 'notebooks'}</span></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="notebook-board" aria-label="Notebooks">
      <article className="notebook-column">
        <header><h2>My notebooks</h2></header>
        <div className="notebook-list">{notebooks.map((notebook) => <button className="notebook-card" type="button" key={notebook.id} onClick={() => openNotebook(notebook)}><span aria-hidden="true">▮</span><strong>{notebook.title}</strong></button>)}</div>
        {addingNotebook ? <form className="notebook-add" onSubmit={(event) => void addNotebook(event)}><input name="title" autoFocus required placeholder="New notebook" aria-label="Notebook title" /><div><button type="submit">Add</button><button type="button" onClick={() => setAddingNotebook(false)}>Cancel</button></div></form> : <button className="notebook-add-trigger" type="button" onClick={() => setAddingNotebook(true)}>＋ Add notebook</button>}
      </article>
    </section>
    <dialog ref={dialogRef} className="notebook-dialog" onCancel={closeNotebook} onClick={(event) => { if (event.target === dialogRef.current) closeNotebook() }}>
      {selected && <div className="notebook-editor">
        <header><input key={`${selected.id}-title`} defaultValue={selected.title} aria-label="Notebook title" onBlur={(event) => void saveNotebook({ title: event.target.value })} /><button type="button" onClick={closeNotebook} aria-label="Close notebook">×</button></header>
        <div
          className="notebook-content"
          key={`${selected.id}-content`}
          contentEditable
          suppressContentEditableWarning
          data-placeholder="Start writing or paste pictures…"
          dangerouslySetInnerHTML={{ __html: selected.content + selected.images.map((image) => `<img src="${image}" alt="">`).join('') }}
          onBlur={(event) => void saveNotebook({ content: event.currentTarget.innerHTML, images: [] })}
          onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); insertImages(event.currentTarget, files) } }}
          onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); insertImages(event.currentTarget, files) } }}
          onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith('image/'))) event.preventDefault() }}
          aria-label="Notebook content"
        />
      </div>}
    </dialog>
  </main>
}

function App() {
  const stackRef = useRef<HTMLDivElement>(null)
  const activeView = useRef(0)

  useEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    let distance = 0
    let locked = false
    let resetTimer = 0

    const switchView = (next: number) => {
      if (locked || next === activeView.current) return
      locked = true
      activeView.current = next
      stack.scrollTo({ top: next * stack.clientHeight, behavior: 'smooth' })
      window.setTimeout(() => { locked = false }, 650)
    }
    const onWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const overScrollable = target && Array.from(target.closest('.workspace-view')?.querySelectorAll('*') ?? []).some((element) => {
        if (!(element instanceof HTMLElement) || !element.contains(target)) return false
        const style = getComputedStyle(element)
        return ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight)
          || ((style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth)
      })
      if (overScrollable) { distance = 0; return }
      event.preventDefault()
      if (locked || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      window.clearTimeout(resetTimer)
      distance = Math.sign(event.deltaY) === Math.sign(distance) ? distance + event.deltaY : event.deltaY
      resetTimer = window.setTimeout(() => { distance = 0 }, 180)
      if (Math.abs(distance) < 100) return
      switchView(Math.max(0, Math.min(2, activeView.current + Math.sign(event.deltaY))))
      distance = 0
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'PageDown' && event.key !== 'PageUp') return
      event.preventDefault()
      switchView(Math.max(0, Math.min(2, activeView.current + (event.key === 'PageDown' ? 1 : -1))))
    }

    stack.addEventListener('wheel', onWheel, { passive: false })
    stack.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(resetTimer)
      stack.removeEventListener('wheel', onWheel)
      stack.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return <div className="view-stack" ref={stackRef} tabIndex={0}>
    <div className="workspace-view"><TasksApp /></div>
    <div className="workspace-view"><CalendarApp /></div>
    <div className="workspace-view"><NotebooksApp /></div>
  </div>
}

export default App
