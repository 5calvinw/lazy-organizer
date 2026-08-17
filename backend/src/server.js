import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createOrganizerMcpServer } from './mcp.js'

mkdirSync('data', { recursive: true })

const db = new DatabaseSync('data/organizer.db')
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL CHECK (event_date GLOB '????-??-??'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS event_comments (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notebooks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    content TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)

if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'event_time'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN event_time TEXT NOT NULL DEFAULT '09:00' CHECK (event_time GLOB '??:??')")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'end_time'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN end_time TEXT NOT NULL DEFAULT '10:00' CHECK (end_time GLOB '??:??')")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'is_deadline'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN is_deadline INTEGER NOT NULL DEFAULT 0 CHECK (is_deadline IN (0, 1))")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'color'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'color'").get()) {
  db.exec("ALTER TABLE cards ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'due_date'").get()) {
  db.exec("ALTER TABLE cards ADD COLUMN due_date TEXT")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'priority'").get()) {
  db.exec("ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'none'")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'recurrence'").get()) {
  db.exec("ALTER TABLE cards ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'recurrence_interval'").get()) {
  db.exec("ALTER TABLE cards ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'recurrence'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'recurrence_interval'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'recurrence_parent_id'").get()) {
  db.exec("ALTER TABLE events ADD COLUMN recurrence_parent_id INTEGER REFERENCES events(id) ON DELETE CASCADE")
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('comments') WHERE name = 'image'").get()) {
  db.exec(`
    BEGIN;
    CREATE TABLE comments_with_images (
      id INTEGER PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      image TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO comments_with_images (id, card_id, body, created_at) SELECT id, card_id, body, created_at FROM comments;
    DROP TABLE comments;
    ALTER TABLE comments_with_images RENAME TO comments;
    COMMIT;
  `)
}
db.exec(`
  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS card_attachments (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    mime_type TEXT NOT NULL,
    data TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS card_event_links (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS card_notebook_links (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, notebook_id)
  );

  CREATE TABLE IF NOT EXISTS event_notebook_links (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, notebook_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS event_recurrence_occurrence
    ON events(recurrence_parent_id, event_date, event_time)
    WHERE recurrence_parent_id IS NOT NULL;
`)

const organizerColors = ['blue', 'green', 'yellow', 'purple', 'orange', 'gray']
const priorities = ['none', 'low', 'medium', 'high']
const recurrences = ['none', 'daily', 'weekdays', 'weekly', 'monthly']
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/

function validDate(value) {
  if (!datePattern.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function nextOccurrence(value, recurrence, interval = 1) {
  const date = new Date(`${value}T00:00:00Z`)
  if (recurrence === 'daily') date.setUTCDate(date.getUTCDate() + interval)
  else if (recurrence === 'weekly') date.setUTCDate(date.getUTCDate() + (7 * interval))
  else if (recurrence === 'weekdays') {
    let remaining = interval
    while (remaining > 0) {
      date.setUTCDate(date.getUTCDate() + 1)
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1
    }
  } else if (recurrence === 'monthly') {
    const day = date.getUTCDate()
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + interval, 1))
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    target.setUTCDate(Math.min(day, lastDay))
    return target.toISOString().slice(0, 10)
  } else return null
  return date.toISOString().slice(0, 10)
}

