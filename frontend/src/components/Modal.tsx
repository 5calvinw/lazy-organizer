import { useEffect, useRef, useState, type ReactNode } from 'react'
import { onConfirmRequest, onToast, type ConfirmRequest, type Toast } from '../overlays'

/**
 * A native modal dialog that is open for exactly as long as it is mounted.
 * Closing (Escape, the backdrop, or a close button) first blurs the focused field so edit-on-blur saves are sent.
 */
export function Modal({ onClose, className = '', label, labelledBy, children }: { onClose: () => void; className?: string; label?: string; labelledBy?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)
  useEffect(() => {
    const dialog = ref.current!
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => dialog.close()
  }, [])
  function close() {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur()
    onClose()
  }
  return <dialog
    ref={ref}
    className={`modal ${className}`}
    aria-label={label}
    aria-labelledby={labelledBy}
    onCancel={(event) => { event.preventDefault(); close() }}
    onMouseDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget }}
    onClick={(event) => { if (event.target === event.currentTarget && pressedBackdrop.current) close() }}
  >
    <div className="modal-surface">{children}</div>
  </dialog>
}

export function CloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return <button type="button" className="icon-button" onClick={() => { (document.activeElement as HTMLElement | null)?.blur?.(); onClick() }} aria-label={label}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>
  </button>
}

export function ConfirmHost() {
  const [pending, setPending] = useState<ConfirmRequest | null>(null)
  useEffect(() => onConfirmRequest((request) => setPending((current) => { current?.resolve(false); return request })), [])
  if (!pending) return null
  const answer = (confirmed: boolean) => { pending.resolve(confirmed); setPending(null) }
  return <Modal className="modal-confirm" onClose={() => answer(false)} labelledBy="confirm-title">
    <div className="confirm">
      <h2 id="confirm-title">{pending.title}</h2>
      {pending.body && <p>{pending.body}</p>}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={() => answer(false)}>Cancel</button>
        <button type="button" className="button button-danger" data-autofocus onClick={() => answer(true)}>{pending.confirmLabel}</button>
      </div>
    </div>
  </Modal>
}

export function ToastHost() {
  const [current, setCurrent] = useState<Toast | null>(null)
  useEffect(() => onToast(setCurrent), [])
  useEffect(() => {
    if (!current) return
    const timer = window.setTimeout(() => setCurrent((toast) => toast?.id === current.id ? null : toast), current.action || current.tone === 'error' ? 8000 : 4000)
    return () => window.clearTimeout(timer)
  }, [current])
  return <div className="toast-region" role="status" aria-live="polite">
    {current && <div className={`toast toast-${current.tone}`} key={current.id}>
      <span>{current.message}</span>
      {current.action && <button type="button" onClick={() => { current.action!.run(); setCurrent(null) }}>{current.action.label}</button>}
      <button type="button" className="toast-dismiss" onClick={() => setCurrent(null)} aria-label="Dismiss">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
      </button>
    </div>}
  </div>
}
