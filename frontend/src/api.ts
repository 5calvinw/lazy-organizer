import { useEffect, useEffectEvent } from 'react'
import { fileToDataUrl, isoDate } from './dates'

export type OrganizerColor = 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'gray'
export type Priority = 'none' | 'low' | 'medium' | 'high'
export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type Card = {
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
export type List = { id: number; title: string; cards: Card[] }
export type Comment = { id: number; body: string; image: string | null; file_name?: string | null; file_mime_type?: string | null; file_data?: string | null; file_size?: number | null; created_at: string }
export type FileDraft = { name: string; mimeType: string; data: string; size: number }
export type ChecklistItem = { id: number; title: string; completed: number; position: number; created_at: string }
export type Attachment = { id: number; name: string; mime_type: string; data: string; size: number; created_at: string }
export type LinkedEvent = { id: number; title: string; event_date: string; event_time: string; is_deadline: number }
export type LinkedNotebook = { id: number; title: string }
export type CardDetail = Card & {
  comments: Comment[]
  checklist: ChecklistItem[]
  attachments: Attachment[]
  links: { events: LinkedEvent[]; notebooks: LinkedNotebook[] }
}
export type EventItem = {
  id: number
  title: string
  description: string
  event_date: string
  event_time: string
  end_time: string
  end_date: string | null
  all_day: boolean
  time_zone: string | null
  is_deadline: number
  color: OrganizerColor
  recurrence: Recurrence
  recurrence_interval: number
  recurrence_parent_id: number | null
  created_at: string
  /** The open task this deadline stands for, when there is one. */
  card_id?: number | null
  repeats?: boolean
}
export type EventDetail = EventItem & { comments: Comment[]; notebooks: LinkedNotebook[] }
export type Notebook = { id: number; title: string; content: string; images: string[]; created_at: string }
export type LinkOptions = { notebooks: LinkedNotebook[]; events: EventItem[] }
export type TodayData = { date: string; overdue: Card[]; dueToday: Card[]; doing: Card[]; events: EventItem[] }
export type Backlinks = { cards: Array<{ id: number; title: string; list_title: string }>; events: LinkedEvent[] }

export const organizerColors: OrganizerColor[] = ['gray', 'blue', 'green', 'yellow', 'orange', 'purple']
export const recurrenceLabels: Record<Recurrence, string> = { none: 'Does not repeat', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' }
export const recurrenceUnits: Record<Recurrence, string> = { none: '', daily: 'day', weekdays: 'weekday', weekly: 'week', monthly: 'month' }
export const MAX_FILE_BYTES = 5_000_000

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (response.status === 401 && body?.code === 'AUTH_REQUIRED') window.location.replace('/login')
    throw new Error(sentence(body?.error ?? `Request failed (${response.status})`))
  }
  return response.json()
}

export const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const send = <T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => request<T>(url, { method, ...(body === undefined ? {} : json(body)) })

function sentence(message: string) {
  const text = message.trim()
  return text ? text[0].toUpperCase() + text.slice(1) : 'Request failed'
}
export const messageOf = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback

/** Every screen listens for this so a change made anywhere shows up everywhere. */
const CHANGED = 'organizer-changed'
export const notifyChanged = () => window.dispatchEvent(new Event(CHANGED))

/** Runs `load` when the screen becomes active, when data changes elsewhere, and when the window regains focus. */
export function useLiveData(load: () => void, active: boolean, key: unknown = null) {
  const run = useEffectEvent(load)
  useEffect(() => {
    if (!active) return
    run()
    const refresh = () => run()
    window.addEventListener(CHANGED, refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener(CHANGED, refresh); window.removeEventListener('focus', refresh) }
  }, [active, key])
}

export const isDoneList = (title: string) => title.trim().toLowerCase() === 'done'

/** Moves a task to the Done list. Returns what is needed to put it back. */
export async function completeCard(card: Pick<Card, 'id' | 'list_id'>) {
  const board = await request<List[]>('/api/board')
  const done = board.find((list) => isDoneList(list.title))
  if (!done) throw new Error('Add a list named “Done” to complete tasks.')
  const index = board.find((list) => list.id === card.list_id)?.cards.findIndex((item) => item.id === card.id) ?? 0
  await send('PATCH', `/api/cards/${card.id}/move`, { listId: done.id, index: done.cards.length })
  return { id: card.id, listId: card.list_id, index: Math.max(0, index) }
}

/** Moves a finished task back to To Do (or the first list that isn't Done). */
export async function reopenCard(card: Pick<Card, 'id'>) {
  const board = await request<List[]>('/api/board')
  const target = board.find((list) => list.title.trim().toLowerCase() === 'to do') ?? board.find((list) => !isDoneList(list.title))
  if (!target) throw new Error('There is no list to move this task back to.')
  await send('PATCH', `/api/cards/${card.id}/move`, { listId: target.id, index: target.cards.length })
}

export const undoComplete = (undo: { id: number; listId: number; index: number }) => send('PATCH', `/api/cards/${undo.id}/move`, { listId: undo.listId, index: undo.index })

export const todayQuery =() => `date=${isoDate(new Date())}`

export async function readFile(file: File): Promise<FileDraft> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name || 'That file'} is larger than 5 MB.`)
  return { name: file.name || 'pasted-image.png', mimeType: file.type || 'application/octet-stream', data: await fileToDataUrl(file), size: file.size }
}

export const commentPayload = ({ body, file }: { body: string; file: FileDraft | null }) => ({ body, image: null, fileName: file?.name ?? null, fileMimeType: file?.mimeType ?? null, fileData: file?.data ?? null, fileSize: file?.size ?? null })
