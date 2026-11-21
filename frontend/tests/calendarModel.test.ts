import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Card, EventItem, List } from '../src/api.ts'
import {
  activeFilterCount,
  buildCalendarIndex,
  dedupeEvents,
  defaultFilter,
  occursOn,
  stepAnchorDate,
  visibleRange,
} from '../src/calendarModel.ts'
import { addMonths, isIsoDate, startOfWeek } from '../src/dates.ts'

function makeEvent(overrides: Partial<EventItem> = {}): EventItem {
  return {
    id: 1,
    title: 'Team sync',
    description: '',
    event_date: '2026-11-22',
    event_time: '09:00',
    end_time: '10:00',
    end_date: null,
    all_day: false,
    time_zone: null,
    is_deadline: 0,
    color: 'blue',
    recurrence: 'none',
    recurrence_interval: 1,
    recurrence_parent_id: null,
    created_at: '2026-11-01 00:00:00',
    card_id: null,
    ...overrides,
  }
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 10,
    list_id: 1,
    list_title: 'To Do',
    title: 'Finish v1',
    description: '',
    color: 'gray',
    due_date: '2026-11-22',
    priority: 'medium',
    recurrence: 'none',
    recurrence_interval: 1,
    checklist_count: 0,
    checklist_completed: 0,
    attachment_count: 0,
    created_at: '2026-11-01 00:00:00',
    ...overrides,
  }
}

describe('dates helpers', () => {
  it('validates ISO dates strictly', () => {
    assert.equal(isIsoDate('2026-11-21'), true)
    assert.equal(isIsoDate('2026-02-29'), false)
    assert.equal(isIsoDate('2024-02-29'), true)
    assert.equal(isIsoDate('11/21/2026'), false)
    assert.equal(isIsoDate(''), false)
  })

  it('clamps month arithmetic at month end', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28')
    assert.equal(addMonths('2026-11-21', 1), '2026-12-21')
  })

  it('computes Monday start of week', () => {
    assert.equal(startOfWeek('2026-11-21'), '2026-11-16') // Saturday -> Monday
    assert.equal(startOfWeek('2026-11-22'), '2026-11-16') // Sunday -> Monday
    assert.equal(startOfWeek('2026-11-16'), '2026-11-16') // Monday -> Monday
  })
})

describe('calendarModel ranges & stepping', () => {
  it('calculates cross-month weeks and rolling agenda ranges', () => {
    const week = visibleRange('week', '2026-12-01', 'month')
    assert.equal(week.start, '2026-11-30')
    assert.equal(week.end, '2026-12-06')
    assert.deepEqual(week.months, ['2026-11', '2026-12'])

    const agenda14 = visibleRange('agenda', '2026-11-25', '14d')
    assert.equal(agenda14.start, '2026-11-25')
    assert.equal(agenda14.end, '2026-12-08')
    assert.deepEqual(agenda14.months, ['2026-11', '2026-12'])
  })

  it('steps anchor dates according to view and span', () => {
    assert.equal(stepAnchorDate('month', '2026-11-21', 'month', 1), '2026-12-21')
    assert.equal(stepAnchorDate('agenda', '2026-11-21', 'month', -1), '2026-10-21')
    assert.equal(stepAnchorDate('week', '2026-11-21', 'month', 1), '2026-11-28')
    assert.equal(stepAnchorDate('day', '2026-11-21', 'month', -1), '2026-11-20')
    assert.equal(stepAnchorDate('agenda', '2026-11-21', '14d', 1), '2026-12-05')
  })

  it('deduplicates events merged from adjacent month queries', () => {
    const a = makeEvent({ id: 1 })
    const b = makeEvent({ id: 2, title: 'Design review' })
    const merged = dedupeEvents([[a, b], [b]])
    assert.equal(merged.length, 2)
  })
})

