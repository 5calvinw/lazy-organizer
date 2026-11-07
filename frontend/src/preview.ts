import type { CardDetail, EventDetail, List, Notebook } from './App.tsx'

// ponytail: a tab-local review sandbox, not a backend emulator; reload to reset.
export function createPreviewRequest(now = new Date()) {
  const date = (offset = 0) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  }
  const created_at = `${date()} 08:00:00`
  let sequence = 100
  const lists: List[] = ['To do', 'Doing', 'Waiting', 'Done'].map((title, index) => ({ id: index + 1, title, cards: [] }))
  const cards: CardDetail[] = []
  const events: EventDetail[] = []
  const notebooks: Notebook[] = [
    { id: 1, title: 'A little room to think', content: '<h2>Make space for what matters.</h2><p>A sample notebook for ideas that are not quite tasks yet.</p><p>What deserves more attention this week? What can wait?</p><ul><li>Leave some breathing room in the calendar.</li><li>Choose a small, meaningful next step.</li><li>Keep useful references close to the work.</li></ul>', images: [], created_at },
    { id: 2, title: 'Website refresh', content: '<h2>A quieter, clearer website</h2><p>Sample project notes. Start with the words, then find the right shape for them.</p><h2>Things to explore</h2><ul><li>A more considered introduction</li><li>Fewer pages, better stories</li><li>Thoughtful typography and accessible contrast</li></ul>', images: [], created_at },
    { id: 3, title: 'Weekly reflections', content: '<h2>Pause. Notice. Begin again.</h2><p>A sample reflection template.</p><h2>What moved forward?</h2><p> </p><h2>What would make next week lighter?</h2><p> </p>', images: [], created_at },
    { id: 4, title: 'Reading & references', content: '<h2>Ideas worth returning to</h2><p>A sample collection for reading notes, useful references, and small discoveries.</p>', images: [], created_at },
  ]
  function newCard(title: string, listId = 1, dueDate: string | null = null): CardDetail {
    const list = lists.find((item) => item.id === listId)
    if (!list) throw new Error('List not found')
    const card: CardDetail = { id: ++sequence, title, list_id: list.id, list_title: list.title, description: '', color: 'gray', due_date: dueDate, priority: 'none', recurrence: 'none', recurrence_interval: 1, checklist_count: 0, checklist_completed: 0, attachment_count: 0, created_at, comments: [], checklist: [], attachments: [], links: { events: [], notebooks: [] } }
    cards.push(card)
    list.cards.push(card)
    return card
  }
  const focus = newCard('Shape the first draft of the homepage', 2, date())
  Object.assign(focus, { color: 'green', priority: 'high', description: 'Keep the introduction simple and give the work room to breathe.\n\nProject notes: $[notebook:2]\nReview: $[event:3]\n\n!checklist' })
  focus.checklist = [
    { id: 1, title: 'Outline the page structure', completed: 1, position: 0, created_at },
    { id: 2, title: 'Write the opening paragraph', completed: 0, position: 1, created_at },
    { id: 3, title: 'Choose the featured work', completed: 0, position: 2, created_at },
  ]
  focus.comments.push({ id: 1, body: 'Sample note: start with the story, then work on the layout.', image: null, created_at })
  Object.assign(newCard('Plan the week ahead', 1, date()), { color: 'blue', priority: 'medium', description: 'Choose a few things that matter. Leave room for the unexpected.\n\n$[notebook:3]' })
  Object.assign(newCard('Make time for a long walk', 1, date()), { color: 'green', description: 'A little time away from the screen.' })
  Object.assign(newCard('Sort the reference folder', 1, date(-1)), { color: 'orange', description: 'Keep the useful pieces. Let the rest go.' })
  Object.assign(newCard('Explore a simpler navigation', 2), { color: 'blue', description: 'Sketch two directions before choosing one.' })
  newCard('Collect a few visual references', 1, date(2))
  newCard('Feedback on the first draft', 3, date(3))
  newCard('Confirm the review time', 3)
  Object.assign(newCard('Gather the project notes', 4), { color: 'green' })
  function newEvent(title: string, offset: number, eventTime: string, endTime: string, color: EventDetail['color'] = 'green', deadline = 0): EventDetail {
    const item: EventDetail = { id: events.length + 1, title, description: 'Sample event. Change the details to explore the editor.\n\n$[notebook:2]', event_date: date(offset), event_time: eventTime, end_time: endTime, end_date: null, all_day: false, time_zone: null, is_deadline: deadline, color, recurrence: 'none', recurrence_interval: 1, recurrence_parent_id: null, created_at, comments: [], notebooks: [] }
    events.push(item)
    return item
  }
  newEvent('A little planning time', 0, '09:00', '09:30')
  newEvent('Uninterrupted work', 0, '10:00', '11:30', 'blue')
  newEvent('Review the first draft', 0, '14:00', '14:45', 'orange')
  newEvent('Project check-in', 2, '10:00', '10:30', 'blue')
  newEvent('First draft ready', 3, '16:00', '16:01', 'orange', 1)
  newEvent('Weekly reflection', 6, '16:00', '16:30')
  newEvent('Collect new ideas', -3, '11:00', '12:00', 'yellow')
  newEvent('A fresh perspective', 9, '09:00', '10:00')

  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  function board() {
    for (const card of cards) {
      card.checklist_count = card.checklist.length
      card.checklist_completed = card.checklist.filter((item) => item.completed).length
      card.attachment_count = card.attachments.length
    }
    return lists
  }
  function bodyOf(options?: RequestInit): Record<string, unknown> {
    if (!options?.body) return {}
    if (typeof options.body !== 'string') throw new Error('Expected a JSON body')
    const body: unknown = JSON.parse(options.body)
    if (!isRecord(body)) throw new Error('Expected an object')
    return body
  }
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
  function text(body: Record<string, unknown>, key: string, fallback = '') {
    const value = body[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string') throw new Error(`${key} must be text`)
    return value
  }
  function title(body: Record<string, unknown>) {
    const value = text(body, 'title').trim()
    if (!value) throw new Error('A title is required')
    return value
  }
  function validDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }
  function occursOn(item: EventDetail, day: string) {
    return item.event_date === day || item.event_date < day && item.end_date !== null && (item.end_date > day || item.end_date === day && !item.all_day && item.end_time > '00:00')
  }
  function patchRecord(target: CardDetail | EventDetail | Notebook, body: Record<string, unknown>) {
    const mapping: Record<string, string> = { dueDate: 'due_date', eventDate: 'event_date', eventTime: 'event_time', endTime: 'end_time', endDate: 'end_date', allDay: 'all_day', timeZone: 'time_zone', recurrenceInterval: 'recurrence_interval' }
    for (const [key, value] of Object.entries(body)) {
      const field = mapping[key] ?? key
      if (!(field in target) || ['id', 'created_at', 'comments', 'checklist', 'attachments', 'links'].includes(field)) continue
      if (key === 'title') title(body)
      if (['dueDate', 'eventDate', 'endDate'].includes(key) && value !== null && !validDate(value)) throw new Error('A valid date is required')
      if (['eventTime', 'endTime'].includes(key) && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Error('A valid time is required')
      if (key === 'recurrenceInterval' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365)) throw new Error('Repeat interval must be between 1 and 365')
      if (key === 'color' && !['blue', 'green', 'yellow', 'purple', 'orange', 'gray'].includes(String(value))) throw new Error('Invalid color')
      if (key === 'priority' && !['none', 'low', 'medium', 'high'].includes(String(value))) throw new Error('Invalid priority')
      if (key === 'timeZone' && value !== null && typeof value !== 'string') throw new Error('Invalid time zone')
      if (key === 'images' && (!Array.isArray(value) || !value.every((image: unknown) => typeof image === 'string' && image.startsWith('data:image/')))) throw new Error('Invalid notebook images')
      if (key === 'recurrence' && value !== 'none') throw new Error('Recurring generation is not available in the local preview.')
      const current: unknown = Reflect.get(target, field)
      if (value !== null && current !== null && typeof value !== typeof current) throw new Error(`Invalid ${key}`)
    }
    for (const [key, value] of Object.entries(body)) {
      const field = mapping[key] ?? key
      if (field in target && !['id', 'created_at', 'comments', 'checklist', 'attachments', 'links'].includes(field)) Reflect.set(target, field, value)
    }
  }
  return async function previewRequest(input: string, options?: RequestInit): Promise<Response> {
    try {
      const url = new URL(input, 'http://preview.local')
      if (url.origin !== 'http://preview.local' || !url.pathname.startsWith('/api/')) return response({ error: 'Network access is disabled in the local preview.' }, 403)
      const path = url.pathname.split('/').filter(Boolean)
      const [, resource, idText, action] = path
      const id = Number(idText)
      const method = options?.method ?? 'GET'
      const body = bodyOf(options)
      board()
      if (resource === 'board' && method === 'GET') return response(board())
      if (resource === 'link-options' && method === 'GET') return response({ events, notebooks })
      if (resource === 'integrations') return method === 'GET' && action === 'status'
        ? response({ configured: false, connected: false, lastSyncedAt: null })
        : response({ error: 'External integrations are disabled in the local preview.' }, 403)
      if (resource === 'today') {
        if (method === 'POST' && idText === 'tasks') {
          const dueDate = body.dueDate
          if (dueDate !== null && !validDate(dueDate)) throw new Error('A valid due date is required')
          return response(newCard(title(body), 1, dueDate), 201)
        }
        if (method === 'GET') {
          const pending = cards.filter((card) => card.list_id !== 4)
          return response({ date: date(), overdue: pending.filter((card) => card.due_date && card.due_date < date()), dueToday: pending.filter((card) => card.due_date === date()), doing: pending.filter((card) => card.list_id === 2 && (!card.due_date || card.due_date > date())), events: events.filter((item) => occursOn(item, date())).sort((a, b) => a.event_time.localeCompare(b.event_time)) })
        }
      }
      if (resource === 'lists' && method === 'POST' && action === 'cards') return response(newCard(title(body), id), 201)
      if (resource === 'cards' || resource === 'events' || resource === 'notebooks' || resource === 'deadlines') {
        const collection = resource === 'cards' ? cards : resource === 'notebooks' ? notebooks : events
        if (!idText) {
          if (method === 'GET') {
            const month = url.searchParams.get('month')
            return response(resource === 'deadlines' ? events.filter((item) => item.is_deadline).sort((a, b) => a.event_date.localeCompare(b.event_date)) : resource === 'events' && month ? events.filter((item) => item.event_date.startsWith(month) || occursOn(item, `${month}-01`)) : collection)
          }
          if (method === 'POST' && resource === 'notebooks') {
            const item: Notebook = { id: ++sequence, title: title(body), content: '', images: [], created_at }
            notebooks.push(item)
            return response(item, 201)
          }
          if (method === 'POST' && (resource === 'events' || resource === 'deadlines')) {
            if (body.recurrence && body.recurrence !== 'none') throw new Error('Recurring generation is not available in the local preview.')
            const item = newEvent(title(body), 0, text(body, 'eventTime', '09:00'), text(body, 'endTime', '10:00'), 'green', Number(resource === 'deadlines'))
            item.id = ++sequence
            try { patchRecord(item, body) } catch (cause) { events.pop(); throw cause }
            return response(item, 201)
          }
        }
        const item = collection.find((entry) => entry.id === id)
        if (!item) return response({ error: 'This sample record no longer exists.' }, 404)
        if (action === 'backlinks' && method === 'GET') return response({ cards: cards.filter((card) => card.description.includes(`$[notebook:${id}]`)), events: events.filter((event) => event.description.includes(`$[notebook:${id}]`)) })
        if (action === 'move' && method === 'PATCH' && 'list_id' in item) {
          const destination = lists.find((list) => list.id === body.listId)
          if (!destination || typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) throw new Error('Invalid task destination')
          if (item.recurrence !== 'none') throw new Error('Recurring generation is not available in the local preview.')
          lists.forEach((list) => { list.cards = list.cards.filter((card) => card.id !== id) })
          item.list_id = destination.id
          item.list_title = destination.title
          destination.cards.splice(Math.min(body.index, destination.cards.length), 0, item)
          return response(item)
        }
        if (action === 'comments' && method === 'POST' && 'comments' in item) {
          item.comments.push({ id: ++sequence, body: text(body, 'body'), image: typeof body.image === 'string' ? body.image : null, file_name: text(body, 'fileName'), file_mime_type: text(body, 'fileMimeType'), file_data: text(body, 'fileData'), file_size: typeof body.fileSize === 'number' ? body.fileSize : null, created_at })
          return response(item.comments.at(-1), 201)
        }
        if (action === 'checklist' && method === 'POST' && 'checklist' in item) {
          item.checklist.push({ id: ++sequence, title: title(body), completed: 0, position: item.checklist.length, created_at })
          return response(item.checklist.at(-1), 201)
        }
        if (action === 'attachments' && method === 'POST' && 'attachments' in item) {
          const data = text(body, 'data')
          if (!data.startsWith('data:') || data.length > 7_000_000) throw new Error('Invalid sample attachment')
          item.attachments.push({ id: ++sequence, name: text(body, 'name'), mime_type: text(body, 'mimeType'), data, size: Math.floor(data.length * 0.75), created_at })
          return response(item.attachments.at(-1), 201)
        }
        if (!action && method === 'GET') return response(item)
        if (!action && method === 'PATCH') { patchRecord(item, body); return response(item) }
        if (!action && method === 'DELETE') {
          collection.splice(collection.findIndex((entry) => entry.id === id), 1)
          if (resource === 'cards') lists.forEach((list) => { list.cards = list.cards.filter((card) => card.id !== id) })
          return response({ ok: true })
        }
      }
      if (resource === 'checklist' || resource === 'attachments') {
        for (const card of cards) {
          const items = resource === 'checklist' ? card.checklist : card.attachments
          const index = items.findIndex((item) => item.id === id)
          if (index < 0) continue
          if (method === 'DELETE') { items.splice(index, 1); return response({ ok: true }) }
          if (method === 'PATCH' && resource === 'checklist') {
            const item = card.checklist[index]
            if ('title' in body) item.title = title(body)
            if (typeof body.completed === 'boolean') item.completed = Number(body.completed)
            return response(item)
          }
        }
      }
      return response({ error: 'This operation is not available in the local preview. No network request was made.' }, 404)
    } catch (cause) {
      return response({ error: cause instanceof Error ? cause.message : 'Invalid preview request' }, 400)
    }
  }
}
