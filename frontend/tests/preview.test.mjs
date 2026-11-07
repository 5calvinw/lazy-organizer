import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPreviewRequest } from '../src/preview.ts'

const workspace = () => createPreviewRequest(new Date(2026, 10, 7, 12))
const json = (method, body) => ({ method, body: JSON.stringify(body) })
async function get(request, path) {
  const response = await request(path)
  assert.equal(response.status, 200)
  return response.json()
}

test('real-view fixtures are coherent, dated locally, and isolated on every reset', async () => {
  const request = workspace()
  const today = await get(request, '/api/today')
  assert.equal(today.date, '2026-11-07')
  assert.equal(today.dueToday.length, 3)
  assert.equal(today.overdue.length, 1)
  assert.equal(today.events.length, 3)
  const board = await get(request, '/api/board')
  assert.deepEqual(board.map((list) => list.title), ['To do', 'Doing', 'Waiting', 'Done'])
  const focus = board[1].cards[0]
  assert.equal(focus.checklist_count, 3)
  assert.equal(focus.checklist_completed, 1)
  await request(`/api/cards/${focus.id}`, json('PATCH', { title: 'Edited locally' }))
  assert.equal((await get(workspace(), `/api/cards/${focus.id}`)).title, focus.title)
})

test('capture, reschedule, complete and undo use the existing task contracts', async () => {
  const request = workspace()
  const created = await request('/api/today/tasks', json('POST', { title: 'A sample task', dueDate: '2026-11-07' }))
  assert.equal(created.status, 201)
  const card = await created.json()
  assert.equal((await get(request, '/api/today')).dueToday.length, 4)
  await request(`/api/cards/${card.id}/move`, json('PATCH', { listId: 4, index: 0 }))
  assert.equal((await get(request, '/api/today')).dueToday.length, 3)
  await request(`/api/cards/${card.id}/move`, json('PATCH', { listId: 1, index: 0 }))
  assert.equal((await get(request, '/api/today')).dueToday.length, 4)
  await request(`/api/cards/${card.id}`, json('PATCH', { dueDate: null }))
  assert.equal((await get(request, '/api/today')).dueToday.length, 3)
  assert.equal((await request('/api/today/tasks', json('POST', { title: '', dueDate: null }))).status, 400)
  assert.equal((await request('/api/today/tasks', json('POST', { title: 'Bad date', dueDate: 'tomorrow' }))).status, 400)
  assert.equal((await request('/api/today/tasks', json('POST', { title: 'Bad date', dueDate: '2026-02-30' }))).status, 400)
})

test('task details support checklist, comments with null file fields, attachments and deletion', async () => {
  const request = workspace()
  const board = await get(request, '/api/board')
  const id = board[1].cards[0].id
  await request(`/api/cards/${id}`, json('PATCH', { description: 'Updated notes', priority: 'low', color: 'blue' }))
  const check = await (await request(`/api/cards/${id}/checklist`, json('POST', { title: 'One step' }))).json()
  await request(`/api/checklist/${check.id}`, json('PATCH', { completed: true }))
  let detail = await get(request, `/api/cards/${id}`)
  assert.equal(detail.checklist_completed, 2)
  assert.equal(detail.description, 'Updated notes')
  const comment = await request(`/api/cards/${id}/comments`, json('POST', { body: 'A note', image: null, fileName: null, fileData: null, fileMimeType: null, fileSize: null }))
  assert.equal(comment.status, 201)
  const attachment = await (await request(`/api/cards/${id}/attachments`, json('POST', { name: 'note.txt', mimeType: 'text/plain', data: 'data:text/plain;base64,aGk=' }))).json()
  detail = await get(request, `/api/cards/${id}`)
  assert.equal(detail.attachment_count, 1)
  assert.equal(detail.comments.at(-1).body, 'A note')
  await request(`/api/attachments/${attachment.id}`, { method: 'DELETE' })
  await request(`/api/checklist/${check.id}`, { method: 'DELETE' })
  assert.equal((await get(request, `/api/cards/${id}`)).attachment_count, 0)
  await request(`/api/cards/${id}`, { method: 'DELETE' })
  assert.equal((await request(`/api/cards/${id}`)).status, 404)
  assert.equal((await get(request, '/api/board'))[1].cards.some((card) => card.id === id), false)
})