describe('calendarModel index & deduplication', () => {
  it('merges tasks and events without duplicating task-owned deadlines', () => {
    const card = makeCard({ id: 10, title: 'Finish v1', due_date: '2026-11-22', color: 'gray' })
    const taskDeadline = makeEvent({ id: 20, title: 'Finish v1', event_date: '2026-11-22', is_deadline: 1, card_id: 10 })
    const standaloneDeadline = makeEvent({ id: 21, title: 'Submit tax form', event_date: '2026-11-22', event_time: '17:00', end_time: '17:00', is_deadline: 1, card_id: null })
    const allDayEvent = makeEvent({ id: 22, title: 'Cycle Deployment', event_date: '2026-11-22', end_date: '2026-11-23', all_day: true, color: 'gray' })
    const timedEvent = makeEvent({ id: 23, title: 'Standup', event_date: '2026-11-22', event_time: '10:30', end_time: '11:00', color: 'green' })
    const lists: List[] = [{ id: 1, title: 'To Do', cards: [card] }]

    const index = buildCalendarIndex([taskDeadline, standaloneDeadline, allDayEvent, timedEvent], lists)
    const entries = index.entriesOn('2026-11-22', defaultFilter)

    assert.equal(entries.length, 4)
    // All-day event comes first with cool blue default tone for gray events
    assert.equal(entries[0].kind, 'event')
    assert.equal(entries[0].title, 'Cycle Deployment')
    assert.equal(entries[0].timeLabel, 'All-day')
    assert.equal(entries[0].tone, 'blue')
    // Task appears once (not twice) with warm amber default tone for gray tasks
    assert.equal(entries[1].kind, 'task')
    assert.equal(entries[1].id, 10)
    assert.equal(entries[1].timeLabel, 'All-day')
    assert.equal(entries[1].tone, 'yellow')
    // Timed event then standalone deadline
    assert.equal(entries[2].kind, 'event')
    assert.equal(entries[2].title, 'Standup')
    assert.equal(entries[3].kind, 'deadline')
    assert.equal(entries[3].title, 'Submit tax form')
  })

  it('preserves future occurrences of repeating tasks while hiding completed task mirrors by default', () => {
    const recurringCard = makeCard({ id: 30, title: 'Weekly review', due_date: '2026-11-22', recurrence: 'weekly' })
    const doneCard = makeCard({ id: 31, list_id: 2, list_title: 'Done', title: 'Shipped item', due_date: '2026-11-22' })
    const rootDeadline = makeEvent({ id: 40, title: 'Weekly review', event_date: '2026-11-22', is_deadline: 1, card_id: 30, recurrence: 'weekly' })
    const nextDeadline = makeEvent({ id: 41, title: 'Weekly review', event_date: '2026-11-29', is_deadline: 1, card_id: 30, recurrence_parent_id: 40 })
    const doneDeadline = makeEvent({ id: 42, title: 'Shipped item', event_date: '2026-11-22', is_deadline: 1, card_id: null })
    const lists: List[] = [
      { id: 1, title: 'To Do', cards: [recurringCard] },
      { id: 2, title: 'Done', cards: [doneCard] },
    ]

    const index = buildCalendarIndex([rootDeadline, nextDeadline, doneDeadline], lists)

    // On Nov 22 with default filter: only the open recurring card (no duplicate rootDeadline, no phantom doneDeadline)
    const nov22 = index.entriesOn('2026-11-22', defaultFilter)
    assert.equal(nov22.length, 1)
    assert.equal(nov22[0].id, 30)

    // On Nov 22 with showCompleted: both open card and completed card appear, still no phantom doneDeadline
    const nov22All = index.entriesOn('2026-11-22', { ...defaultFilter, showCompleted: true })
    assert.equal(nov22All.length, 2)
    assert.equal(nov22All.filter((e) => e.completed).length, 1)

    // On Nov 29: future recurring task occurrence appears as a task pointing to card 30
    const nov29 = index.entriesOn('2026-11-29', defaultFilter)
    assert.equal(nov29.length, 1)
    assert.equal(nov29[0].kind, 'task')
    assert.equal(nov29[0].id, 30)
    assert.equal(nov29[0].repeats, true)
  })

  it('handles multi-day all-day events accurately (exclusive end date)', () => {
    const multiDay = makeEvent({ id: 50, title: 'Conference', event_date: '2026-11-20', end_date: '2026-11-23', all_day: true })
    assert.equal(occursOn(multiDay, '2026-11-20'), true)
    assert.equal(occursOn(multiDay, '2026-11-22'), true)
    assert.equal(occursOn(multiDay, '2026-11-23'), false)

    const index = buildCalendarIndex([multiDay], [])
    const groups = index.agendaDays('2026-11-19', '2026-11-25', defaultFilter)
    assert.deepEqual(groups.map((g) => g.date), ['2026-11-20', '2026-11-21', '2026-11-22'])
  })

  it('filters by kind, color, and reports unscheduled open tasks', () => {
    const datedTask = makeCard({ id: 60, title: 'Write docs', due_date: '2026-11-22', color: 'orange' })
    const undatedTask = makeCard({ id: 61, title: 'Someday idea', due_date: null, color: 'purple' })
    const event = makeEvent({ id: 62, title: 'Demo', event_date: '2026-11-22', color: 'blue' })
    const index = buildCalendarIndex([event], [{ id: 1, title: 'To Do', cards: [datedTask, undatedTask] }])

    assert.equal(index.entriesOn('2026-11-22', { ...defaultFilter, kind: 'task' }).length, 1)
    assert.equal(index.entriesOn('2026-11-22', { ...defaultFilter, color: 'blue' }).length, 1)
    assert.equal(index.unscheduledTasks(defaultFilter).length, 1)
    assert.equal(index.unscheduledTasks({ ...defaultFilter, kind: 'event' }).length, 0)
    assert.equal(activeFilterCount({ kind: 'task', color: 'orange', showCompleted: true }), 3)
  })
})