function ensureRecurringEvents(endDate) {
  const roots = db.prepare("SELECT * FROM events WHERE recurrence != 'none' AND recurrence_parent_id IS NULL").all()
  const latest = db.prepare('SELECT MAX(event_date) AS event_date FROM events WHERE id = ? OR recurrence_parent_id = ?')
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events
      (title, description, event_date, event_time, end_time, is_deadline, color, recurrence, recurrence_interval, recurrence_parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 1, ?)
  `)
  for (const root of roots) {
    let occurrenceDate = latest.get(root.id, root.id).event_date
    while (occurrenceDate < endDate) {
      occurrenceDate = nextOccurrence(occurrenceDate, root.recurrence, root.recurrence_interval)
      if (!occurrenceDate || occurrenceDate > endDate) break
      insert.run(root.title, root.description, occurrenceDate, root.event_time, root.end_time, root.is_deadline, root.color, root.id)
    }
  }
}


if (db.prepare('SELECT COUNT(*) AS count FROM lists').get().count === 0) {
  db.exec('BEGIN')
    const addList = db.prepare('INSERT INTO lists (title, position) VALUES (?, ?)')
    const addCard = db.prepare('INSERT INTO cards (list_id, title, position) VALUES (?, ?, ?)')
    const lists = [
      ['Backlog', [
        'is the employee form for creating and deleting different?',
        'its better to have the field, view and form framework standardize, later you can reuse for other view and form too',
      ]],
      ['To Do', [
        'unable to change role/account for existing user account',
        'how to give access to HR?',
        'login to normal user, can not see anything (Manager)',
      ]],
      ['Doing', []],
      ['Done', []],
    ]

  try {
    lists.forEach(([title, cards], listIndex) => {
      const listId = addList.run(title, listIndex).lastInsertRowid
      cards.forEach((cardTitle, cardIndex) => addCard.run(listId, cardTitle, cardIndex))
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const app = express()
app.use(express.json({ limit: '10mb' }))

const mcpApiKey = process.env.MCP_API_KEY?.trim()
app.use('/mcp', (request, response, next) => {
  if (!mcpApiKey) return response.status(503).json({ error: 'MCP_API_KEY is not configured' })
  const supplied = Buffer.from(request.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${mcpApiKey}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.set('WWW-Authenticate', 'Bearer')
    return response.status(401).json({ error: 'invalid API key' })
  }
  next()
})

app.post('/mcp', async (request, response) => {
  const mcpServer = createOrganizerMcpServer(db)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  response.on('close', () => {
    void transport.close()
    void mcpServer.close()
  })
  try {
    await mcpServer.connect(transport)
    await transport.handleRequest(request, response, request.body)
  } catch (error) {
    console.error('MCP request failed:', error)
    if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
  }
})

app.all('/mcp', (_request, response) => response.status(405).set('Allow', 'POST').json({ error: 'method not allowed' }))

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

function cardDetail(cardId) {
  const card = db.prepare(`${cardSelect} WHERE c.id = ?`).get(cardId)
  if (!card) return null
  const comments = db.prepare('SELECT id, body, image, created_at FROM comments WHERE card_id = ? ORDER BY id DESC').all(cardId)
  const checklist = db.prepare('SELECT id, title, completed, position, created_at FROM checklist_items WHERE card_id = ? ORDER BY position, id').all(cardId)
  const attachments = db.prepare('SELECT id, name, mime_type, data, size, created_at FROM card_attachments WHERE card_id = ? ORDER BY id DESC').all(cardId)
  const events = db.prepare(`SELECT e.id, e.title, e.event_date, e.event_time, e.is_deadline
    FROM card_event_links l JOIN events e ON e.id = l.event_id WHERE l.card_id = ? ORDER BY e.event_date, e.event_time`).all(cardId)
  const notebooks = db.prepare(`SELECT n.id, n.title FROM card_notebook_links l
    JOIN notebooks n ON n.id = l.notebook_id WHERE l.card_id = ? ORDER BY n.title`).all(cardId)
  return { ...card, comments, checklist, attachments, links: { events, notebooks } }
}

function completeRecurringCard(card, destinationListId) {
  const destination = db.prepare('SELECT title FROM lists WHERE id = ?').get(destinationListId)
  const source = db.prepare('SELECT title FROM lists WHERE id = ?').get(card.list_id)
  if (destination?.title.toLocaleLowerCase() !== 'done' || source?.title.toLocaleLowerCase() === 'done' || card.recurrence === 'none') return
  const nextDueDate = nextOccurrence(card.due_date, card.recurrence, card.recurrence_interval)
  if (!nextDueDate) return
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(card.list_id).next
  const created = db.prepare(`INSERT INTO cards
    (list_id, title, description, position, color, due_date, priority, recurrence, recurrence_interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(card.list_id, card.title, card.description, position, card.color, nextDueDate, card.priority, card.recurrence, card.recurrence_interval)
  const nextId = created.lastInsertRowid
  db.prepare('UPDATE cards SET recurrence = \'none\', recurrence_interval = 1 WHERE id = ?').run(card.id)
  const addChecklist = db.prepare('INSERT INTO checklist_items (card_id, title, position) VALUES (?, ?, ?)')
  db.prepare('SELECT title, position FROM checklist_items WHERE card_id = ? ORDER BY position, id').all(card.id)
    .forEach((item) => addChecklist.run(nextId, item.title, item.position))
  db.prepare('INSERT INTO card_event_links (card_id, event_id) SELECT ?, event_id FROM card_event_links WHERE card_id = ?').run(nextId, card.id)
  db.prepare('INSERT INTO card_notebook_links (card_id, notebook_id) SELECT ?, notebook_id FROM card_notebook_links WHERE card_id = ?').run(nextId, card.id)
}

app.get('/api/health', (_request, response) => response.json({ ok: true }))

app.get('/api/notebooks', (_request, response) => {
  response.json(db.prepare('SELECT id, title, content, images, created_at FROM notebooks ORDER BY id DESC').all().map((notebook) => ({ ...notebook, images: JSON.parse(notebook.images) })))
})

app.post('/api/notebooks', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  const result = db.prepare('INSERT INTO notebooks (title) VALUES (?)').run(title)
  response.status(201).json({ ...db.prepare('SELECT id, title, content, images, created_at FROM notebooks WHERE id = ?').get(result.lastInsertRowid), images: [] })
})

