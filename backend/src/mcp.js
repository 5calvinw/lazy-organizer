import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

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
      return result(handler(input))
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

function nextOccurrence(value, repeat, interval) {
  const date = new Date(`${value}T00:00:00Z`)
  if (repeat === 'daily') date.setUTCDate(date.getUTCDate() + interval)
  else if (repeat === 'weekly') date.setUTCDate(date.getUTCDate() + (7 * interval))
  else if (repeat === 'weekdays') {
    let remaining = interval
    while (remaining > 0) {
      date.setUTCDate(date.getUTCDate() + 1)
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1
    }
  } else if (repeat === 'monthly') {
    const day = date.getUTCDate()
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + interval, 1))
    target.setUTCDate(Math.min(day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()))
    return target.toISOString().slice(0, 10)
  } else return null
  return date.toISOString().slice(0, 10)
}

export function createOrganizerMcpServer(db) {
  const server = new McpServer({ name: 'lazy-organizer', version: '1.0.0' })
  const cardSelect = `
    SELECT c.id, c.list_id, c.title, c.description, c.color, c.due_date, c.priority,
      c.recurrence, c.recurrence_interval, c.created_at, l.title AS list_title,
      (SELECT COUNT(*) FROM checklist_items ci WHERE ci.card_id = c.id) AS checklist_count,
      (SELECT COUNT(*) FROM checklist_items ci WHERE ci.card_id = c.id AND ci.completed = 1) AS checklist_completed,
      (SELECT COUNT(*) FROM card_attachments ca WHERE ca.card_id = c.id) AS attachment_count
    FROM cards c JOIN lists l ON l.id = c.list_id
  `
  const eventSelect = `SELECT id, title, description, event_date, event_time, end_time, is_deadline, color,
    recurrence, recurrence_interval, recurrence_parent_id, created_at FROM events`

  server.registerTool('get_board', {
    description: 'Get every organizer list and its ordered tasks.',
    annotations: { readOnlyHint: true },
  }, tool(() => {
    const lists = db.prepare('SELECT id, title FROM lists ORDER BY position, id').all()
    const cards = db.prepare(`${cardSelect} ORDER BY c.position, c.id`).all()
    return lists.map((list) => ({ ...list, cards: cards.filter((card) => card.list_id === list.id) }))
  }))

  server.registerTool('get_card', {
    description: 'Get one task with comments, checklist, attachment metadata, and linked records.',
    inputSchema: { card_id: id },
    annotations: { readOnlyHint: true },
  }, tool(({ card_id }) => {
    const card = requireRow(db.prepare(`${cardSelect} WHERE c.id = ?`).get(card_id), 'task not found')
    const comments = db.prepare('SELECT id, body, created_at FROM comments WHERE card_id = ? ORDER BY id DESC').all(card_id)
    const checklist = db.prepare('SELECT id, title, completed, position, created_at FROM checklist_items WHERE card_id = ? ORDER BY position, id').all(card_id)
    const attachments = db.prepare('SELECT id, name, mime_type, size, created_at FROM card_attachments WHERE card_id = ? ORDER BY id DESC').all(card_id)
    const events = db.prepare(`SELECT e.id, e.title, e.event_date, e.event_time, e.is_deadline FROM card_event_links l
      JOIN events e ON e.id = l.event_id WHERE l.card_id = ? ORDER BY e.event_date, e.event_time`).all(card_id)
    const notebooks = db.prepare(`SELECT n.id, n.title FROM card_notebook_links l
      JOIN notebooks n ON n.id = l.notebook_id WHERE l.card_id = ? ORDER BY n.title`).all(card_id)
    return { ...card, comments, checklist, attachments, links: { events, notebooks } }
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
  }, tool(({ list_id, title, description = '', due_date = null, priority = 'none', color = 'gray', recurrence = 'none', recurrence_interval = 1 }) => {
    requireRow(db.prepare('SELECT 1 FROM lists WHERE id = ?').get(list_id), 'list not found')
    if (recurrence !== 'none' && !due_date) throw new Error('recurring tasks need a due_date')
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(list_id).next
    const created = db.prepare(`INSERT INTO cards
      (list_id, title, description, position, color, due_date, priority, recurrence, recurrence_interval)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(list_id, title, description, position, color, due_date, priority, recurrence, recurrence_interval)
    return db.prepare(`${cardSelect} WHERE c.id = ?`).get(created.lastInsertRowid)
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
  }, tool(({ card_id, ...changes }) => {
    const current = requireRow(db.prepare(`${cardSelect} WHERE c.id = ?`).get(card_id), 'task not found')
    if (Object.values(changes).every((value) => value === undefined)) throw new Error('at least one field is required')
    const nextDueDate = changes.due_date === undefined ? current.due_date : changes.due_date
    const nextRecurrence = changes.recurrence ?? current.recurrence
    if (nextRecurrence !== 'none' && !nextDueDate) throw new Error('recurring tasks need a due_date')
    db.prepare(`UPDATE cards SET title = ?, description = ?, color = ?, due_date = ?, priority = ?, recurrence = ?, recurrence_interval = ? WHERE id = ?`).run(
      changes.title ?? current.title,
      changes.description ?? current.description,
      changes.color ?? current.color,
      nextDueDate,
      changes.priority ?? current.priority,
      nextRecurrence,
      changes.recurrence_interval ?? current.recurrence_interval,
      card_id,
    )
    return db.prepare(`${cardSelect} WHERE c.id = ?`).get(card_id)
  }))

  server.registerTool('delete_card', {
    description: 'Permanently delete a card and its comments.',
    inputSchema: { card_id: id },
    annotations: { destructiveHint: true },
  }, tool(({ card_id }) => {
    const deleted = db.prepare('DELETE FROM cards WHERE id = ?').run(card_id)
    if (!deleted.changes) throw new Error('card not found')
    return { ok: true }
  }))

  server.registerTool('move_card', {
    description: 'Move a card to an ordered position in a list. Position is zero-based.',
    inputSchema: {
      card_id: id,
      list_id: id.describe('Destination list ID from get_board'),
      position: z.number().int().nonnegative(),
    },
  }, tool(({ card_id, list_id, position }) => {
    const card = requireRow(db.prepare('SELECT * FROM cards WHERE id = ?').get(card_id), 'card not found')
    requireRow(db.prepare('SELECT 1 FROM lists WHERE id = ?').get(list_id), 'list not found')
    const source = db.prepare('SELECT id FROM cards WHERE list_id = ? AND id != ? ORDER BY position, id').all(card.list_id, card_id)
    const destination = card.list_id === list_id ? source : db.prepare('SELECT id FROM cards WHERE list_id = ? ORDER BY position, id').all(list_id)
    destination.splice(Math.min(position, destination.length), 0, { id: card_id })
    const update = db.prepare('UPDATE cards SET list_id = ?, position = ? WHERE id = ?')
    db.exec('BEGIN')
    try {
      if (card.list_id !== list_id) source.forEach((item, index) => update.run(card.list_id, index, item.id))
      destination.forEach((item, index) => update.run(list_id, index, item.id))
      const sourceList = db.prepare('SELECT title FROM lists WHERE id = ?').get(card.list_id)
      const destinationList = db.prepare('SELECT title FROM lists WHERE id = ?').get(list_id)
      if (sourceList.title.toLowerCase() !== 'done' && destinationList.title.toLowerCase() === 'done' && card.recurrence !== 'none') {
        const nextDueDate = nextOccurrence(card.due_date, card.recurrence, card.recurrence_interval)
        if (nextDueDate) {
          const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(card.list_id).next
          const created = db.prepare(`INSERT INTO cards
            (list_id, title, description, position, color, due_date, priority, recurrence, recurrence_interval)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(card.list_id, card.title, card.description, nextPosition, card.color, nextDueDate, card.priority, card.recurrence, card.recurrence_interval)
          db.prepare("UPDATE cards SET recurrence = 'none', recurrence_interval = 1 WHERE id = ?").run(card.id)
          db.prepare('INSERT INTO checklist_items (card_id, title, position) SELECT ?, title, position FROM checklist_items WHERE card_id = ?').run(created.lastInsertRowid, card.id)
          db.prepare('INSERT INTO card_event_links (card_id, event_id) SELECT ?, event_id FROM card_event_links WHERE card_id = ?').run(created.lastInsertRowid, card.id)
          db.prepare('INSERT INTO card_notebook_links (card_id, notebook_id) SELECT ?, notebook_id FROM card_notebook_links WHERE card_id = ?').run(created.lastInsertRowid, card.id)
        }
      }
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    }
    return db.prepare(`${cardSelect} WHERE c.id = ?`).get(card_id)
  }))

  server.registerTool('add_card_comment', {
    description: 'Add a text comment to a card.',
    inputSchema: { card_id: id, body: z.string().trim().min(1).max(20_000) },
    annotations: { destructiveHint: false },
  }, tool(({ card_id, body }) => {
    requireRow(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(card_id), 'card not found')
    const created = db.prepare('INSERT INTO comments (card_id, body) VALUES (?, ?)').run(card_id, body)
    return db.prepare('SELECT id, body, created_at FROM comments WHERE id = ?').get(created.lastInsertRowid)
  }))

  server.registerTool('add_checklist_item', {
    description: 'Add a checklist item to a task.',
    inputSchema: { card_id: id, title },
    annotations: { destructiveHint: false },
  }, tool(({ card_id, title }) => {
    requireRow(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(card_id), 'task not found')
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM checklist_items WHERE card_id = ?').get(card_id).next
    const created = db.prepare('INSERT INTO checklist_items (card_id, title, position) VALUES (?, ?, ?)').run(card_id, title, position)
    return db.prepare('SELECT id, card_id, title, completed, position, created_at FROM checklist_items WHERE id = ?').get(created.lastInsertRowid)
  }))

  server.registerTool('update_checklist_item', {
    description: 'Rename or complete a task checklist item.',
    inputSchema: { checklist_id: id, title: title.optional(), completed: z.boolean().optional() },
    annotations: { idempotentHint: true },
  }, tool(({ checklist_id, title, completed }) => {
    requireRow(db.prepare('SELECT 1 FROM checklist_items WHERE id = ?').get(checklist_id), 'checklist item not found')
    if (title === undefined && completed === undefined) throw new Error('title or completed is required')
    db.prepare('UPDATE checklist_items SET title = COALESCE(?, title), completed = COALESCE(?, completed) WHERE id = ?').run(title ?? null, completed === undefined ? null : Number(completed), checklist_id)
    return db.prepare('SELECT id, card_id, title, completed, position, created_at FROM checklist_items WHERE id = ?').get(checklist_id)
  }))

  server.registerTool('delete_checklist_item', {
    description: 'Delete a task checklist item.',
    inputSchema: { checklist_id: id },
    annotations: { destructiveHint: true },
  }, tool(({ checklist_id }) => {
    const deleted = db.prepare('DELETE FROM checklist_items WHERE id = ?').run(checklist_id)
    if (!deleted.changes) throw new Error('checklist item not found')
    return { ok: true }
  }))

  server.registerTool('link_records', {
    description: 'Link a task to an event or notebook.',
    inputSchema: { card_id: id, record_type: z.enum(['event', 'notebook']), record_id: id },
    annotations: { destructiveHint: false },
  }, tool(({ card_id, record_type, record_id }) => {
    requireRow(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(card_id), 'task not found')
    if (record_type === 'event') {
      requireRow(db.prepare('SELECT 1 FROM events WHERE id = ?').get(record_id), 'event not found')
      db.prepare('INSERT OR IGNORE INTO card_event_links (card_id, event_id) VALUES (?, ?)').run(card_id, record_id)
    } else {
      requireRow(db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(record_id), 'notebook not found')
      db.prepare('INSERT OR IGNORE INTO card_notebook_links (card_id, notebook_id) VALUES (?, ?)').run(card_id, record_id)
    }
    return { ok: true }
  }))

  server.registerTool('unlink_records', {
    description: 'Remove a link from a task to an event or notebook.',
    inputSchema: { card_id: id, record_type: z.enum(['event', 'notebook']), record_id: id },
    annotations: { destructiveHint: true },
  }, tool(({ card_id, record_type, record_id }) => {
    const deleted = record_type === 'event'
      ? db.prepare('DELETE FROM card_event_links WHERE card_id = ? AND event_id = ?').run(card_id, record_id)
      : db.prepare('DELETE FROM card_notebook_links WHERE card_id = ? AND notebook_id = ?').run(card_id, record_id)
    if (!deleted.changes) throw new Error('link not found')
    return { ok: true }
  }))
  server.registerTool('list_events', {
    description: 'List calendar events for a month, or upcoming deadlines. Defaults to the current month.',
    inputSchema: {
      month: month.optional().describe('Calendar month in YYYY-MM format'),
      upcoming_deadlines: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true },
  }, tool(({ month, upcoming_deadlines }) => {
    if (upcoming_deadlines) {
      return db.prepare(`${eventSelect} WHERE is_deadline = 1 AND event_date >= date('now', 'localtime') ORDER BY event_date, event_time, id LIMIT 100`).all()
    }
    const now = new Date()
    const selectedMonth = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    return db.prepare(`${eventSelect} WHERE event_date >= ? AND event_date < date(?, '+1 month') ORDER BY event_date, event_time, end_time, id LIMIT 100`).all(`${selectedMonth}-01`, `${selectedMonth}-01`)
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
  }, tool(({ title, event_date, event_time, end_time, description = '', is_deadline, color = 'blue', recurrence = 'none', recurrence_interval = 1 }) => {
    const finalEndTime = is_deadline ? event_time : end_time
    if (!finalEndTime) throw new Error('end_time is required for calendar events')
    if (!is_deadline && finalEndTime <= event_time) throw new Error('end_time must be after event_time')
    const created = db.prepare(`INSERT INTO events
      (title, description, event_date, event_time, end_time, is_deadline, color, recurrence, recurrence_interval)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(title, description, event_date, event_time, finalEndTime, Number(is_deadline), color, recurrence, recurrence_interval)
    return db.prepare(`${eventSelect} WHERE id = ?`).get(created.lastInsertRowid)
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
  }, tool(({ event_id, ...changes }) => {
    const current = requireRow(db.prepare(`${eventSelect} WHERE id = ?`).get(event_id), 'event not found')
    if (Object.values(changes).every((value) => value === undefined)) throw new Error('at least one field is required')
    const nextStart = changes.event_time ?? current.event_time
    const nextEnd = current.is_deadline ? nextStart : (changes.end_time ?? current.end_time)
    if (!current.is_deadline && nextEnd <= nextStart) throw new Error('end_time must be after event_time')
    db.prepare(`UPDATE events SET title = ?, description = ?, event_date = ?, event_time = ?, end_time = ?, color = ?, recurrence = ?, recurrence_interval = ? WHERE id = ?`).run(
      changes.title ?? current.title,
      changes.description ?? current.description,
      changes.event_date ?? current.event_date,
      nextStart,
      nextEnd,
      changes.color ?? current.color,
      changes.recurrence ?? current.recurrence,
      changes.recurrence_interval ?? current.recurrence_interval,
      event_id,
    )
    return db.prepare(`${eventSelect} WHERE id = ?`).get(event_id)
  }))

  server.registerTool('delete_event', {
    description: 'Permanently delete an event or deadline and its comments.',
    inputSchema: { event_id: id },
    annotations: { destructiveHint: true },
  }, tool(({ event_id }) => {
    const deleted = db.prepare('DELETE FROM events WHERE id = ?').run(event_id)
    if (!deleted.changes) throw new Error('event not found')
    return { ok: true }
  }))

  server.registerTool('add_event_comment', {
    description: 'Add a text comment to an event or deadline.',
    inputSchema: { event_id: id, body: z.string().trim().min(1).max(20_000) },
    annotations: { destructiveHint: false },
  }, tool(({ event_id, body }) => {
    requireRow(db.prepare('SELECT 1 FROM events WHERE id = ?').get(event_id), 'event not found')
    const created = db.prepare('INSERT INTO event_comments (event_id, body) VALUES (?, ?)').run(event_id, body)
    return db.prepare('SELECT id, body, created_at FROM event_comments WHERE id = ?').get(created.lastInsertRowid)
  }))

  server.registerTool('list_notebooks', {
    description: 'List notebook IDs and titles without loading their potentially large contents.',
    annotations: { readOnlyHint: true },
  }, tool(() => db.prepare('SELECT id, title, created_at FROM notebooks ORDER BY id DESC').all()))

  server.registerTool('get_notebook', {
    description: 'Get a notebook title and HTML content. Embedded images are omitted.',
    inputSchema: { notebook_id: id },
    annotations: { readOnlyHint: true },
  }, tool(({ notebook_id }) => requireRow(db.prepare('SELECT id, title, content, created_at FROM notebooks WHERE id = ?').get(notebook_id), 'notebook not found')))

  server.registerTool('create_notebook', {
    description: 'Create a notebook with optional HTML content.',
    inputSchema: { title, content: z.string().max(200_000).optional() },
    annotations: { destructiveHint: false },
  }, tool(({ title, content = '' }) => {
    const created = db.prepare('INSERT INTO notebooks (title, content) VALUES (?, ?)').run(title, content)
    return db.prepare('SELECT id, title, content, created_at FROM notebooks WHERE id = ?').get(created.lastInsertRowid)
  }))

  server.registerTool('update_notebook', {
    description: 'Change a notebook title or HTML content without changing embedded images.',
    inputSchema: {
      notebook_id: id,
      title: title.optional(),
      content: z.string().max(200_000).optional(),
    },
    annotations: { idempotentHint: true },
  }, tool(({ notebook_id, title, content }) => {
    requireRow(db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebook_id), 'notebook not found')
    if (title === undefined && content === undefined) throw new Error('title or content is required')
    db.prepare('UPDATE notebooks SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?').run(title ?? null, content ?? null, notebook_id)
    return db.prepare('SELECT id, title, content, created_at FROM notebooks WHERE id = ?').get(notebook_id)
  }))

  server.registerTool('delete_notebook', {
    description: 'Permanently delete a notebook.',
    inputSchema: { notebook_id: id },
    annotations: { destructiveHint: true },
  }, tool(({ notebook_id }) => {
    const deleted = db.prepare('DELETE FROM notebooks WHERE id = ?').run(notebook_id)
    if (!deleted.changes) throw new Error('notebook not found')
    return { ok: true }
  }))

  return server
}
