import type { Card, EventItem, List, OrganizerColor, Priority } from './api.ts'
import {
  addDays,
  addMonths,
  compactTime,
  dayShift,
  formatFullDate,
  formatMonthYear,
  formatRangeHeading,
  monthBounds,
  readableDate,
  readableTime,
  startOfWeek,
} from './dates.ts'

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda'
export type AgendaSpan = 'month' | '7d' | '14d' | '30d'
export type ItemKind = 'event' | 'task' | 'deadline'

export type CalendarFilter = {
  kind: 'all' | ItemKind
  color: 'all' | OrganizerColor
  showCompleted: boolean
}

export const defaultFilter: CalendarFilter = {
  kind: 'all',
  color: 'all',
  showCompleted: false,
}

export type TaskCalendarEntry = {
  key: string
  kind: 'task'
  id: number
  title: string
  date: string
  allDay: true
  timeLabel: string
  compactTimeLabel: string
  sortTime: string
  tone: OrganizerColor
  rawColor: OrganizerColor
  completed: boolean
  card: Card | null
  priority: Priority
  listTitle: string
  repeats: boolean
}

export type EventCalendarEntry = {
  key: string
  kind: 'event' | 'deadline'
  id: number
  title: string
  date: string
  allDay: boolean
  timeLabel: string
  compactTimeLabel: string
  sortTime: string
  tone: OrganizerColor | 'deadline'
  rawColor: OrganizerColor
  completed: false
  event: EventItem
  continues: boolean
  spanNote: string
  repeats: boolean
}

export type CalendarEntry = TaskCalendarEntry | EventCalendarEntry

export type AgendaDayGroup = {
  date: string
  entries: CalendarEntry[]
}

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 }
const isDoneTitle = (title: string) => title.trim().toLowerCase() === 'done'

/** An event belongs to a day it starts on, covers, or ends in (an all-day end date is the first day not included). */
export function occursOn(item: EventItem, date: string) {
  if (item.event_date === date) return true
  if (item.event_date > date || !item.end_date) return false
  return item.end_date > date || (item.end_date === date && !item.all_day && item.end_time > '00:00')
}

/** Unique YYYY-MM strings covering every day from `start` through `end` inclusive. */
export function monthsInRange(start: string, end: string) {
  const result: string[] = []
  let cursor = `${start.slice(0, 7)}-01`
  const limit = end.slice(0, 7)
  while (cursor.slice(0, 7) <= limit) {
    result.push(cursor.slice(0, 7))
    cursor = addMonths(cursor, 1)
  }
  return result
}

export function visibleRange(view: CalendarViewMode, anchorDate: string, agendaSpan: AgendaSpan) {
  if (view === 'month') {
    const { start, end } = monthBounds(anchorDate)
    return { start, end, heading: formatMonthYear(anchorDate), months: [anchorDate.slice(0, 7)] }
  }
  if (view === 'week') {
    const start = startOfWeek(anchorDate)
    const end = addDays(start, 6)
    return { start, end, heading: formatRangeHeading(start, end), months: monthsInRange(start, end) }
  }
  if (view === 'day') {
    return { start: anchorDate, end: anchorDate, heading: formatFullDate(anchorDate), months: [anchorDate.slice(0, 7)] }
  }
  if (agendaSpan === 'month') {
    const { start, end } = monthBounds(anchorDate)
    return { start, end, heading: formatMonthYear(anchorDate), months: [anchorDate.slice(0, 7)] }
  }
  const spanDays = agendaSpan === '7d' ? 7 : agendaSpan === '14d' ? 14 : 30
  const start = anchorDate
  const end = addDays(start, spanDays - 1)
  return { start, end, heading: formatRangeHeading(start, end), months: monthsInRange(start, end) }
}

export function stepAnchorDate(view: CalendarViewMode, anchorDate: string, agendaSpan: AgendaSpan, direction: -1 | 1) {
  if (view === 'month' || (view === 'agenda' && agendaSpan === 'month')) return addMonths(anchorDate, direction)
  if (view === 'week' || (view === 'agenda' && agendaSpan === '7d')) return addDays(anchorDate, 7 * direction)
  if (view === 'day') return addDays(anchorDate, direction)
  const spanDays = agendaSpan === '14d' ? 14 : 30
  return addDays(anchorDate, spanDays * direction)
}