app.patch('/api/notebooks/:id', (request, response) => {
  const notebook = db.prepare('SELECT id FROM notebooks WHERE id = ?').get(request.params.id)
  if (!notebook) return response.status(404).json({ error: 'notebook not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const content = typeof request.body.content === 'string' ? request.body.content : null
  const images = Array.isArray(request.body.images) && request.body.images.every((image) => typeof image === 'string' && image.startsWith('data:image/')) ? JSON.stringify(request.body.images) : null
  if (title === '') return response.status(400).json({ error: 'title is required' })
  db.prepare('UPDATE notebooks SET title = COALESCE(?, title), content = COALESCE(?, content), images = COALESCE(?, images) WHERE id = ?').run(title, content, images, notebook.id)
  const updated = db.prepare('SELECT id, title, content, images, created_at FROM notebooks WHERE id = ?').get(notebook.id)
  response.json({ ...updated, images: JSON.parse(updated.images) })
})

app.delete('/api/notebooks/:id', (request, response) => {
  const result = db.prepare('DELETE FROM notebooks WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'notebook not found' })
  response.json({ ok: true })
})
app.get('/api/notebooks/:id/backlinks', (request, response) => {
  if (!db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'notebook not found' })
  const cards = db.prepare(`SELECT c.id, c.title, l.title AS list_title FROM card_notebook_links x
    JOIN cards c ON c.id = x.card_id JOIN lists l ON l.id = c.list_id WHERE x.notebook_id = ? ORDER BY c.title`).all(request.params.id)
  const events = db.prepare(`SELECT e.id, e.title, e.event_date, e.event_time, e.is_deadline FROM event_notebook_links x
    JOIN events e ON e.id = x.event_id WHERE x.notebook_id = ? ORDER BY e.event_date, e.event_time`).all(request.params.id)
  response.json({ cards, events })
})

app.get('/api/link-options', (_request, response) => {
  ensureRecurringEvents(new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10))
  response.json({
    notebooks: db.prepare('SELECT id, title FROM notebooks ORDER BY title').all(),
    events: db.prepare(`${eventSelect} WHERE event_date >= date('now', '-30 days') ORDER BY event_date, event_time LIMIT 200`).all(),
  })
})

app.get('/api/today', (_request, response) => {
  const today = new Date().toLocaleDateString('en-CA')
  ensureRecurringEvents(today)
  const taskFields = `${cardSelect}`
  const unfinished = "lower(l.title) != 'done'"
  response.json({
    date: today,
    overdue: db.prepare(`${taskFields} WHERE c.due_date < ? AND ${unfinished} ORDER BY c.due_date, CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`).all(today),
    dueToday: db.prepare(`${taskFields} WHERE c.due_date = ? AND ${unfinished} ORDER BY CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, c.position`).all(today),
    doing: db.prepare(`${taskFields} WHERE lower(l.title) = 'doing' AND (c.due_date IS NULL OR c.due_date > ?) ORDER BY c.position`).all(today),
    events: db.prepare(`${eventSelect} WHERE event_date = ? ORDER BY event_time, end_time, id`).all(today),
  })
})
app.post('/api/today/tasks', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  const list = db.prepare("SELECT id FROM lists WHERE lower(title) = 'to do' ORDER BY position LIMIT 1").get()
    ?? db.prepare('SELECT id FROM lists ORDER BY position LIMIT 1').get()
  if (!list) return response.status(409).json({ error: 'create a task list first' })
  const dueDate = new Date().toLocaleDateString('en-CA')
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(list.id).next
  const created = db.prepare("INSERT INTO cards (list_id, title, position, color, due_date) VALUES (?, ?, ?, 'gray', ?)").run(list.id, title, position, dueDate)
  response.status(201).json(db.prepare(`${cardSelect} WHERE c.id = ?`).get(created.lastInsertRowid))
})

