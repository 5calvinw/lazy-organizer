import { useMemo, useState, type FormEvent } from 'react'
import { messageOf, notifyChanged, request, send, useLiveData, type Notebook } from '../api'
import { readableDate } from '../dates'
import { toastError, useRecords } from '../overlays'

function summarize(notebook: Notebook) {
  const text = new DOMParser().parseFromString(notebook.content.replace(/</g, ' <'), 'text/html').body.textContent ?? ''
  const pictures = (notebook.content.match(/<img/gi)?.length ?? 0) + notebook.images.length
  return { text: text.replace(/\s+/g, ' ').trim(), pictures }
}

export function Notebooks({ active }: { active: boolean }) {
  const records = useRecords()
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')

  async function load() {
    try { setNotebooks(await request<Notebook[]>('/api/notebooks')); setError('') }
    catch (cause) { setError(messageOf(cause, 'Could not load notebooks.')) }
  }
  useLiveData(() => void load(), active)

  const pages = useMemo(() => (notebooks ?? []).map((notebook) => ({ notebook, ...summarize(notebook) })), [notebooks])
  const needle = filter.trim().toLowerCase()
  const shown = needle ? pages.filter((page) => page.notebook.title.toLowerCase().includes(needle) || page.text.toLowerCase().includes(needle)) : pages

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = String(new FormData(event.currentTarget).get('title') ?? '').trim()
    if (!title || busy) return
    setBusy(true)
    try {
      const created = await send<Notebook>('POST', '/api/notebooks', { title })
      setAdding(false)
      notifyChanged()
      // Straight into writing: a new notebook opens as soon as it exists.
      records.open({ type: 'notebook', id: created.id })
    } catch (cause) { toastError(messageOf(cause, 'Could not create the notebook.')) }
    finally { setBusy(false) }
  }

  return <div className="view notebooks">
    <header className="view-header">
      <div className="view-heading"><h1>Notebooks</h1></div>
      <div className="view-tools">
        {pages.length > 6 && <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search notebooks" aria-label="Search notebooks" />}
        <button type="button" className="button button-primary" onClick={() => setAdding(true)}>New notebook</button>
      </div>
    </header>
    {error && <p className="banner-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>}
    {!notebooks ? !error && <p className="view-loading" role="status">Loading notebooks…</p> : <div className="notebook-grid">
      {adding && <form className="page page-new" onSubmit={(event) => void create(event)}>
        <input name="title" placeholder="Name this notebook" aria-label="Notebook title" required autoFocus disabled={busy} onKeyDown={(event) => { if (event.key === 'Escape') setAdding(false) }} />
        <div><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button><button type="button" className="button" onClick={() => setAdding(false)}>Cancel</button></div>
      </form>}
      {shown.map(({ notebook, text, pictures }) => <button type="button" className="page" key={notebook.id} onClick={() => records.open({ type: 'notebook', id: notebook.id })}>
        <strong>{notebook.title}</strong>
        <p>{text || (pictures ? '' : 'Empty page')}</p>
        <small>{[readableDate(notebook.created_at.slice(0, 10)), pictures ? `${pictures} ${pictures === 1 ? 'picture' : 'pictures'}` : ''].filter(Boolean).join(' · ')}</small>
      </button>)}
      {!pages.length && !adding && <p className="empty">No notebooks yet. Create one for notes you want to link from tasks and events.</p>}
      {pages.length > 0 && !shown.length && <p className="empty">No notebooks match “{filter.trim()}”.</p>}
    </div>}
  </div>
}
