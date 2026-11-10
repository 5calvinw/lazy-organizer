import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { LinkOptions } from '../api'
import { readableDate } from '../dates'
import { useRecords } from '../overlays'

type Mention = { id: number; title: string; type: 'event' | 'notebook'; detail: string }
const mentionPattern = /\$\[(?:(event|notebook):(\d+)|([^\]\r\n]+))\]/g
const blockTags = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE'])

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}
const chipHtml = (record: Mention) => `<span class="record-chip record-${record.type}" data-record-type="${record.type}" data-record-id="${record.id}" contenteditable="false" role="link" tabindex="0">${escapeHtml(record.title)}</span>`

function toHtml(value: string, records: Mention[]) {
  let position = 0
  const text = (part: string) => escapeHtml(part).replace(/\n/g, '<br>')
  const html = Array.from(value.matchAll(mentionPattern)).map((match) => {
    const prefix = text(value.slice(position, match.index))
    position = match.index + match[0].length
    const record = match[1] && match[2]
      ? records.find((item) => item.type === match[1] && item.id === Number(match[2]))
      : records.find((item) => item.type === 'notebook' && item.title.localeCompare(match[3].trim(), undefined, { sensitivity: 'base' }) === 0)
    return prefix + (record ? chipHtml(record) : escapeHtml(match[0]))
  }).join('')
  return html + text(value.slice(position))
}

/** Turns the editor DOM back into text. Browsers wrap lines in block elements, so every block starts on a new line. */
function serialize(root: Node): string {
  let output = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) { output += (node.textContent ?? '').replace(/ /g, ' '); continue }
    if (!(node instanceof HTMLElement)) continue
    if (node.dataset.recordType && node.dataset.recordId) { output += `$[${node.dataset.recordType}:${node.dataset.recordId}]`; continue }
    if (node.tagName === 'BR') { output += '\n'; continue }
    if (blockTags.has(node.tagName) && output && !output.endsWith('\n')) output += '\n'
    output += serialize(node)
  }
  return output
}
const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim()

export function DescriptionEditor({ value, label, options, placeholder = 'Add details…', onSave }: { value: string; label: string; options: LinkOptions | null; placeholder?: string; onSave: (value: string) => void }) {
  const records = useRecords()
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const matchRange = useRef<Range | null>(null)
  const saved = useRef(value)
  const draft = useRef<string | null>(null)
  const save = useRef(onSave)
  useEffect(() => { save.current = onSave })
  const mentions = useMemo<Mention[]>(() => [
    ...(options?.notebooks.map((item) => ({ ...item, type: 'notebook' as const, detail: 'Notebook' })) ?? []),
    ...(options?.events.map((item) => ({ id: item.id, title: item.title, type: 'event' as const, detail: `${item.is_deadline ? 'Deadline' : 'Event'} · ${readableDate(item.event_date)}` })) ?? []),
  ], [options])

  // Show what the server has, unless the user is in the middle of typing.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || document.activeElement === editor) return
    editor.innerHTML = toHtml(value, mentions)
    saved.current = value
    draft.current = null
  }, [value, mentions])
  // A dialog can be torn down without a blur; make sure the last keystrokes still get saved.
  useEffect(() => () => { if (draft.current !== null && normalize(draft.current) !== normalize(saved.current)) save.current(normalize(draft.current)) }, [])

  const matches = query === null ? [] : mentions.filter((record) => record.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 6)

  function commit() {
    const editor = editorRef.current
    if (!editor) return
    const text = normalize(serialize(editor))
    draft.current = null
    setQuery(null)
    // Redraw from the text so links that were typed or loaded late become chips.
    editor.innerHTML = toHtml(text, mentions)
    if (text === normalize(saved.current)) return
    saved.current = text
    onSave(text)
  }
  function track() {
    if (editorRef.current) draft.current = serialize(editorRef.current)
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const fragment = range?.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.textContent?.slice(0, range.startOffset).match(/\$([\p{L}\p{N}_ -]*)$/u)?.[1] : undefined
    matchRange.current = fragment === undefined || !range ? null : range.cloneRange()
    setQuery(fragment ?? null)
    setActive(0)
  }
  function choose(record: Mention) {
    const selection = window.getSelection()
    const range = matchRange.current
    if (!selection || !range || query === null || range.startContainer.nodeType !== Node.TEXT_NODE) return
    range.setStart(range.startContainer, Math.max(0, range.startOffset - query.length - 1))
    range.deleteContents()
    const wrapper = document.createElement('span')
    wrapper.innerHTML = `${chipHtml(record)}&nbsp;`
    const fragment = document.createDocumentFragment()
    while (wrapper.firstChild) fragment.append(wrapper.firstChild)
    range.insertNode(fragment)
    selection.collapseToEnd()
    setQuery(null)
    editorRef.current?.focus()
    if (editorRef.current) draft.current = serialize(editorRef.current)
  }
  function openChip(target: EventTarget) {
    const chip = (target as HTMLElement).closest<HTMLElement>('.record-chip')
    const id = Number(chip?.dataset.recordId)
    if (!chip || !Number.isInteger(id)) return false
    records.open({ type: chip.dataset.recordType === 'event' ? 'event' : 'notebook', id })
    return true
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (matches.length && query !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(matches[active]); return }
      if (event.key === 'Escape') { event.preventDefault(); setQuery(null); return }
    }
    if (event.key === 'Enter' && event.target !== event.currentTarget && openChip(event.target)) { event.preventDefault(); return }
    // Keep the content flat (text and line breaks) instead of letting the browser nest a new block per line.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); document.execCommand('insertLineBreak'); track() }
  }

  return <div className="description">
    <div
      ref={editorRef}
      className="description-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      data-placeholder={placeholder}
      onInput={track}
      onKeyDown={onKeyDown}
      onBlur={commit}
      onClick={(event) => { openChip(event.target) }}
      onPaste={(event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')) }}
      onDrop={(event) => event.preventDefault()}
    />
    {query !== null && matches.length > 0 && <div className="menu record-suggestions" role="listbox" aria-label="Link a record">
      {matches.map((record, index) => <button className={index === active ? 'active' : ''} type="button" role="option" aria-selected={index === active} key={`${record.type}-${record.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(record)}>
        <strong>{record.title}</strong><small>{record.detail}</small>
      </button>)}
    </div>}
    {mentions.length > 0 && <p className="field-hint">Type <kbd>$</kbd> to link a notebook{options?.events.length ? ' or event' : ''}.</p>}
  </div>
}
