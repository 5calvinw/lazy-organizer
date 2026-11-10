import { useState, type ClipboardEvent, type FormEvent } from 'react'
import { messageOf, readFile, type Comment, type FileDraft } from '../api'
import { fileSize, readableTimestamp } from '../dates'

export function FileMark({ name }: { name: string }) {
  const extension = name.includes('.') ? name.split('.').pop()!.slice(0, 4) : 'file'
  return <span className="file-mark" aria-hidden="true">{extension}</span>
}

export function Comments({ comments, onPost }: { comments: Comment[]; onPost: (comment: { body: string; file: FileDraft | null }) => Promise<void> }) {
  const [body, setBody] = useState('')
  const [file, setFile] = useState<FileDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function attach(candidate: File | null | undefined) {
    if (!candidate) return
    try { setFile(await readFile(candidate)); setError('') }
    catch (cause) { setError(messageOf(cause, 'Could not attach that file.')) }
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (busy || (!body.trim() && !file)) return
    setBusy(true)
    try { await onPost({ body: body.trim(), file }); setBody(''); setFile(null); setError('') }
    catch (cause) { setError(messageOf(cause, 'Could not post the comment.')) }
    finally { setBusy(false) }
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile()
    if (!image) return
    event.preventDefault()
    void attach(image)
  }
  return <div className="comments">
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <div className="grow" data-value={body}>
        <textarea rows={1} value={body} placeholder="Write a comment…" aria-label="Comment" onChange={(event) => setBody(event.target.value)} onPaste={paste} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit() }} />
      </div>
      {file && <div className="file-row">
        {file.mimeType.startsWith('image/') ? <img src={file.data} alt="" /> : <FileMark name={file.name} />}
        <span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span>
        <button type="button" className="text-button" onClick={() => setFile(null)}>Remove</button>
      </div>}
      <div className="composer-actions">
        <label className="text-button">Attach a file<input type="file" className="sr-only" onChange={(event) => { void attach(event.target.files?.[0]); event.target.value = '' }} /></label>
        <button type="submit" className="button button-primary" disabled={busy || (!body.trim() && !file)}>{busy ? 'Posting…' : 'Post'}</button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </form>
    {comments.length > 0 && <ol className="comment-list">
      {comments.map((comment) => {
        const fileIsImage = comment.file_mime_type?.startsWith('image/')
        return <li key={comment.id}>
          {comment.body && <p>{comment.body}</p>}
          {comment.image && <a href={comment.image} target="_blank" rel="noreferrer"><img src={comment.image} alt="Attached image" /></a>}
          {comment.file_data && (fileIsImage
            ? <a href={comment.file_data} download={comment.file_name || 'image'}><img src={comment.file_data} alt={comment.file_name || 'Attached image'} /></a>
            : <a className="file-row" href={comment.file_data} download={comment.file_name || 'attachment'}><FileMark name={comment.file_name || ''} /><span><strong>{comment.file_name || 'Attachment'}</strong>{comment.file_size ? <small>{fileSize(comment.file_size)}</small> : null}</span></a>)}
          <time>{readableTimestamp(comment.created_at)}</time>
        </li>
      })}
    </ol>}
  </div>
}
