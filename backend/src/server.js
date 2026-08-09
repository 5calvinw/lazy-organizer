import express from 'express'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

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

const cardSelect = `
  SELECT c.id, c.list_id, c.title, c.description, c.created_at, l.title AS list_title
  FROM cards c JOIN lists l ON l.id = c.list_id
`

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

app.get('/api/events', (request, response) => {
  const month = typeof request.query.month === 'string' ? request.query.month : ''
  if (!/^\d{4}-\d{2}$/.test(month)) return response.status(400).json({ error: 'valid month is required' })
  response.json(db.prepare(`
    SELECT id, title, description, event_date, event_time, end_time, is_deadline, created_at
    FROM events WHERE event_date >= ? AND event_date < date(?, '+1 month')
    ORDER BY event_date, event_time, end_time, id
  `).all(`${month}-01`, `${month}-01`))
})

app.get('/api/deadlines', (_request, response) => {
  response.json(db.prepare(`
    SELECT id, title, description, event_date, event_time, end_time, is_deadline, created_at
    FROM events WHERE is_deadline = 1 AND event_date >= date('now', 'localtime')
    ORDER BY event_date, event_time, end_time, id
    LIMIT 20
  `).all())
})

app.get('/api/events/:id', (request, response) => {
  const event = db.prepare('SELECT id, title, description, event_date, event_time, end_time, is_deadline, created_at FROM events WHERE id = ?').get(request.params.id)
  if (!event) return response.status(404).json({ error: 'event not found' })
  const comments = db.prepare('SELECT id, body, created_at FROM event_comments WHERE event_id = ? ORDER BY id DESC').all(event.id)
  response.json({ ...event, comments })
})

app.post('/api/events', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : ''
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : ''
  const endTime = typeof request.body.endTime === 'string' ? request.body.endTime : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`))) {
    return response.status(400).json({ error: 'valid event date is required' })
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) return response.status(400).json({ error: 'valid event times are required' })
  if (endTime <= eventTime) return response.status(400).json({ error: 'end time must be after start time' })
  const result = db.prepare('INSERT INTO events (title, event_date, event_time, end_time) VALUES (?, ?, ?, ?)').run(title, eventDate, eventTime, endTime)
  response.status(201).json(db.prepare('SELECT id, title, description, event_date, event_time, end_time, created_at FROM events WHERE id = ?').get(result.lastInsertRowid))
})

app.post('/api/deadlines', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : ''
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`))) return response.status(400).json({ error: 'valid deadline date is required' })
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime)) return response.status(400).json({ error: 'valid deadline time is required' })
  const result = db.prepare('INSERT INTO events (title, event_date, event_time, end_time, is_deadline) VALUES (?, ?, ?, ?, 1)').run(title, eventDate, eventTime, eventTime)
  response.status(201).json(db.prepare('SELECT id, title, description, event_date, event_time, end_time, is_deadline, created_at FROM events WHERE id = ?').get(result.lastInsertRowid))
})

app.patch('/api/events/:id', (request, response) => {
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(request.params.id)
  if (!event) return response.status(404).json({ error: 'event not found' })
  const description = typeof request.body.description === 'string' ? request.body.description.trim() : null
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : null
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : null
  const endTime = typeof request.body.endTime === 'string' ? request.body.endTime : null
  if (eventDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return response.status(400).json({ error: 'valid event date is required' })
  if (eventTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime)) return response.status(400).json({ error: 'valid start time is required' })
  if (endTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) return response.status(400).json({ error: 'valid end time is required' })
  const currentTimes = db.prepare('SELECT event_time, end_time FROM events WHERE id = ?').get(event.id)
  if ((eventTime ?? currentTimes.event_time) >= (endTime ?? currentTimes.end_time)) return response.status(400).json({ error: 'end time must be after start time' })
  db.prepare('UPDATE events SET description = COALESCE(?, description), event_date = COALESCE(?, event_date), event_time = COALESCE(?, event_time), end_time = COALESCE(?, end_time) WHERE id = ?').run(description, eventDate, eventTime, endTime, event.id)
  response.json(db.prepare('SELECT id, title, description, event_date, event_time, end_time, is_deadline, created_at FROM events WHERE id = ?').get(event.id))
})