app.get('/api/events', (request, response) => {
  const month = typeof request.query.month === 'string' ? request.query.month : ''
  if (!/^\d{4}-\d{2}$/.test(month)) return response.status(400).json({ error: 'valid month is required' })
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthNumber - 1, 1))
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7))
  const end = new Date(first)
  end.setUTCDate(end.getUTCDate() + 42)
  const dateOnly = (date) => date.toISOString().slice(0, 10)
  ensureRecurringEvents(dateOnly(end))
  response.json(db.prepare(`${eventSelect} WHERE event_date >= ? AND event_date < ? ORDER BY event_date, event_time, end_time, id`).all(dateOnly(first), dateOnly(end)))
})

app.get('/api/deadlines', (_request, response) => {
  ensureRecurringEvents(new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10))
  response.json(db.prepare(`${eventSelect} WHERE is_deadline = 1 AND event_date >= date('now', 'localtime') ORDER BY event_date, event_time, end_time, id LIMIT 20`).all())
})

app.get('/api/events/:id', (request, response) => {
  const event = db.prepare(`${eventSelect} WHERE id = ?`).get(request.params.id)
  if (!event) return response.status(404).json({ error: 'event not found' })
  const comments = db.prepare('SELECT id, body, created_at FROM event_comments WHERE event_id = ? ORDER BY id DESC').all(event.id)
  const notebooks = db.prepare(`SELECT n.id, n.title FROM event_notebook_links l JOIN notebooks n ON n.id = l.notebook_id
    WHERE l.event_id = ? ORDER BY n.title`).all(event.id)
  response.json({ ...event, comments, notebooks })
})

