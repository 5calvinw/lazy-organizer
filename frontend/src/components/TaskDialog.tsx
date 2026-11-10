import { useRef, useState, type FormEvent } from 'react'
import { completeWithUndo, reopen } from '../actions'
import { commentPayload, isDoneList, messageOf, notifyChanged, readFile, request, send, useLiveData, type CardDetail, type LinkOptions, type List, type OrganizerColor, type Priority, type Recurrence } from '../api'
import { addDays, fileSize, isoDate, readableTimestamp } from '../dates'
import { confirmAction, toast, toastError } from '../overlays'
import { Comments, FileMark } from './Comments'
import { DescriptionEditor } from './DescriptionEditor'
import { CheckCircle, ColorPicker, EditableText, RepeatField, Segmented } from './fields'
import { CloseButton, Modal } from './Modal'

type CardChanges = Partial<{ title: string; description: string; color: OrganizerColor; dueDate: string | null; priority: Priority; recurrence: Recurrence; recurrenceInterval: number }>
const priorities: Array<{ value: Priority; label: string }> = [{ value: 'none', label: 'None' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]

export function TaskDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null)
  const [lists, setLists] = useState<List[]>([])
  const [options, setOptions] = useState<LinkOptions | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  const gone = useRef(false)
  const newItem = useRef<HTMLInputElement>(null)

  async function load() {
    // Once deleted there is nothing left to refresh.
    if (gone.current) return
    const ticket = ++latest.current
    try {
      const [card, board] = await Promise.all([request<CardDetail>(`/api/cards/${id}`), request<List[]>('/api/board')])
      if (ticket !== latest.current) return
      setDetail(card); setLists(board)
    } catch (cause) {
      if (ticket !== latest.current) return
      // Nothing to show: the task was deleted elsewhere, or the first load failed.
      if (!detail) { toastError(messageOf(cause, 'Could not open that task.')); onClose() }
    }
  }
  useLiveData(() => {
    void load()
    if (!options) request<LinkOptions>('/api/link-options').then(setOptions).catch(() => {})
  }, true, id)

  /** Runs a change, reports failures in the dialog, and lets every screen (including this one) refresh. */
  async function run(action: () => Promise<unknown>, fallback: string) {
    try { await action(); setError('') }
    catch (cause) { setError(messageOf(cause, fallback)) }
    finally { notifyChanged() }
  }
  function patch(changes: CardChanges) {
    setDetail((current) => current && {
      ...current,
      ...(changes.title !== undefined && { title: changes.title }),
      ...(changes.description !== undefined && { description: changes.description }),
      ...(changes.color !== undefined && { color: changes.color }),
      ...(changes.dueDate !== undefined && { due_date: changes.dueDate }),
      ...(changes.priority !== undefined && { priority: changes.priority }),
      ...(changes.recurrence !== undefined && { recurrence: changes.recurrence }),
      ...(changes.recurrenceInterval !== undefined && { recurrence_interval: changes.recurrenceInterval }),
    })
    return run(() => send('PATCH', `/api/cards/${id}`, changes), 'Could not save the task.')
  }

  if (!detail) return <Modal className="modal-record" onClose={onClose} label="Task"><div className="record record-loading"><p role="status">Opening task…</p><CloseButton onClick={onClose} /></div></Modal>

  const done = isDoneList(detail.list_title)
  const today = isoDate(new Date())
  const completed = detail.checklist.filter((item) => item.completed).length

  async function toggleDone() {
    if (busy || !detail) return
    setBusy(true)
    // Finishing a task closes it; the toast offers the way back.
    if (done) await reopen(detail)
    else if (await completeWithUndo(detail)) onClose()
    setBusy(false)
  }
  function moveTo(listId: number) {
    const target = lists.find((list) => list.id === listId)
    if (!target || listId === detail!.list_id) return
    setDetail((current) => current && { ...current, list_id: listId, list_title: target.title })
    void run(() => send('PATCH', `/api/cards/${id}/move`, { listId, index: target.cards.length }), 'Could not move the task.')
  }
  function setDue(dueDate: string | null) {
    // A repeating task needs a date to repeat from, so clearing the date also stops the repeat.
    void patch(dueDate === null && detail!.recurrence !== 'none' ? { dueDate, recurrence: 'none' } : { dueDate })
  }
  function setRepeat(recurrence: Recurrence, recurrenceInterval: number) {
    void patch({ recurrence, recurrenceInterval, ...(recurrence !== 'none' && !detail!.due_date && { dueDate: today }) })
  }
  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = newItem.current?.value.trim()
    if (!title) return
    newItem.current!.value = ''
    await run(() => send('POST', `/api/cards/${id}/checklist`, { title }), 'Could not add the item.')
  }
  function toggleItem(itemId: number, checked: boolean) {
    setDetail((current) => current && { ...current, checklist: current.checklist.map((item) => item.id === itemId ? { ...item, completed: Number(checked) } : item) })
    void run(() => send('PATCH', `/api/checklist/${itemId}`, { completed: checked }), 'Could not update the item.')
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    await run(async () => {
      for (const file of Array.from(files)) {
        const draft = await readFile(file)
        await send('POST', `/api/cards/${id}/attachments`, { name: draft.name, mimeType: draft.mimeType, data: draft.data })
      }
    }, 'Could not attach the file.')
  }
  async function removeFile(fileId: number, name: string) {
    if (!await confirmAction({ title: `Remove “${name}”?`, body: 'The file is deleted from this task.', confirmLabel: 'Remove file' })) return
    await run(() => send('DELETE', `/api/attachments/${fileId}`), 'Could not remove the file.')
  }
  async function remove() {
    if (!await confirmAction({ title: `Delete “${detail!.title}”?`, body: 'The task, its checklist, files and comments are deleted. This can’t be undone.', confirmLabel: 'Delete task' })) return
    try { await send('DELETE', `/api/cards/${id}`); gone.current = true; onClose(); notifyChanged(); toast('Task deleted') }
    catch (cause) { setError(messageOf(cause, 'Could not delete the task.')) }
  }

  return <Modal className="modal-record" onClose={onClose} labelledBy="task-title">
    <article className={`record tone-${detail.color}`}>
      <header className="record-header">
        <CheckCircle checked={done} disabled={busy} onToggle={() => void toggleDone()} label={done ? 'Mark as not done' : 'Mark as done'} />
        <EditableText id="task-title" className={`record-title${done ? ' is-done' : ''}`} value={detail.title} label="Task title" onCommit={(title) => void patch({ title })} />
        <CloseButton onClick={onClose} label="Close task" />
      </header>
      {error && <p className="inline-error" role="alert">{error}</p>}

      <div className="properties">
        <div className="property"><label htmlFor="task-list">List</label><div>
          <select id="task-list" value={detail.list_id} onChange={(event) => moveTo(Number(event.target.value))}>{lists.map((list) => <option value={list.id} key={list.id}>{list.title}</option>)}</select>
        </div></div>
        <div className="property"><label htmlFor="task-due">Due</label><div>
          <input id="task-due" type="date" className={detail.due_date && detail.due_date < today && !done ? 'is-overdue' : ''} value={detail.due_date ?? ''} onChange={(event) => setDue(event.target.value || null)} />
          <span className="quick-actions">
            {detail.due_date !== today && <button type="button" className="text-button" onClick={() => setDue(today)}>Today</button>}
            {detail.due_date !== addDays(today, 1) && <button type="button" className="text-button" onClick={() => setDue(addDays(today, 1))}>Tomorrow</button>}
            {detail.due_date && <button type="button" className="text-button" onClick={() => setDue(null)}>Clear</button>}
          </span>
        </div></div>
        <div className="property"><span className="property-label">Priority</span><div>
          <Segmented label="Priority" value={detail.priority} options={priorities} onChange={(priority) => void patch({ priority })} />
        </div></div>
        <div className="property"><span className="property-label">Repeat</span><div>
          <RepeatField recurrence={detail.recurrence} interval={detail.recurrence_interval} onChange={setRepeat} />
        </div></div>
        <div className="property"><span className="property-label">Color</span><div>
          <ColorPicker value={detail.color} onChange={(color) => void patch({ color })} />
        </div></div>
      </div>

      <section className="record-section">
        <h3>Description</h3>
        <DescriptionEditor value={detail.description} label="Task description" options={options} onSave={(description) => void patch({ description })} />
      </section>

      <section className="record-section">
        <h3>Checklist{detail.checklist.length > 0 && <span>{completed} of {detail.checklist.length}</span>}</h3>
        <ul className="checklist">
          {detail.checklist.map((item) => <li key={item.id} className={item.completed ? 'is-done' : ''}>
            <input type="checkbox" checked={Boolean(item.completed)} onChange={(event) => toggleItem(item.id, event.target.checked)} aria-label={`Done: ${item.title}`} />
            <input key={item.title} defaultValue={item.title} aria-label="Checklist item" onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} onBlur={(event) => { const title = event.target.value.trim(); if (!title) event.target.value = item.title; else if (title !== item.title) void run(() => send('PATCH', `/api/checklist/${item.id}`, { title }), 'Could not rename the item.') }} />
            <button type="button" className="icon-button" onClick={() => void run(() => send('DELETE', `/api/checklist/${item.id}`), 'Could not remove the item.')} aria-label={`Remove ${item.title}`}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
          </li>)}
        </ul>
        <form className="checklist-add" onSubmit={(event) => void addItem(event)}>
          <span aria-hidden="true">+</span><input ref={newItem} placeholder="Add an item" aria-label="New checklist item" enterKeyHint="done" />
        </form>
      </section>

      <section className="record-section">
        <h3>Files{detail.attachments.length > 0 && <span>{detail.attachments.length}</span>}</h3>
        {detail.attachments.length > 0 && <ul className="file-list">
          {detail.attachments.map((file) => <li key={file.id} className="file-row">
            <a href={file.data} download={file.name}>{file.mime_type.startsWith('image/') ? <img src={file.data} alt="" /> : <FileMark name={file.name} />}<span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span></a>
            <button type="button" className="text-button" onClick={() => void removeFile(file.id, file.name)}>Remove</button>
          </li>)}
        </ul>}
        <label className="text-button">Attach files<input type="file" multiple className="sr-only" onChange={(event) => { void addFiles(event.target.files); event.target.value = '' }} /></label>
      </section>

      <section className="record-section">
        <h3>Comments{detail.comments.length > 0 && <span>{detail.comments.length}</span>}</h3>
        <Comments comments={detail.comments} onPost={async (comment) => { await send('POST', `/api/cards/${id}/comments`, commentPayload(comment)); notifyChanged() }} />
      </section>

      <footer className="record-footer">
        <span>Created {readableTimestamp(detail.created_at)}</span>
        <button type="button" className="text-button text-danger" onClick={() => void remove()}>Delete task</button>
      </footer>
    </article>
  </Modal>
}
