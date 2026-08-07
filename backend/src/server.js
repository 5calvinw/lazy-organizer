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
`)

if (db.prepare('SELECT COUNT(*) AS count FROM lists').get().count === 0) {
  db.exec('BEGIN')
    const addList = db.prepare('INSERT INTO lists (title, position) VALUES (?, ?)')
    const addCard = db.prepare('INSERT INTO cards (list_id, title, position) VALUES (?, ?, ?)')
    const lists = [
      ['Note and question', [
        'is the employee form for creating and deleting different?',
        'its better to have the field, view and form framework standardize, later you can reuse for other view and form too',
      ]],
      ['To Do', [
        'unable to change role/account for existing user account',
        'how to give access to HR?',
        'login to normal user, can not see anything (Manager)',
      ]],
      ['Doing', []],
      ['Done (in dev staging)', []],
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
app.use(express.json())

const cardSelect = `
  SELECT c.id, c.list_id, c.title, c.description, c.created_at, l.title AS list_title
  FROM cards c JOIN lists l ON l.id = c.list_id
`

app.get('/api/health', (_request, response) => response.json({ ok: true }))

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