app.post('/api/events', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : ''
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : ''
  const endTime = typeof request.body.endTime === 'string' ? request.body.endTime : ''
  const color = typeof request.body.color === 'string' ? request.body.color : ''
  const recurrence = typeof request.body.recurrence === 'string' ? request.body.recurrence : 'none'
  const recurrenceInterval = Number(request.body.recurrenceInterval ?? 1)
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!validDate(eventDate)) return response.status(400).json({ error: 'valid event date is required' })
  if (!timePattern.test(eventTime) || !timePattern.test(endTime)) return response.status(400).json({ error: 'valid event times are required' })
  if (endTime <= eventTime) return response.status(400).json({ error: 'end time must be after start time' })
  if (!organizerColors.includes(color)) return response.status(400).json({ error: 'valid color is required' })
  if (!recurrences.includes(recurrence) || !Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 365) return response.status(400).json({ error: 'valid recurrence is required' })
  const result = db.prepare(`INSERT INTO events (title, event_date, event_time, end_time, color, recurrence, recurrence_interval)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(title, eventDate, eventTime, endTime, color, recurrence, recurrenceInterval)
  response.status(201).json(db.prepare(`${eventSelect} WHERE id = ?`).get(result.lastInsertRowid))
})

app.post('/api/deadlines', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : ''
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : ''
  const recurrence = typeof request.body.recurrence === 'string' ? request.body.recurrence : 'none'
  const recurrenceInterval = Number(request.body.recurrenceInterval ?? 1)
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!validDate(eventDate)) return response.status(400).json({ error: 'valid deadline date is required' })
  if (!timePattern.test(eventTime)) return response.status(400).json({ error: 'valid deadline time is required' })
  if (!recurrences.includes(recurrence) || !Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 365) return response.status(400).json({ error: 'valid recurrence is required' })
  const result = db.prepare(`INSERT INTO events (title, event_date, event_time, end_time, is_deadline, recurrence, recurrence_interval)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(title, eventDate, eventTime, eventTime, recurrence, recurrenceInterval)
  response.status(201).json(db.prepare(`${eventSelect} WHERE id = ?`).get(result.lastInsertRowid))
})

app.patch('/api/events/:id', (request, response) => {
  const current = db.prepare(`${eventSelect} WHERE id = ?`).get(request.params.id)
  if (!current) return response.status(404).json({ error: 'event not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const description = typeof request.body.description === 'string' ? request.body.description.trim() : null
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : null
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : null
  const endTime = typeof request.body.endTime === 'string' ? request.body.endTime : null
  const color = typeof request.body.color === 'string' ? request.body.color : null
  const recurrence = typeof request.body.recurrence === 'string' ? request.body.recurrence : null
  const recurrenceInterval = request.body.recurrenceInterval === undefined ? null : Number(request.body.recurrenceInterval)
  if (title === '') return response.status(400).json({ error: 'title is required' })
  if (eventDate !== null && !validDate(eventDate)) return response.status(400).json({ error: 'valid event date is required' })
  if (eventTime !== null && !timePattern.test(eventTime)) return response.status(400).json({ error: 'valid start time is required' })
  if (endTime !== null && !timePattern.test(endTime)) return response.status(400).json({ error: 'valid end time is required' })
  if (color !== null && !organizerColors.includes(color)) return response.status(400).json({ error: 'valid color is required' })
  if (recurrence !== null && !recurrences.includes(recurrence)) return response.status(400).json({ error: 'valid recurrence is required' })
  if (recurrenceInterval !== null && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 365)) return response.status(400).json({ error: 'valid recurrence interval is required' })
  const nextStart = eventTime ?? current.event_time
  const nextEnd = current.is_deadline ? nextStart : (endTime ?? current.end_time)
  if (!current.is_deadline && nextStart >= nextEnd) return response.status(400).json({ error: 'end time must be after start time' })
  if (current.recurrence_parent_id === null && (eventDate !== null || eventTime !== null || endTime !== null || recurrence !== null || recurrenceInterval !== null)) {
    db.prepare('DELETE FROM events WHERE recurrence_parent_id = ?').run(current.id)
  }
  db.prepare(`UPDATE events SET title = COALESCE(?, title), description = COALESCE(?, description), event_date = COALESCE(?, event_date),
    event_time = ?, end_time = ?, color = COALESCE(?, color), recurrence = COALESCE(?, recurrence),
    recurrence_interval = COALESCE(?, recurrence_interval) WHERE id = ?`)
    .run(title, description, eventDate, nextStart, nextEnd, color, recurrence, recurrenceInterval, current.id)
  response.json(db.prepare(`${eventSelect} WHERE id = ?`).get(current.id))
})

app.delete('/api/events/:id', (request, response) => {
  const result = db.prepare('DELETE FROM events WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'event not found' })
  response.json({ ok: true })
})

app.post('/api/events/:id/comments', (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : ''
  if (!body) return response.status(400).json({ error: 'comment is required' })
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'event not found' })
  const result = db.prepare('INSERT INTO event_comments (event_id, body) VALUES (?, ?)').run(request.params.id, body)
  response.status(201).json(db.prepare('SELECT id, body, created_at FROM event_comments WHERE id = ?').get(result.lastInsertRowid))
})
app.post('/api/events/:id/notebook-links', (request, response) => {
  const notebookId = Number(request.body.notebookId)
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'event not found' })
  if (!Number.isInteger(notebookId) || !db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(notebookId)) return response.status(404).json({ error: 'notebook not found' })
  db.prepare('INSERT OR IGNORE INTO event_notebook_links (event_id, notebook_id) VALUES (?, ?)').run(request.params.id, notebookId)
  response.status(201).json({ ok: true })
})

