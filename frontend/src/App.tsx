import { useEffect, useRef, useState, type FormEvent } from 'react'
import './App.css'

type Card = { id: number; list_id: number; title: string; description: string; created_at: string }
type List = { id: number; title: string; cards: Card[] }
type Comment = { id: number; body: string; created_at: string }
type CardDetail = Card & { list_title: string; comments: Comment[] }

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed')
  return response.json()
}

function App() {
  const [lists, setLists] = useState<List[]>([])
  const [selected, setSelected] = useState<CardDetail | null>(null)
  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)

  async function loadBoard() {
    try {
      setLists(await request<List[]>('/api/board'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load board')
    }
  }

  useEffect(() => { void loadBoard() }, [])

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
      <header className="topbar">
        <div className="brand-mark">L</div>
        <strong>Lazy organizer</strong>
        <span className="topbar-spacer" />
        <button className="avatar" type="button" aria-label="Account">C</button>
      </header>

      <section className="board-heading">
        <div>
          <p>Personal workspace</p>
          <h1>Things to sort out</h1>
        </div>
        <span className="private-badge">Private board</span>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="board" aria-label="Task board">
        {lists.map((list) => (
          <article className="list" key={list.id}>
            <header className="list-header">
              <h2>{list.title}</h2>
              <span>{list.cards.length}</span>
              <button type="button" aria-label={`More options for ${list.title}`}>•••</button>
            </header>
            <div className="card-stack">
              {list.cards.map((card) => (
                <button className="task-card" key={card.id} type="button" onClick={() => void openCard(card.id)}>
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
      </section>

      <dialog ref={dialogRef} className="card-dialog" onCancel={closeCard} onClick={(event) => {
        if (event.target === dialogRef.current) closeCard()
      }}>
        {selected && (
          <div className="dialog-layout">
            <section className="card-details">
              <button className="close" type="button" onClick={closeCard} aria-label="Close card">×</button>
              <div className="title-row"><span className="circle" /><div><h2>{selected.title}</h2><p>in list <strong>{selected.list_title}</strong></p></div></div>
              <div className="quick-actions">
                <button type="button">＋ Add</button><button type="button">◇ Labels</button><button type="button">◷ Dates</button><button type="button">☑ Checklist</button><button type="button">♙ Members</button>
              </div>
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
              <header><h3>▣ Comments and activity</h3><button type="button">Show details</button></header>
              <form onSubmit={(event) => void addComment(event)}>
                <input name="comment" placeholder="Write a comment…" aria-label="Comment" />
              </form>
              <div className="activity-item"><span className="avatar">C</span><p><strong>You</strong> added this card to {selected.list_title}<small>{new Date(selected.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>
              {selected.comments.map((comment) => <div className="activity-item" key={comment.id}><span className="avatar">C</span><p><strong>You</strong> {comment.body}<small>{new Date(comment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small></p></div>)}
            </aside>
          </div>
        )}
      </dialog>
    </main>
  )
}

export default App