test('calendar and deadlines can be created, edited, commented on and deleted', async () => {
  const request = workspace()
  const created = await request('/api/events', json('POST', { title: 'Sample review', eventDate: '2026-11-09', eventTime: '09:00', endTime: '10:00', color: 'blue', recurrence: 'none', recurrenceInterval: 1 }))
  assert.equal(created.status, 201)
  const event = await created.json()
  await request(`/api/events/${event.id}`, json('PATCH', { eventDate: '2026-11-07', title: 'Moved review' }))
  assert.equal((await get(request, '/api/today')).events.length, 4)
  assert.equal((await get(request, '/api/events?month=2026-12')).length, 0)
  assert.equal((await request(`/api/events/${event.id}/comments`, json('POST', { body: 'Ready' }))).status, 201)
  const deadline = await request('/api/deadlines', json('POST', { title: 'A due date', eventDate: '2026-11-10', eventTime: '16:00', recurrence: 'none' }))
  assert.equal((await deadline.json()).is_deadline, 1)
  assert.equal((await get(request, '/api/deadlines')).length, 2)
  await request(`/api/events/${event.id}`, json('PATCH', { eventDate: '2026-10-31', endDate: '2026-11-08', allDay: true, eventTime: '00:00', endTime: '00:00' }))
  assert.ok((await get(request, '/api/events?month=2026-11')).some((item) => item.id === event.id))
  assert.ok((await get(request, '/api/today')).events.some((item) => item.id === event.id))
  await request(`/api/events/${event.id}`, json('PATCH', { endDate: '2026-11-07' }))
  assert.equal((await get(request, '/api/today')).events.some((item) => item.id === event.id), false)
  await request(`/api/events/${event.id}`, { method: 'DELETE' })
  assert.equal((await request(`/api/events/${event.id}`)).status, 404)
})

test('notebook editing and record backlinks share the same in-memory data', async () => {
  const request = workspace()
  const links = await get(request, '/api/notebooks/2/backlinks')
  assert.ok(links.cards.length > 0)
  assert.ok(links.events.length > 0)
  const notebook = await (await request('/api/notebooks', json('POST', { title: 'Fresh page' }))).json()
  await request(`/api/notebooks/${notebook.id}`, json('PATCH', { content: '<h2>A thought</h2>', images: [] }))
  const books = await get(request, '/api/notebooks')
  assert.equal(books.find((item) => item.id === notebook.id).content, '<h2>A thought</h2>')
  await request(`/api/notebooks/${notebook.id}`, { method: 'DELETE' })
  assert.equal((await get(request, '/api/notebooks')).length, 4)
})

test('unsupported operations, integrations, and absolute URLs never reach a network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => { calls++; throw new Error('Unexpected network') }
  try {
    const request = workspace()
    assert.equal((await request('https://example.com/api/board')).status, 403)
    assert.equal((await request('//example.com/api/board')).status, 403)
    assert.equal((await request('/api/not-implemented')).status, 404)
    assert.equal((await request('/api/integrations/google/connect', { method: 'POST' })).status, 403)
    assert.deepEqual(await get(request, '/api/integrations/google/status'), { configured: false, connected: false, lastSyncedAt: null })
    assert.equal((await request('/api/notebooks', { method: 'POST', body: 'null' })).status, 400)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /import\.meta\.env\.DEV && new URLSearchParams\(window\.location\.search\)\.get\('preview'\) === '1'/)
  assert.match(source, /previewRequest \? await \(await previewRequest\)\(url, options\) : await fetch\(url, options\)/)
})

test('invalid edits are atomic and recurrence limitations are explicit', async () => {
  const request = workspace()
  const id = (await get(request, '/api/board'))[1].cards[0].id
  const original = await get(request, `/api/cards/${id}`)
  assert.equal((await request(`/api/cards/${id}`, json('PATCH', { title: 'Do not save', color: 'invalid' }))).status, 400)
  assert.equal((await get(request, `/api/cards/${id}`)).title, original.title)
  const repeat = await request(`/api/cards/${id}`, json('PATCH', { recurrence: 'daily' }))
  assert.equal(repeat.status, 400)
  assert.match((await repeat.json()).error, /not available in the local preview/)
  const count = (await get(request, '/api/events?month=2026-11')).length
  assert.equal((await request('/api/events', json('POST', { title: 'Invalid', eventDate: 'bad' }))).status, 400)
  assert.equal((await get(request, '/api/events?month=2026-11')).length, count)
})