app.delete('/api/events/:id/notebook-links/:notebookId', (request, response) => {
  const result = db.prepare('DELETE FROM event_notebook_links WHERE event_id = ? AND notebook_id = ?').run(request.params.id, request.params.notebookId)
  if (!result.changes) return response.status(404).json({ error: 'link not found' })
  response.json({ ok: true })
})

app.get('/api/board', (_request, response) => {
  const lists = db.prepare('SELECT id, title FROM lists ORDER BY position, id').all()
  const cards = db.prepare(`${cardSelect} ORDER BY c.position, c.id`).all()
  response.json(lists.map((list) => ({ ...list, cards: cards.filter((card) => card.list_id === list.id) })))
})

app.get('/api/cards/:id', (request, response) => {
  const detail = cardDetail(request.params.id)
  if (!detail) return response.status(404).json({ error: 'card not found' })
  response.json(detail)
})

app.post('/api/lists/:listId/cards', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(request.params.listId)) return response.status(404).json({ error: 'list not found' })
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(request.params.listId).next
  const result = db.prepare("INSERT INTO cards (list_id, title, position, color) VALUES (?, ?, ?, 'gray')").run(request.params.listId, title, position)
  response.status(201).json(db.prepare(`${cardSelect} WHERE c.id = ?`).get(result.lastInsertRowid))
})

