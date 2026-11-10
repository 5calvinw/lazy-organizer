import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { messageOf, notifyChanged, request, send, type Backlinks, type Notebook } from '../api'
import { fileToDataUrl, readableDate } from '../dates'
import { confirmAction, toast, toastError, useRecords } from '../overlays'
import { EditableText } from './fields'
import { CloseButton, Modal } from './Modal'

const allowedTags = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'U', 'UL'])
const allowedAttributes: Record<string, string[]> = { A: ['href'], IMG: ['src', 'alt'] }

/** Notebook content is stored HTML that other tools can write too, so only plain formatting is ever put on the page. */
function sanitize(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    if (!allowedTags.has(element.tagName)) {
      // Unknown wrappers keep their text; code and styles go entirely.
      if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') element.remove()
      else element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const keep = allowedAttributes[element.tagName]?.includes(attribute.name) && /^(https?:|mailto:|data:image\/|\/|#)/i.test(attribute.value.trim())
      if (!keep) element.removeAttribute(attribute.name)
    }
    if (element.tagName === 'A') { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noreferrer') }
  }
  return template.innerHTML
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed'

export function NotebookDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const records = useRecords()
  const [notebook, setNotebook] = useState<Notebook | null>(null)
  const [backlinks, setBacklinks] = useState<Backlinks>({ cards: [], events: [] })
  const [state, setState] = useState<SaveState>('saved')
  const [error, setError] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const draft = useRef<string | null>(null)
  const timer = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const deleted = useRef(false)

  const unavailable = useEffectEvent((cause: unknown) => { toastError(messageOf(cause, 'Could not open that notebook.')); onClose() })
  useEffect(() => {
    let current = true
    request<Notebook>(`/api/notebooks/${id}`).then((loaded) => { if (current) setNotebook(loaded) }, (cause) => { if (current) unavailable(cause) })
    request<Backlinks>(`/api/notebooks/${id}/backlinks`).then((loaded) => { if (current) setBacklinks(loaded) }, () => {})
    return () => { current = false }
  }, [id])
  /** The editor owns its DOM while open: the saved content is written into the element once, when it first appears. */
  function attachContent(node: HTMLDivElement | null) {
    if (!node || contentRef.current === node || !notebook) return
    contentRef.current = node
    node.innerHTML = sanitize(notebook.content + notebook.images.map((image) => `<img src="${image}" alt="">`).join(''))
  }

  /** Sends the latest draft. Saves never overlap; a draft typed during a save goes out right after it. */
  function flush(keepalive = false): Promise<void> {
    window.clearTimeout(timer.current)
    if (inFlight.current) return inFlight.current.then(() => flush(keepalive))
    const content = draft.current
    if (content === null || deleted.current) return Promise.resolve()
    draft.current = null
    setState('saving')
    const body = JSON.stringify({ content, images: [] })
    inFlight.current = request<Notebook>(`/api/notebooks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, keepalive: keepalive && body.length < 60_000 })
      .then(() => { setState(draft.current === null ? 'saved' : 'unsaved'); setError(''); notifyChanged() })
      .catch((cause) => { if (draft.current === null) draft.current = content; setState('failed'); setError(messageOf(cause, 'Could not save the notebook.')) })
      .finally(() => { inFlight.current = null })
    return inFlight.current
  }
  function changed() {
    if (!contentRef.current) return
    draft.current = contentRef.current.innerHTML
    setState('unsaved')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), 900)
  }
  // Closing the dialog, hiding the tab or leaving the page must not drop the last edits.
  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush })
  useEffect(() => {
    const leave = () => { if (document.visibilityState === 'hidden') void flushRef.current(true) }
    document.addEventListener('visibilitychange', leave)
    window.addEventListener('pagehide', leave)
    return () => { document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', leave); void flushRef.current(true) }
  }, [])

  function format(command: string, value?: string) {
    contentRef.current?.focus()
    document.execCommand(command, false, value)
    changed()
  }
  function insertImages(files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return false
    if (images.some((file) => file.size > 5_000_000)) { setError('Images must be 5 MB or smaller.'); return true }
    void Promise.all(images.map(fileToDataUrl)).then((sources) => {
      contentRef.current?.focus()
      for (const source of sources) document.execCommand('insertImage', false, source)
      changed()
    }, () => setError('Could not read that image.'))
    return true
  }
  async function rename(title: string) {
    setNotebook((current) => current && { ...current, title })
    try { await send('PATCH', `/api/notebooks/${id}`, { title }); setError(''); notifyChanged() }
    catch (cause) { setError(messageOf(cause, 'Could not rename the notebook.')) }
  }
  async function remove() {
    if (!notebook || !await confirmAction({ title: `Delete “${notebook.title}”?`, body: 'The notebook and everything written in it are deleted. This can’t be undone.', confirmLabel: 'Delete notebook' })) return
    deleted.current = true
    try { await send('DELETE', `/api/notebooks/${id}`); onClose(); notifyChanged(); toast('Notebook deleted') }
    catch (cause) { deleted.current = false; setError(messageOf(cause, 'Could not delete the notebook.')) }
  }

  if (!notebook) return <Modal className="modal-notebook" onClose={onClose} label="Notebook"><div className="record record-loading"><p role="status">Opening notebook…</p><CloseButton onClick={onClose} /></div></Modal>

  const linked = backlinks.cards.length + backlinks.events.length
  return <Modal className="modal-notebook" onClose={onClose} label={`Notebook: ${notebook.title}`}>
    <article className="notebook">
      <header className="notebook-header">
        <EditableText className="notebook-title" value={notebook.title} label="Notebook title" onCommit={(title) => void rename(title)} />
        <CloseButton onClick={onClose} label="Close notebook" />
      </header>
      <div className="notebook-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(event) => { if (!(event.target as HTMLElement).closest('label')) event.preventDefault() }}>
        <button type="button" onClick={() => format('bold')} aria-label="Bold" title="Bold"><strong>B</strong></button>
        <button type="button" onClick={() => format('italic')} aria-label="Italic" title="Italic"><em>I</em></button>
        <button type="button" onClick={() => format('underline')} aria-label="Underline" title="Underline"><u>U</u></button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button type="button" onClick={() => format('formatBlock', 'h2')} title="Heading">Heading</button>
        <button type="button" onClick={() => format('formatBlock', 'div')} title="Body text">Text</button>
        <button type="button" onClick={() => format('insertUnorderedList')} title="Bulleted list">Bullets</button>
        <button type="button" onClick={() => format('insertOrderedList')} title="Numbered list">Numbers</button>
        <label className="toolbar-file" title="Insert an image">Image<input type="file" accept="image/*" multiple className="sr-only" onChange={(event) => { insertImages(Array.from(event.target.files ?? [])); event.target.value = '' }} /></label>
        <span className={`save-state save-${state}`} role="status">{state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Unsaved changes' : state === 'failed' ? 'Not saved' : 'Saved'}</span>
      </div>
      {error && <p className="inline-error" role="alert">{error} {state === 'failed' && <button type="button" className="text-button" onClick={() => void flush()}>Try again</button>}</p>}
      <div className="notebook-body">
        <div
          className="notebook-content"
          ref={attachContent}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Notebook content"
          data-placeholder="Start writing, or paste a picture…"
          onInput={changed}
          onBlur={() => void flush()}
          onPaste={(event) => { if (insertImages(Array.from(event.clipboardData.files))) event.preventDefault() }}
          onDrop={(event) => { if (insertImages(Array.from(event.dataTransfer.files))) event.preventDefault() }}
          onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith('image/'))) event.preventDefault() }}
        />
        <aside className="backlinks" aria-label="Linked from">
          <h3>Linked from{linked > 0 && <span>{linked}</span>}</h3>
          {!linked && <p>Tasks and events that mention this notebook show up here.</p>}
          {backlinks.cards.map((card) => <button type="button" key={`card-${card.id}`} onClick={() => records.open({ type: 'card', id: card.id })}><strong>{card.title}</strong><small>Task · {card.list_title}</small></button>)}
          {backlinks.events.map((event) => <button type="button" key={`event-${event.id}`} onClick={() => records.open({ type: 'event', id: event.id })}><strong>{event.title}</strong><small>{event.is_deadline ? 'Deadline' : 'Event'} · {readableDate(event.event_date)}</small></button>)}
        </aside>
      </div>
      <footer className="record-footer">
        <span>Created {readableDate(notebook.created_at.slice(0, 10))}</span>
        <button type="button" className="text-button text-danger" onClick={() => void remove()}>Delete notebook</button>
      </footer>
    </article>
  </Modal>
}