export function dedupeEvents(batches: EventItem[][]) {
  const byId = new Map<number, EventItem>()
  for (const batch of batches) {
    for (const item of batch) byId.set(item.id, item)
  }
  return Array.from(byId.values())
}

export function activeFilterCount(filter: CalendarFilter) {
  return Number(filter.kind !== 'all') + Number(filter.color !== 'all') + Number(filter.showCompleted)
}

export function matchesFilter(entry: CalendarEntry, filter: CalendarFilter) {
  if (filter.kind !== 'all' && entry.kind !== filter.kind) return false
  if (filter.color !== 'all' && entry.rawColor !== filter.color) return false
  if (entry.kind === 'task' && entry.completed && !filter.showCompleted) return false
  return true
}

function sortEntries(a: CalendarEntry, b: CalendarEntry) {
  if (a.allDay !== b.allDay) return Number(b.allDay) - Number(a.allDay)
  if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed)
  if (a.allDay && b.allDay) {
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1
    if (a.kind === 'task' && b.kind === 'task') {
      const rankDiff = priorityRank[a.priority] - priorityRank[b.priority]
      if (rankDiff !== 0) return rankDiff
    }
    return a.title.localeCompare(b.title)
  }
  return a.sortTime.localeCompare(b.sortTime) || a.title.localeCompare(b.title)
}

function eventToEntry(event: EventItem, date: string): EventCalendarEntry {
  const repeats = event.recurrence !== 'none' || event.recurrence_parent_id !== null || Boolean(event.repeats)
  if (event.is_deadline) {
    return {
      key: `deadline-${event.id}-${date}`,
      kind: 'deadline',
      id: event.id,
      title: event.title,
      date,
      allDay: false,
      timeLabel: readableTime(event.event_time),
      compactTimeLabel: compactTime(event.event_time),
      sortTime: event.event_time,
      tone: 'deadline',
      rawColor: event.color,
      completed: false,
      event,
      continues: false,
      spanNote: 'Deadline',
      repeats,
    }
  }
  const continues = date !== event.event_date
  const tone: OrganizerColor = event.color === 'gray' ? 'blue' : event.color
  if (event.all_day) {
    const lastDay = event.end_date ? addDays(event.end_date, -1) : event.event_date
    const spanNote = lastDay > event.event_date
      ? (date === lastDay ? 'Final day' : `Through ${readableDate(lastDay)}`)
      : ''
    return {
      key: `event-${event.id}-${date}`,
      kind: 'event',
      id: event.id,
      title: event.title,
      date,
      allDay: true,
      timeLabel: 'All-day',
      compactTimeLabel: '',
      sortTime: '00:00',
      tone,
      rawColor: event.color,
      completed: false,
      event,
      continues,
      spanNote,
      repeats,
    }
  }
  if (continues && event.end_date && date < event.end_date) {
    return {
      key: `event-${event.id}-${date}`,
      kind: 'event',
      id: event.id,
      title: event.title,
      date,
      allDay: true,
      timeLabel: 'All-day',
      compactTimeLabel: '…',
      sortTime: '00:00',
      tone,
      rawColor: event.color,
      completed: false,
      event,
      continues: true,
      spanNote: `Until ${readableDate(event.end_date)}, ${readableTime(event.end_time)}`,
      repeats,
    }
  }
  if (continues && event.end_date === date) {
    return {
      key: `event-${event.id}-${date}`,
      kind: 'event',
      id: event.id,
      title: event.title,
      date,
      allDay: false,
      timeLabel: `Until ${readableTime(event.end_time)}`,
      compactTimeLabel: '…',
      sortTime: '00:00',
      tone,
      rawColor: event.color,
      completed: false,
      event,
      continues: true,
      spanNote: `Started ${readableDate(event.event_date)}`,
      repeats,
    }
  }
  const multiDay = Boolean(event.end_date && event.end_date !== date)
  return {
    key: `event-${event.id}-${date}`,
    kind: 'event',
    id: event.id,
    title: event.title,
    date,
    allDay: false,
    timeLabel: multiDay
      ? `${readableTime(event.event_time)} →`
      : `${readableTime(event.event_time)} – ${readableTime(event.end_time)}`,
    compactTimeLabel: compactTime(event.event_time),
    sortTime: event.event_time,
    tone,
    rawColor: event.color,
    completed: false,
    event,
    continues: false,
    spanNote: multiDay && event.end_date ? `Until ${readableDate(event.end_date)}, ${readableTime(event.end_time)}` : '',
    repeats,
  }
}