app.patch('/api/cards/:id', (request, response) => {
  const current = db.prepare(`${cardSelect} WHERE c.id = ?`).get(request.params.id)
  if (!current) return response.status(404).json({ error: 'card not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const description = typeof request.body.description === 'string' ? request.body.description.trim() : null
  const color = typeof request.body.color === 'string' ? request.body.color : null
  const dueDate = request.body.dueDate === null ? null : (typeof request.body.dueDate === 'string' ? request.body.dueDate : undefined)
  const priority = typeof request.body.priority === 'string' ? request.body.priority : null
  const recurrence = typeof request.body.recurrence === 'string' ? request.body.recurrence : null
  const recurrenceInterval = request.body.recurrenceInterval === undefined ? null : Number(request.body.recurrenceInterval)
  if (title === '') return response.status(400).json({ error: 'title is required' })
  if (color !== null && !organizerColors.includes(color)) return response.status(400).json({ error: 'valid color is required' })
  if (dueDate !== undefined && dueDate !== null && !validDate(dueDate)) return response.status(400).json({ error: 'valid due date is required' })
  if (priority !== null && !priorities.includes(priority)) return response.status(400).json({ error: 'valid priority is required' })
  if (recurrence !== null && !recurrences.includes(recurrence)) return response.status(400).json({ error: 'valid recurrence is required' })
  if (recurrenceInterval !== null && (!Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 365)) return response.status(400).json({ error: 'valid recurrence interval is required' })
  const nextRecurrence = recurrence ?? current.recurrence
  const nextDueDate = dueDate === undefined ? current.due_date : dueDate
  if (nextRecurrence !== 'none' && !nextDueDate) return response.status(400).json({ error: 'recurring tasks need a due date' })
  db.prepare(`UPDATE cards SET title = COALESCE(?, title), description = COALESCE(?, description), color = COALESCE(?, color),
    due_date = ?, priority = COALESCE(?, priority), recurrence = COALESCE(?, recurrence),
    recurrence_interval = COALESCE(?, recurrence_interval) WHERE id = ?`)
    .run(title, description, color, nextDueDate, priority, recurrence, recurrenceInterval, current.id)
  response.json(db.prepare(`${cardSelect} WHERE c.id = ?`).get(current.id))
})

app.delete('/api/cards/:id', (request, response) => {
  const result = db.prepare('DELETE FROM cards WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'card not found' })
  response.json({ ok: true })
})

app.patch('/api/cards/:id/move', (request, response) => {
  const cardId = Number(request.params.id)
  const listId = Number(request.body.listId)
  const index = Number(request.body.index)
  const card = Number.isInteger(cardId) && db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId)
  if (!card) return response.status(404).json({ error: 'card not found' })
  if (!Number.isInteger(listId) || !db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId)) return response.status(404).json({ error: 'list not found' })
  if (!Number.isInteger(index) || index < 0) return response.status(400).json({ error: 'invalid position' })
  const source = db.prepare('SELECT id FROM cards WHERE list_id = ? AND id != ? ORDER BY position, id').all(card.list_id, cardId)
  const destination = card.list_id === listId ? source : db.prepare('SELECT id FROM cards WHERE list_id = ? ORDER BY position, id').all(listId)
  destination.splice(Math.min(index, destination.length), 0, { id: cardId })
  const update = db.prepare('UPDATE cards SET list_id = ?, position = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    if (card.list_id !== listId) source.forEach((item, position) => update.run(card.list_id, position, item.id))
    destination.forEach((item, position) => update.run(listId, position, item.id))
    completeRecurringCard(card, listId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  response.json({ ok: true })
})

app.post('/api/cards/:id/comments', (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : ''
  const image = typeof request.body.image === 'string' && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(request.body.image) ? request.body.image : null
  if (!body && !image) return response.status(400).json({ error: 'comment or image is required' })
  if (typeof request.body.image === 'string' && !image) return response.status(400).json({ error: 'valid image is required' })
  if (image && Buffer.byteLength(image, 'utf8') > 7_000_000) return response.status(413).json({ error: 'image must be 5 MB or smaller' })
  if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(request.params.id)) {
    return response.status(404).json({ error: 'card not found' })
  }
  const result = db.prepare('INSERT INTO comments (card_id, body, image) VALUES (?, ?, ?)').run(request.params.id, body, image)
  response.status(201).json(db.prepare('SELECT id, body, image, created_at FROM comments WHERE id = ?').get(result.lastInsertRowid))
})
app.post('/api/cards/:id/checklist', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'checklist title is required' })
  if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'card not found' })
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM checklist_items WHERE card_id = ?').get(request.params.id).next
  const created = db.prepare('INSERT INTO checklist_items (card_id, title, position) VALUES (?, ?, ?)').run(request.params.id, title, position)
  response.status(201).json(db.prepare('SELECT id, title, completed, position, created_at FROM checklist_items WHERE id = ?').get(created.lastInsertRowid))
})

app.patch('/api/checklist/:id', (request, response) => {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(request.params.id)
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const completed = typeof request.body.completed === 'boolean' ? Number(request.body.completed) : null
  if (title === '') return response.status(400).json({ error: 'checklist title is required' })
  db.prepare('UPDATE checklist_items SET title = COALESCE(?, title), completed = COALESCE(?, completed) WHERE id = ?').run(title, completed, item.id)
  response.json(db.prepare('SELECT id, title, completed, position, created_at FROM checklist_items WHERE id = ?').get(item.id))
})

