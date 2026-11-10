import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  attachmentJson,
  cardInclude,
  cardJson,
  checklistJson,
  eventJson,
  getCardSummary,
  deleteCard,
  moveCard,
  nextCardPosition,
  nextChecklistPosition,
  syncCardDeadline,
} from './store.js'

const id = z.number().int().positive()
const title = z.string().trim().min(1).max(500)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}, 'must be a real date in YYYY-MM-DD format')
const month = z.string().regex(/^\d{4}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const organizerColor = z.enum(['blue', 'green', 'yellow', 'purple', 'orange', 'gray'])
const priority = z.enum(['none', 'low', 'medium', 'high'])
const recurrence = z.enum(['none', 'daily', 'weekdays', 'weekly', 'monthly'])
const recurrenceInterval = z.number().int().min(1).max(365)

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: { result: value },
  }
}

function tool(handler) {
  return async (input) => {
    try {
      return result(await handler(input))
    } catch (cause) {
      return {
        isError: true,
        content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Organizer operation failed' }],
      }
    }
  }
}

function requireRow(row, message) {
  if (!row) throw new Error(message)
  return row
}

export function createOrganizerMcpServer(db) {
  const server = new McpServer({ name: 'lazy-organizer', version: '1.0.0' })

  server.registerTool('get_board', {
    description: 'Get every organizer list and its ordered tasks.',
    annotations: { readOnlyHint: true },
  }, tool(async () => {
    const lists = await db.list.findMany({
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, cards: { orderBy: [{ position: 'asc' }, { id: 'asc' }], include: cardInclude } },
    })
    return lists.map(({ cards, ...list }) => ({ ...list, cards: cards.map(cardJson) }))
  }))

  server.registerTool('get_card', {
    description: 'Get one task with comments, checklist, attachment metadata, and linked records.',
    inputSchema: { card_id: id },
    annotations: { readOnlyHint: true },
  }, tool(async ({ card_id }) => {
    const card = requireRow(await db.card.findUnique({
      where: { id: card_id },
      include: {
        ...cardInclude,
        comments: { orderBy: { id: 'desc' } },
        checklist: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        attachments: { orderBy: { id: 'desc' } },
        eventLinks: { orderBy: [{ event: { eventDate: 'asc' } }, { event: { eventTime: 'asc' } }], include: { event: true } },
        notebookLinks: { orderBy: { notebook: { title: 'asc' } }, include: { notebook: true } },
      },
    }), 'task not found')
    return {
      ...cardJson(card),
      comments: card.comments.map(({ id, body, createdAt }) => ({ id, body, created_at: createdAt })),
      checklist: card.checklist.map((item) => checklistJson(item)),
      attachments: card.attachments.map((item) => attachmentJson(item, false)),
      links: {
        events: card.eventLinks.map(({ event }) => ({ id: event.id, title: event.title, event_date: event.eventDate, event_time: event.eventTime, is_deadline: event.isDeadline })),
        notebooks: card.notebookLinks.map(({ notebook }) => ({ id: notebook.id, title: notebook.title })),
      },
    }
  }))

  server.registerTool('create_card', {
    description: 'Create a task at the end of an organizer list.',
    inputSchema: {
      list_id: id.describe('Destination list ID from get_board'),
      title,
      description: z.string().trim().max(20_000).optional(),
      due_date: date.nullable().optional(),
      priority: priority.optional(),
      color: organizerColor.optional(),
      recurrence: recurrence.optional(),
      recurrence_interval: recurrenceInterval.optional(),
    },
    annotations: { destructiveHint: false },
  }, tool(async ({ list_id, title, description = '', due_date = null, priority = 'none', color = 'gray', recurrence = 'none', recurrence_interval = 1 }) => {
    requireRow(await db.list.findUnique({ where: { id: list_id }, select: { id: true } }), 'list not found')
    if (recurrence !== 'none' && !due_date) throw new Error('recurring tasks need a due_date')
    const card = await db.$transaction(async (tx) => {
      const created = await tx.card.create({
        data: { listId: list_id, title, description, position: await nextCardPosition(tx, list_id), color, dueDate: due_date, priority, recurrence, recurrenceInterval: recurrence_interval },
        include: cardInclude,
      })
      await syncCardDeadline(tx, { cardId: created.id, title, description, color, dueDate: due_date, recurrence, recurrenceInterval: recurrence_interval })
      return created
    })
    return cardJson(card)
  }))

  server.registerTool('update_card', {
    description: 'Change task text, due date, priority, color, or recurrence. Omitted fields stay unchanged.',
    inputSchema: {
      card_id: id,
      title: title.optional(),
      description: z.string().trim().max(20_000).optional(),
      due_date: date.nullable().optional(),
      priority: priority.optional(),
      color: organizerColor.optional(),
      recurrence: recurrence.optional(),
      recurrence_interval: recurrenceInterval.optional(),
    },
    annotations: { idempotentHint: true },
  }, tool(async ({ card_id, ...changes }) => {
    const current = requireRow(await db.card.findUnique({ where: { id: card_id } }), 'task not found')
    if (Object.values(changes).every((value) => value === undefined)) throw new Error('at least one field is required')
    const nextDueDate = changes.due_date === undefined ? current.dueDate : changes.due_date
    const nextRecurrence = changes.recurrence ?? current.recurrence
    const nextTitle = changes.title ?? current.title
    const nextDescription = changes.description ?? current.description
    const nextColor = changes.color ?? current.color
    const nextRecurrenceInterval = changes.recurrence_interval ?? current.recurrenceInterval
    if (nextRecurrence !== 'none' && !nextDueDate) throw new Error('recurring tasks need a due_date')
    await db.$transaction(async (tx) => {
      await tx.card.update({
        where: { id: card_id },
        data: {
          ...(changes.title !== undefined && { title: changes.title }),
          ...(changes.description !== undefined && { description: changes.description }),
          ...(changes.color !== undefined && { color: changes.color }),
          dueDate: nextDueDate,
          ...(changes.priority !== undefined && { priority: changes.priority }),
          recurrence: nextRecurrence,
          ...(changes.recurrence_interval !== undefined && { recurrenceInterval: changes.recurrence_interval }),
        },
      })
      await syncCardDeadline(tx, { cardId: card_id, title: nextTitle, description: nextDescription, color: nextColor, dueDate: nextDueDate, recurrence: nextRecurrence, recurrenceInterval: nextRecurrenceInterval })
    })
    return getCardSummary(db, card_id)
  }))

  server.registerTool('delete_card', {
    description: 'Permanently delete a card and its comments.',
    inputSchema: { card_id: id },
    annotations: { destructiveHint: true },
  }, tool(async ({ card_id }) => {
    if (!await deleteCard(db, card_id)) throw new Error('card not found')
    return { ok: true }
  }))

  server.registerTool('move_card', {
    description: 'Move a card to an ordered position in a list. Position is zero-based.',
    inputSchema: { card_id: id, list_id: id.describe('Destination list ID from get_board'), position: z.number().int().nonnegative() },
  }, tool(async ({ card_id, list_id, position }) => {
    const card = requireRow(await db.card.findUnique({ where: { id: card_id } }), 'card not found')
    requireRow(await db.list.findUnique({ where: { id: list_id }, select: { id: true } }), 'list not found')
    await moveCard(db, card, list_id, position)
    return getCardSummary(db, card_id)
  }))

  server.registerTool('add_card_comment', {
    description: 'Add a text comment to a card.',
    inputSchema: { card_id: id, body: z.string().trim().min(1).max(20_000) },
    annotations: { destructiveHint: false },
  }, tool(async ({ card_id, body }) => {
    requireRow(await db.card.findUnique({ where: { id: card_id }, select: { id: true } }), 'card not found')
    const comment = await db.cardComment.create({ data: { cardId: card_id, body } })
    return { id: comment.id, body: comment.body, created_at: comment.createdAt }
  }))

  server.registerTool('add_checklist_item', {
    description: 'Add a checklist item to a task.',
    inputSchema: { card_id: id, title },
    annotations: { destructiveHint: false },
  }, tool(async ({ card_id, title }) => {
    requireRow(await db.card.findUnique({ where: { id: card_id }, select: { id: true } }), 'task not found')
    const item = await db.checklistItem.create({ data: { cardId: card_id, title, position: await nextChecklistPosition(db, card_id) } })
    return checklistJson(item, true)
  }))

  server.registerTool('update_checklist_item', {
    description: 'Rename or complete a task checklist item.',
    inputSchema: { checklist_id: id, title: title.optional(), completed: z.boolean().optional() },
    annotations: { idempotentHint: true },
  }, tool(async ({ checklist_id, title, completed }) => {
    requireRow(await db.checklistItem.findUnique({ where: { id: checklist_id }, select: { id: true } }), 'checklist item not found')
    if (title === undefined && completed === undefined) throw new Error('title or completed is required')
    const item = await db.checklistItem.update({ where: { id: checklist_id }, data: { ...(title !== undefined && { title }), ...(completed !== undefined && { completed: Number(completed) }) } })
    return checklistJson(item, true)
  }))

  server.registerTool('delete_checklist_item', {
    description: 'Delete a task checklist item.',
    inputSchema: { checklist_id: id },
    annotations: { destructiveHint: true },
  }, tool(async ({ checklist_id }) => {
    const deleted = await db.checklistItem.deleteMany({ where: { id: checklist_id } })
    if (!deleted.count) throw new Error('checklist item not found')
    return { ok: true }
  }))

  server.registerTool('link_records', {
    description: 'Link a task to an event or notebook.',
    inputSchema: { card_id: id, record_type: z.enum(['event', 'notebook']), record_id: id },
    annotations: { destructiveHint: false },
  }, tool(async ({ card_id, record_type, record_id }) => {
    requireRow(await db.card.findUnique({ where: { id: card_id }, select: { id: true } }), 'task not found')
    if (record_type === 'event') {
      requireRow(await db.event.findUnique({ where: { id: record_id }, select: { id: true } }), 'event not found')
      await db.cardEventLink.upsert({ where: { cardId_eventId: { cardId: card_id, eventId: record_id } }, update: {}, create: { cardId: card_id, eventId: record_id } })
    } else {
      requireRow(await db.notebook.findUnique({ where: { id: record_id }, select: { id: true } }), 'notebook not found')
      await db.cardNotebookLink.upsert({ where: { cardId_notebookId: { cardId: card_id, notebookId: record_id } }, update: {}, create: { cardId: card_id, notebookId: record_id } })
    }
    return { ok: true }
  }))

  server.registerTool('unlink_records', {
    description: 'Remove a link from a task to an event or notebook.',
    inputSchema: { card_id: id, record_type: z.enum(['event', 'notebook']), record_id: id },
    annotations: { destructiveHint: true },
  }, tool(async ({ card_id, record_type, record_id }) => {
    const deleted = record_type === 'event'
      ? await db.cardEventLink.deleteMany({ where: { cardId: card_id, eventId: record_id } })
      : await db.cardNotebookLink.deleteMany({ where: { cardId: card_id, notebookId: record_id } })
    if (!deleted.count) throw new Error('link not found')
    return { ok: true }
  }))

  server.registerTool('list_events', {
    description: 'List calendar events for a month, or upcoming deadlines. Defaults to the current month.',
    inputSchema: { month: month.optional().describe('Calendar month in YYYY-MM format'), upcoming_deadlines: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: true },
  }, tool(async ({ month, upcoming_deadlines }) => {
    if (upcoming_deadlines) {
      const events = await db.event.findMany({ where: { isDeadline: 1, eventDate: { gte: new Date().toLocaleDateString('en-CA') } }, orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }, { id: 'asc' }], take: 100 })
      return events.map(eventJson)
    }
    const now = new Date()
    const selectedMonth = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const start = `${selectedMonth}-01`
    const endDate = new Date(`${start}T00:00:00Z`)
    endDate.setUTCMonth(endDate.getUTCMonth() + 1)
    const events = await db.event.findMany({ where: { eventDate: { gte: start, lt: endDate.toISOString().slice(0, 10) } }, orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }, { endTime: 'asc' }, { id: 'asc' }], take: 100 })
    return events.map(eventJson)
  }))

  server.registerTool('create_event', {
    description: 'Create a calendar event or deadline. Deadlines need no end_time.',
    inputSchema: {
      title,
      event_date: date,
      event_time: time,
      end_time: time.optional(),
      description: z.string().trim().max(20_000).optional(),
      is_deadline: z.boolean().optional().default(false),
      color: organizerColor.optional(),
      recurrence: recurrence.optional(),
      recurrence_interval: recurrenceInterval.optional(),
    },
    annotations: { destructiveHint: false },
  }, tool(async ({ title, event_date, event_time, end_time, description = '', is_deadline, color = 'blue', recurrence = 'none', recurrence_interval = 1 }) => {
    const finalEndTime = is_deadline ? event_time : end_time
    if (!finalEndTime) throw new Error('end_time is required for calendar events')
    if (!is_deadline && finalEndTime <= event_time) throw new Error('end_time must be after event_time')
    const event = await db.event.create({ data: { title, description, eventDate: event_date, eventTime: event_time, endTime: finalEndTime, isDeadline: Number(is_deadline), color, recurrence, recurrenceInterval: recurrence_interval } })
    return eventJson(event)
  }))

  server.registerTool('update_event', {
    description: 'Change an event or deadline, including recurrence. Omitted fields stay unchanged.',
    inputSchema: {
      event_id: id,
      title: title.optional(),
      description: z.string().trim().max(20_000).optional(),
      event_date: date.optional(),
      event_time: time.optional(),
      end_time: time.optional(),
      color: organizerColor.optional(),
      recurrence: recurrence.optional(),
      recurrence_interval: recurrenceInterval.optional(),
    },
    annotations: { idempotentHint: true },
  }, tool(async ({ event_id, ...changes }) => {
    const current = requireRow(await db.event.findUnique({ where: { id: event_id } }), 'event not found')
    if (Object.values(changes).every((value) => value === undefined)) throw new Error('at least one field is required')
    const nextStart = changes.event_time ?? current.eventTime
    const nextEnd = current.isDeadline ? nextStart : (changes.end_time ?? current.endTime)
    if (!current.isDeadline && nextEnd <= nextStart) throw new Error('end_time must be after event_time')
    const event = await db.event.update({
      where: { id: event_id },
      data: {
        ...(changes.title !== undefined && { title: changes.title }),
        ...(changes.description !== undefined && { description: changes.description }),
        ...(changes.event_date !== undefined && { eventDate: changes.event_date }),
        eventTime: nextStart,
        endTime: nextEnd,
        ...(changes.color !== undefined && { color: changes.color }),
        ...(changes.recurrence !== undefined && { recurrence: changes.recurrence }),
        ...(changes.recurrence_interval !== undefined && { recurrenceInterval: changes.recurrence_interval }),
      },
    })
    return eventJson(event)
  }))

  server.registerTool('delete_event', {
    description: 'Permanently delete an event or deadline and its comments.',
    inputSchema: { event_id: id },
    annotations: { destructiveHint: true },
  }, tool(async ({ event_id }) => {
    const deleted = await db.event.deleteMany({ where: { id: event_id } })
    if (!deleted.count) throw new Error('event not found')
    return { ok: true }
  }))

  server.registerTool('add_event_comment', {
    description: 'Add a text comment to an event or deadline.',
    inputSchema: { event_id: id, body: z.string().trim().min(1).max(20_000) },
    annotations: { destructiveHint: false },
  }, tool(async ({ event_id, body }) => {
    requireRow(await db.event.findUnique({ where: { id: event_id }, select: { id: true } }), 'event not found')
    const comment = await db.eventComment.create({ data: { eventId: event_id, body } })
    return { id: comment.id, body: comment.body, created_at: comment.createdAt }
  }))

  server.registerTool('list_notebooks', {
    description: 'List notebook IDs and titles without loading their potentially large contents.',
    annotations: { readOnlyHint: true },
  }, tool(async () => (await db.notebook.findMany({ orderBy: { id: 'desc' }, select: { id: true, title: true, createdAt: true } }))
    .map(({ id, title, createdAt }) => ({ id, title, created_at: createdAt }))))

  server.registerTool('get_notebook', {
    description: 'Get a notebook title and HTML content. Embedded images are omitted.',
    inputSchema: { notebook_id: id },
    annotations: { readOnlyHint: true },
  }, tool(async ({ notebook_id }) => {
    const notebook = requireRow(await db.notebook.findUnique({ where: { id: notebook_id }, select: { id: true, title: true, content: true, createdAt: true } }), 'notebook not found')
    return { id: notebook.id, title: notebook.title, content: notebook.content, created_at: notebook.createdAt }
  }))

  server.registerTool('create_notebook', {
    description: 'Create a notebook with optional HTML content.',
    inputSchema: { title, content: z.string().max(200_000).optional() },
    annotations: { destructiveHint: false },
  }, tool(async ({ title, content = '' }) => {
    const notebook = await db.notebook.create({ data: { title, content } })
    return { id: notebook.id, title: notebook.title, content: notebook.content, created_at: notebook.createdAt }
  }))

  server.registerTool('update_notebook', {
    description: 'Change a notebook title or HTML content without changing embedded images.',
    inputSchema: { notebook_id: id, title: title.optional(), content: z.string().max(200_000).optional() },
    annotations: { idempotentHint: true },
  }, tool(async ({ notebook_id, title, content }) => {
    requireRow(await db.notebook.findUnique({ where: { id: notebook_id }, select: { id: true } }), 'notebook not found')
    if (title === undefined && content === undefined) throw new Error('title or content is required')
    const notebook = await db.notebook.update({ where: { id: notebook_id }, data: { ...(title !== undefined && { title }), ...(content !== undefined && { content }) } })
    return { id: notebook.id, title: notebook.title, content: notebook.content, created_at: notebook.createdAt }
  }))

  server.registerTool('delete_notebook', {
    description: 'Permanently delete a notebook.',
    inputSchema: { notebook_id: id },
    annotations: { destructiveHint: true },
  }, tool(async ({ notebook_id }) => {
    const deleted = await db.notebook.deleteMany({ where: { id: notebook_id } })
    if (!deleted.count) throw new Error('notebook not found')
    return { ok: true }
  }))

  return server
}