app.post('/api/events/:id/comments', (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : ''
  if (!body) return response.status(400).json({ error: 'comment is required' })
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(request.params.id)) return response.status(404).json({ error: 'event not found' })
  const result = db.prepare('INSERT INTO event_comments (event_id, body) VALUES (?, ?)').run(request.params.id, body)
  response.status(201).json(db.prepare('SELECT id, body, created_at FROM event_comments WHERE id = ?').get(result.lastInsertRowid))
})

app.get('/api/board', (_request, response) => {
  const lists = db.prepare('SELECT id, title FROM lists ORDER BY position, id').all()
  const cards = db.prepare('SELECT id, list_id, title, description, created_at FROM cards ORDER BY position, id').all()
  response.json(lists.map((list) => ({ ...list, cards: cards.filter((card) => card.list_id === list.id) })))
})

app.get('/api/cards/:id', (request, response) => {
  const card = db.prepare(`${cardSelect} WHERE c.id = ?`).get(request.params.id)
  if (!card) return response.status(404).json({ error: 'card not found' })
  const comments = db.prepare('SELECT id, body, created_at FROM comments WHERE card_id = ? ORDER BY id DESC').all(card.id)
  response.json({ ...card, comments })
})

app.post('/api/lists/:listId/cards', (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(request.params.listId)) {
    return response.status(404).json({ error: 'list not found' })
  }
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM cards WHERE list_id = ?').get(request.params.listId).next
  const result = db.prepare('INSERT INTO cards (list_id, title, position) VALUES (?, ?, ?)').run(request.params.listId, title, position)
  response.status(201).json(db.prepare('SELECT id, list_id, title, description, created_at FROM cards WHERE id = ?').get(result.lastInsertRowid))
})

app.patch('/api/cards/:id', (request, response) => {
  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(request.params.id)
  if (!card) return response.status(404).json({ error: 'card not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const description = typeof request.body.description === 'string' ? request.body.description.trim() : null
  if (title === '') return response.status(400).json({ error: 'title is required' })
  db.prepare('UPDATE cards SET title = COALESCE(?, title), description = COALESCE(?, description) WHERE id = ?').run(title, description, card.id)
  response.json(db.prepare(`${cardSelect} WHERE c.id = ?`).get(card.id))
})

app.patch('/api/cards/:id/move', (request, response) => {
  const cardId = Number(request.params.id)
  const listId = Number(request.body.listId)
  const index = Number(request.body.index)
  const card = Number.isInteger(cardId) && db.prepare('SELECT id, list_id FROM cards WHERE id = ?').get(cardId)
  if (!card) return response.status(404).json({ error: 'card not found' })
  if (!Number.isInteger(listId) || !db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId)) {
    return response.status(404).json({ error: 'list not found' })
  }
  if (!Number.isInteger(index) || index < 0) return response.status(400).json({ error: 'invalid position' })

  const source = db.prepare('SELECT id FROM cards WHERE list_id = ? AND id != ? ORDER BY position, id').all(card.list_id, cardId)
  const destination = card.list_id === listId
    ? source
    : db.prepare('SELECT id FROM cards WHERE list_id = ? ORDER BY position, id').all(listId)
  destination.splice(Math.min(index, destination.length), 0, { id: cardId })

  const update = db.prepare('UPDATE cards SET list_id = ?, position = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    if (card.list_id !== listId) source.forEach((item, position) => update.run(card.list_id, position, item.id))
    destination.forEach((item, position) => update.run(listId, position, item.id))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  response.json({ ok: true })
})

app.post('/api/cards/:id/comments', (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : ''
  if (!body) return response.status(400).json({ error: 'comment is required' })
  if (!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(request.params.id)) {
    return response.status(404).json({ error: 'card not found' })
  }
  const result = db.prepare('INSERT INTO comments (card_id, body) VALUES (?, ?)').run(request.params.id, body)
  response.status(201).json(db.prepare('SELECT id, body, created_at FROM comments WHERE id = ?').get(result.lastInsertRowid))
})

const port = Number(process.env.PORT) || 3000
const server = app.listen(port, () => console.log(`API listening on http://localhost:${port}`))

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