app.patch('/api/checklist/:id/move', (request, response) => {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(request.params.id)
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const direction = request.body.direction
  if (direction !== 'up' && direction !== 'down') return response.status(400).json({ error: 'direction must be up or down' })
  const sibling = db.prepare(`SELECT * FROM checklist_items WHERE card_id = ? AND position ${direction === 'up' ? '<' : '>'} ? ORDER BY position ${direction === 'up' ? 'DESC' : 'ASC'}, id ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`).get(item.card_id, item.position)
  if (sibling) {
    db.exec('BEGIN')
    try {
      db.prepare('UPDATE checklist_items SET position = ? WHERE id = ?').run(sibling.position, item.id)
      db.prepare('UPDATE checklist_items SET position = ? WHERE id = ?').run(item.position, sibling.id)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  response.json({ ok: true })
})

app.post('/api/checklist/:id/convert', (request, response) => {
  const item = db.prepare('SELECT ci.*, c.list_id FROM checklist_items ci JOIN cards c ON c.id = ci.card_id WHERE ci.id = ?').get(request.params.id)
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(item.list_id).next
  const created = db.prepare("INSERT INTO cards (list_id, title, position, color) VALUES (?, ?, ?, 'gray')").run(item.list_id, item.title, position)
  db.prepare('DELETE FROM checklist_items WHERE id = ?').run(item.id)
  response.status(201).json(db.prepare(`${cardSelect} WHERE c.id = ?`).get(created.lastInsertRowid))
})

app.delete('/api/checklist/:id', (request, response) => {
  const result = db.prepare('DELETE FROM checklist_items WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'checklist item not found' })
  response.json({ ok: true })
})

app.post('/api/cards/:id/attachments', (request, response) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim().slice(0, 255) : ''
  const mimeType = typeof request.body.mimeType === 'string' ? request.body.mimeType : ''
  const data = typeof request.body.data === 'string' ? request.body.data : ''
  const match = data.match(/^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!name || !match || match[1] !== mimeType) return response.status(400).json({ error: 'valid attachment is required' })
  const size = Buffer.from(match[2], 'base64').length
  if (size > 5_000_000) return response.status(413).json({ error: 'attachment must be 5 MB or smaller' })
  if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'card not found' })
  const created = db.prepare('INSERT INTO card_attachments (card_id, name, mime_type, data, size) VALUES (?, ?, ?, ?, ?)').run(request.params.id, name, mimeType, data, size)
  response.status(201).json(db.prepare('SELECT id, name, mime_type, data, size, created_at FROM card_attachments WHERE id = ?').get(created.lastInsertRowid))
})

app.delete('/api/attachments/:id', (request, response) => {
  const result = db.prepare('DELETE FROM card_attachments WHERE id = ?').run(request.params.id)
  if (!result.changes) return response.status(404).json({ error: 'attachment not found' })
  response.json({ ok: true })
})

app.post('/api/cards/:id/links', (request, response) => {
  const targetId = Number(request.body.targetId)
  const type = request.body.type
  if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'card not found' })
  if (type === 'event') {
    if (!Number.isInteger(targetId) || !db.prepare('SELECT 1 FROM events WHERE id = ?').get(targetId)) return response.status(404).json({ error: 'event not found' })
    db.prepare('INSERT OR IGNORE INTO card_event_links (card_id, event_id) VALUES (?, ?)').run(request.params.id, targetId)
  } else if (type === 'notebook') {
    if (!Number.isInteger(targetId) || !db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(targetId)) return response.status(404).json({ error: 'notebook not found' })
    db.prepare('INSERT OR IGNORE INTO card_notebook_links (card_id, notebook_id) VALUES (?, ?)').run(request.params.id, targetId)
  } else return response.status(400).json({ error: 'link type must be event or notebook' })
  response.status(201).json({ ok: true })
})

app.delete('/api/cards/:id/links/:type/:targetId', (request, response) => {
  const table = request.params.type === 'event' ? 'card_event_links' : request.params.type === 'notebook' ? 'card_notebook_links' : null
  const column = request.params.type === 'event' ? 'event_id' : 'notebook_id'
  if (!table) return response.status(400).json({ error: 'link type must be event or notebook' })
  const result = db.prepare(`DELETE FROM ${table} WHERE card_id = ? AND ${column} = ?`).run(request.params.id, request.params.targetId)
  if (!result.changes) return response.status(404).json({ error: 'link not found' })
  response.json({ ok: true })
})

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || '127.0.0.1'
const server = app.listen(port, host, () => console.log(`API listening on http://${host}:${port}`))

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
