import { createContext, useContext } from 'react'

export type RecordRef = { type: 'card' | 'event' | 'notebook'; id: number }

/** Any screen or dialog can open a task, event or notebook on top of whatever is showing. */
export const RecordsContext = createContext<{ open: (record: RecordRef) => void; close: (record: RecordRef) => void }>({ open: () => {}, close: () => {} })
export const useRecords = () => useContext(RecordsContext)

export type ConfirmRequest = { title: string; body?: string; confirmLabel: string; resolve: (confirmed: boolean) => void }
export type Toast = { id: number; message: string; tone: 'info' | 'error'; action?: { label: string; run: () => void } }

let confirmListener: ((request: ConfirmRequest) => void) | null = null
let toastListener: ((toast: Toast) => void) | null = null
let toastId = 0

export function confirmAction(options: Omit<ConfirmRequest, 'resolve'>) {
  return new Promise<boolean>((resolve) => {
    if (confirmListener) confirmListener({ ...options, resolve })
    else resolve(window.confirm(options.title))
  })
}
export function onConfirmRequest(listener: (request: ConfirmRequest) => void) {
  confirmListener = listener
  return () => { if (confirmListener === listener) confirmListener = null }
}

export function toast(message: string, action?: Toast['action']) {
  toastListener?.({ id: ++toastId, message, tone: 'info', action })
}
export function toastError(message: string) {
  toastListener?.({ id: ++toastId, message, tone: 'error' })
}
export function onToast(listener: (toast: Toast) => void) {
  toastListener = listener
  return () => { if (toastListener === listener) toastListener = null }
}