export function buildCalendarIndex(events: EventItem[], lists: List[]) {
  const cardsByDate = new Map<string, Array<{ card: Card; completed: boolean }>>()
  const cardById = new Map<number, { card: Card; completed: boolean }>()
  const cardDateKeys = new Set<string>()
  const doneCardTitleDates = new Set<string>()
  const unscheduled: Card[] = []

  for (const list of lists) {
    const completed = isDoneTitle(list.title)
    for (const card of list.cards) {
      cardById.set(card.id, { card, completed })
      if (card.due_date) {
        const bucket = cardsByDate.get(card.due_date)
        if (bucket) bucket.push({ card, completed })
        else cardsByDate.set(card.due_date, [{ card, completed }])
        cardDateKeys.add(`${card.id}:${card.due_date}`)
        if (completed) doneCardTitleDates.add(`${card.due_date}\0${card.title}`)
      } else if (!completed) {
        unscheduled.push(card)
      }
    }
  }

  function entriesOn(date: string, filter: CalendarFilter): CalendarEntry[] {
    const result: CalendarEntry[] = []

    const dated = cardsByDate.get(date) ?? []
    for (const { card, completed } of dated) {
      const entry: TaskCalendarEntry = {
        key: `task-${card.id}-${date}`,
        kind: 'task',
        id: card.id,
        title: card.title,
        date,
        allDay: true,
        timeLabel: 'All-day',
        compactTimeLabel: '',
        sortTime: '00:00',
        tone: card.color === 'gray' ? 'yellow' : card.color,
        rawColor: card.color,
        completed,
        card,
        priority: card.priority,
        listTitle: card.list_title,
        repeats: card.recurrence !== 'none',
      }
      if (matchesFilter(entry, filter)) result.push(entry)
    }

    for (const event of events) {
      if (!occursOn(event, date)) continue
      if (event.is_deadline) {
        if (event.card_id != null) {
          // The owning task card is already shown on this date.
          if (cardDateKeys.has(`${event.card_id}:${date}`)) continue
          // Future occurrence of a repeating task whose next card has not been spawned yet.
          const owner = cardById.get(event.card_id)
          const rawColor: OrganizerColor = owner?.card.color ?? event.color
          const entry: TaskCalendarEntry = {
            key: `task-recur-${event.card_id}-${event.id}-${date}`,
            kind: 'task',
            id: event.card_id,
            title: event.title,
            date,
            allDay: true,
            timeLabel: 'All-day',
            compactTimeLabel: '',
            sortTime: '00:00',
            tone: rawColor === 'gray' ? 'yellow' : rawColor,
            rawColor,
            completed: false,
            card: null,
            priority: owner?.card.priority ?? 'none',
            listTitle: owner?.card.list_title ?? 'Task',
            repeats: true,
          }
          if (matchesFilter(entry, filter)) result.push(entry)
          continue
        }
        // Completed task deadlines lose card_id in deadlineOwner; avoid showing a phantom deadline for done tasks.
        if (doneCardTitleDates.has(`${date}\0${event.title}`)) continue
      }

      const entry = eventToEntry(event, date)
      if (matchesFilter(entry, filter)) result.push(entry)
    }

    result.sort(sortEntries)
    return result
  }

  function agendaDays(start: string, end: string, filter: CalendarFilter): AgendaDayGroup[] {
    const count = dayShift(start, end) + 1
    const groups: AgendaDayGroup[] = []
    for (let offset = 0; offset < count; offset += 1) {
      const date = addDays(start, offset)
      const entries = entriesOn(date, filter)
      if (entries.length > 0) groups.push({ date, entries })
    }
    return groups
  }

  function unscheduledTasks(filter: CalendarFilter): Card[] {
    if (filter.kind !== 'all' && filter.kind !== 'task') return []
    return unscheduled
      .filter((card) => filter.color === 'all' || card.color === filter.color)
      .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.title.localeCompare(b.title))
  }

  return { entriesOn, agendaDays, unscheduledTasks, unscheduledCount: unscheduled.length }
}
