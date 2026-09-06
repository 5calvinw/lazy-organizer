import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createOrganizerMcpServer } from './mcp.js'
import {
  attachmentJson,
  cardInclude,
  cardJson,
  checklistJson,
  commentJson,
  ensureRecurringEvents,
  eventJson,
  getCardSummary,
  moveCard,
  nextCardPosition,
  nextChecklistPosition,
  notebookJson,
  prisma,
  syncCardDeadline,
} from './store.js'

const organizerColors = ['blue', 'green', 'yellow', 'purple', 'orange', 'gray']
const priorities = ['none', 'low', 'medium', 'high']
const recurrences = ['none', 'daily', 'weekdays', 'weekly', 'monthly']
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
const idFrom = (value) => Number(value)

function validDate(value) {
  if (!datePattern.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

async function seedDefaultBoard() {
  await prisma.$transaction(async (tx) => {
    if (await tx.list.count()) return
    const defaults = [
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
    for (const [title, cards] of defaults) {
      await tx.list.create({
        data: {
          title,
          position: defaults.findIndex(([candidate]) => candidate === title),
          cards: { create: cards.map((cardTitle, position) => ({ title: cardTitle, position })) },
        },
      })
    }
  })
}

async function cardDetail(cardId) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: {
      ...cardInclude,
      comments: { orderBy: { id: 'desc' } },
      checklist: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      attachments: { orderBy: { id: 'desc' } },
      eventLinks: {
        orderBy: [{ event: { eventDate: 'asc' } }, { event: { eventTime: 'asc' } }],
        include: { event: { select: { id: true, title: true, eventDate: true, eventTime: true, isDeadline: true } } },
      },
      notebookLinks: {
        orderBy: { notebook: { title: 'asc' } },
        include: { notebook: { select: { id: true, title: true } } },
      },
    },
  })
  if (!card) return null
  const comments = card.comments.map(commentJson)
  const checklist = card.checklist.map((item) => checklistJson(item))
  const attachments = card.attachments.map((item) => attachmentJson(item))
  const events = card.eventLinks.map(({ event }) => ({
    id: event.id,
    title: event.title,
    event_date: event.eventDate,
    event_time: event.eventTime,
    is_deadline: event.isDeadline,
  }))
  const notebooks = card.notebookLinks.map(({ notebook }) => notebook)
  const mentioned = new Set(Array.from(card.description.matchAll(/\$\[(event|notebook):(\d+)\]/g), (match) => `${match[1]}:${match[2]}`))
  const inheritedMentions = [
    ...notebooks.filter((item) => !mentioned.has(`notebook:${item.id}`)).map((item) => `$[notebook:${item.id}]`),
    ...events.filter((item) => !(item.is_deadline && item.event_date === card.dueDate) && !mentioned.has(`event:${item.id}`)).map((item) => `$[event:${item.id}]`),
    ...(checklist.length && !/^!checklist$/m.test(card.description) ? ['!checklist'] : []),
  ]
  const description = [card.description, ...inheritedMentions].filter(Boolean).join(card.description ? '\n' : '')
  return { ...cardJson(card), description, comments, checklist, attachments, links: { events, notebooks } }
}

async function syncCardDescriptionLinks(tx, cardId, description, dueDate) {
  const mentions = Array.from(description.matchAll(/\$\[(event|notebook):(\d+)\]/g))
  const eventIds = [...new Set(mentions.filter((match) => match[1] === 'event').map((match) => Number(match[2])))]
  const notebookIds = [...new Set(mentions.filter((match) => match[1] === 'notebook').map((match) => Number(match[2])))]
  const [events, notebooks] = await Promise.all([
    tx.event.findMany({ where: { id: { in: eventIds } }, select: { id: true } }),
    tx.notebook.findMany({ where: { id: { in: notebookIds } }, select: { id: true } }),
  ])
  await Promise.all([
    ...events.map(({ id }) => tx.cardEventLink.upsert({ where: { cardId_eventId: { cardId, eventId: id } }, update: {}, create: { cardId, eventId: id } })),
    ...notebooks.map(({ id }) => tx.cardNotebookLink.upsert({ where: { cardId_notebookId: { cardId, notebookId: id } }, update: {}, create: { cardId, notebookId: id } })),
  ])
  await Promise.all([
    tx.cardEventLink.deleteMany({
      where: {
        cardId,
        eventId: { notIn: eventIds },
        ...(dueDate !== null && { event: { NOT: { isDeadline: 1, eventDate: dueDate } } }),
      },
    }),
    tx.cardNotebookLink.deleteMany({ where: { cardId, notebookId: { notIn: notebookIds } } }),
  ])
}

await seedDefaultBoard()

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
  const mcpServer = createOrganizerMcpServer(prisma)
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

app.get('/api/health', (_request, response) => response.json({ ok: true }))

app.get('/api/notebooks', async (_request, response) => {
  const notebooks = await prisma.notebook.findMany({ orderBy: { id: 'desc' } })
  response.json(notebooks.map((notebook) => notebookJson(notebook)))
})

app.post('/api/notebooks', async (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  const notebook = await prisma.notebook.create({ data: { title } })
  response.status(201).json(notebookJson(notebook))
})

app.patch('/api/notebooks/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const notebook = Number.isInteger(id) && await prisma.notebook.findUnique({ where: { id }, select: { id: true } })
  if (!notebook) return response.status(404).json({ error: 'notebook not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const content = typeof request.body.content === 'string' ? request.body.content : null
  const images = Array.isArray(request.body.images) && request.body.images.every((image) => typeof image === 'string' && image.startsWith('data:image/')) ? JSON.stringify(request.body.images) : null
  if (title === '') return response.status(400).json({ error: 'title is required' })
  const updated = await prisma.notebook.update({
    where: { id },
    data: { ...(title !== null && { title }), ...(content !== null && { content }), ...(images !== null && { images }) },
  })
  response.json(notebookJson(updated))
})

app.delete('/api/notebooks/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const result = Number.isInteger(id) ? await prisma.notebook.deleteMany({ where: { id } }) : { count: 0 }
  if (!result.count) return response.status(404).json({ error: 'notebook not found' })
  response.json({ ok: true })
})

app.get('/api/notebooks/:id/backlinks', async (request, response) => {
  const id = idFrom(request.params.id)
  const notebook = Number.isInteger(id) && await prisma.notebook.findUnique({
    where: { id },
    select: {
      cardLinks: { orderBy: { card: { title: 'asc' } }, select: { card: { select: { id: true, title: true, list: { select: { title: true } } } } } },
      eventLinks: { orderBy: [{ event: { eventDate: 'asc' } }, { event: { eventTime: 'asc' } }], select: { event: true } },
    },
  })
  if (!notebook) return response.status(404).json({ error: 'notebook not found' })
  response.json({
    cards: notebook.cardLinks.map(({ card }) => ({ id: card.id, title: card.title, list_title: card.list.title })),
    events: notebook.eventLinks.map(({ event }) => ({ id: event.id, title: event.title, event_date: event.eventDate, event_time: event.eventTime, is_deadline: event.isDeadline })),
  })
})

app.get('/api/link-options', async (_request, response) => {
  await ensureRecurringEvents(new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10))
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const [notebooks, events] = await Promise.all([
    prisma.notebook.findMany({ orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.event.findMany({ where: { eventDate: { gte: cutoff } }, orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }], take: 200 }),
  ])
  response.json({ notebooks, events: events.map(eventJson) })
})

app.get('/api/today', async (_request, response) => {
  const today = new Date().toLocaleDateString('en-CA')
  await ensureRecurringEvents(today)
  const include = cardInclude
  const priorityOrder = { high: 0, medium: 1, low: 2, none: 3 }
  const lists = await prisma.list.findMany({ select: { id: true, title: true } })
  const doneListIds = lists.filter(({ title }) => title.toLocaleLowerCase() === 'done').map(({ id }) => id)
  const doingListIds = lists.filter(({ title }) => title.toLocaleLowerCase() === 'doing').map(({ id }) => id)
  const [overdue, dueToday, doing, events] = await Promise.all([
    prisma.card.findMany({ where: { dueDate: { lt: today }, listId: { notIn: doneListIds } }, include }),
    prisma.card.findMany({ where: { dueDate: today, listId: { notIn: doneListIds } }, include }),
    prisma.card.findMany({ where: { listId: { in: doingListIds }, OR: [{ dueDate: null }, { dueDate: { gt: today } }] }, orderBy: { position: 'asc' }, include }),
    prisma.event.findMany({ where: { eventDate: today }, orderBy: [{ eventTime: 'asc' }, { endTime: 'asc' }, { id: 'asc' }] }),
  ])
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || priorityOrder[a.priority] - priorityOrder[b.priority])
  dueToday.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.position - b.position)
  response.json({ date: today, overdue: overdue.map(cardJson), dueToday: dueToday.map(cardJson), doing: doing.map(cardJson), events: events.map(eventJson) })
})

app.post('/api/today/tasks', async (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  const dueDate = request.body.dueDate === undefined ? new Date().toLocaleDateString('en-CA') : request.body.dueDate
  if (dueDate !== null && (typeof dueDate !== 'string' || !validDate(dueDate))) return response.status(400).json({ error: 'valid due date is required' })
  const lists = await prisma.list.findMany({ orderBy: { position: 'asc' }, select: { id: true, title: true } })
  const list = lists.find(({ title }) => title.toLocaleLowerCase() === 'to do') ?? lists[0]
  if (!list) return response.status(409).json({ error: 'create a task list first' })
  const card = await prisma.card.create({ data: { listId: list.id, title, position: await nextCardPosition(prisma, list.id), color: 'gray', dueDate }, include: cardInclude })
  response.status(201).json(cardJson(card))
})

app.get('/api/events', async (request, response) => {
  const month = typeof request.query.month === 'string' ? request.query.month : ''
  if (!/^\d{4}-\d{2}$/.test(month)) return response.status(400).json({ error: 'valid month is required' })
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthNumber - 1, 1))
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7))
  const end = new Date(first)
  end.setUTCDate(end.getUTCDate() + 42)
  const startDate = first.toISOString().slice(0, 10)
  const endDate = end.toISOString().slice(0, 10)
  await ensureRecurringEvents(endDate)
  const events = await prisma.event.findMany({ where: { eventDate: { gte: startDate, lt: endDate } }, orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }, { endTime: 'asc' }, { id: 'asc' }] })
  response.json(events.map(eventJson))
})

app.get('/api/deadlines', async (_request, response) => {
  await ensureRecurringEvents(new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10))
  const events = await prisma.event.findMany({ where: { isDeadline: 1, eventDate: { gte: new Date().toLocaleDateString('en-CA') } }, orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }, { endTime: 'asc' }, { id: 'asc' }], take: 20 })
  response.json(events.map(eventJson))
})

app.get('/api/events/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const event = Number.isInteger(id) && await prisma.event.findUnique({
    where: { id },
    include: {
      comments: { orderBy: { id: 'desc' } },
      notebookLinks: { orderBy: { notebook: { title: 'asc' } }, select: { notebook: { select: { id: true, title: true } } } },
    },
  })
  if (!event) return response.status(404).json({ error: 'event not found' })
  response.json({ ...eventJson(event), comments: event.comments.map(commentJson), notebooks: event.notebookLinks.map(({ notebook }) => notebook) })
})

app.post('/api/events', async (request, response) => {
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
  const event = await prisma.event.create({ data: { title, eventDate, eventTime, endTime, color, recurrence, recurrenceInterval } })
  response.status(201).json(eventJson(event))
})

app.post('/api/deadlines', async (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  const eventDate = typeof request.body.eventDate === 'string' ? request.body.eventDate : ''
  const eventTime = typeof request.body.eventTime === 'string' ? request.body.eventTime : ''
  const recurrence = typeof request.body.recurrence === 'string' ? request.body.recurrence : 'none'
  const recurrenceInterval = Number(request.body.recurrenceInterval ?? 1)
  if (!title) return response.status(400).json({ error: 'title is required' })
  if (!validDate(eventDate)) return response.status(400).json({ error: 'valid deadline date is required' })
  if (!timePattern.test(eventTime)) return response.status(400).json({ error: 'valid deadline time is required' })
  if (!recurrences.includes(recurrence) || !Number.isInteger(recurrenceInterval) || recurrenceInterval < 1 || recurrenceInterval > 365) return response.status(400).json({ error: 'valid recurrence is required' })
  const event = await prisma.event.create({ data: { title, eventDate, eventTime, endTime: eventTime, isDeadline: 1, recurrence, recurrenceInterval } })
  response.status(201).json(eventJson(event))
})

app.patch('/api/events/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const current = Number.isInteger(id) && await prisma.event.findUnique({ where: { id } })
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
  const nextStart = eventTime ?? current.eventTime
  const nextEnd = current.isDeadline ? nextStart : (endTime ?? current.endTime)
  if (!current.isDeadline && nextStart >= nextEnd) return response.status(400).json({ error: 'end time must be after start time' })
  const updated = await prisma.$transaction(async (tx) => {
    if (current.recurrenceParentId === null && (eventDate !== null || eventTime !== null || endTime !== null || recurrence !== null || recurrenceInterval !== null)) {
      await tx.event.deleteMany({ where: { recurrenceParentId: current.id } })
    }
    return tx.event.update({
      where: { id },
      data: {
        ...(title !== null && { title }),
        ...(description !== null && { description }),
        ...(eventDate !== null && { eventDate }),
        eventTime: nextStart,
        endTime: nextEnd,
        ...(color !== null && { color }),
        ...(recurrence !== null && { recurrence }),
        ...(recurrenceInterval !== null && { recurrenceInterval }),
      },
    })
  })
  response.json(eventJson(updated))
})

app.delete('/api/events/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const result = Number.isInteger(id) ? await prisma.event.deleteMany({ where: { id } }) : { count: 0 }
  if (!result.count) return response.status(404).json({ error: 'event not found' })
  response.json({ ok: true })
})

function commentInput(request) {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : ''
  const image = typeof request.body.image === 'string' && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(request.body.image) ? request.body.image : null
  const fileName = typeof request.body.fileName === 'string' ? request.body.fileName.replace(/[\\/\r\n]/g, ' ').trim().slice(0, 255) : null
  const fileMimeType = typeof request.body.fileMimeType === 'string' ? request.body.fileMimeType.trim().slice(0, 255) : null
  const fileData = typeof request.body.fileData === 'string' && /^data:[^;]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(request.body.fileData) ? request.body.fileData : null
  const fileSize = request.body.fileSize === undefined || request.body.fileSize === null ? null : Number(request.body.fileSize)
  return { body, image, fileName, fileMimeType, fileData, fileSize }
}

function validateComment(request, response, input) {
  const hasFileFields = [request.body.fileName, request.body.fileMimeType, request.body.fileData, request.body.fileSize].some((value) => value !== undefined && value !== null && value !== '')
  if (!input.body && !input.image && !input.fileData) return response.status(400).json({ error: 'comment or attachment is required' })
  if (typeof request.body.image === 'string' && !input.image) return response.status(400).json({ error: 'valid image is required' })
  if (hasFileFields && (!input.fileName || !input.fileMimeType || !input.fileData || !Number.isInteger(input.fileSize) || input.fileSize < 0)) return response.status(400).json({ error: 'valid file attachment is required' })
  if (input.fileData && Buffer.byteLength(input.fileData, 'utf8') > 7_000_000) return response.status(413).json({ error: 'attachment must be 5 MB or smaller' })
  if (input.fileSize !== null && input.fileSize > 5_000_000) return response.status(413).json({ error: 'attachment must be 5 MB or smaller' })
  if (input.image && Buffer.byteLength(input.image, 'utf8') > 7_000_000) return response.status(413).json({ error: 'image must be 5 MB or smaller' })
  return null
}

app.post('/api/events/:id/comments', async (request, response) => {
  const input = commentInput(request)
  const invalid = validateComment(request, response, input)
  if (invalid) return invalid
  const eventId = idFrom(request.params.id)
  if (!Number.isInteger(eventId) || !await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } })) return response.status(404).json({ error: 'event not found' })
  const comment = await prisma.eventComment.create({ data: { eventId, ...input } })
  response.status(201).json(commentJson(comment))
})

app.post('/api/events/:id/notebook-links', async (request, response) => {
  const eventId = idFrom(request.params.id)
  const notebookId = Number(request.body.notebookId)
  if (!Number.isInteger(eventId) || !await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } })) return response.status(404).json({ error: 'event not found' })
  if (!Number.isInteger(notebookId) || !await prisma.notebook.findUnique({ where: { id: notebookId }, select: { id: true } })) return response.status(404).json({ error: 'notebook not found' })
  await prisma.eventNotebookLink.upsert({ where: { eventId_notebookId: { eventId, notebookId } }, update: {}, create: { eventId, notebookId } })
  response.status(201).json({ ok: true })
})

app.delete('/api/events/:id/notebook-links/:notebookId', async (request, response) => {
  const eventId = idFrom(request.params.id)
  const notebookId = idFrom(request.params.notebookId)
  const result = Number.isInteger(eventId) && Number.isInteger(notebookId)
    ? await prisma.eventNotebookLink.deleteMany({ where: { eventId, notebookId } })
    : { count: 0 }
  if (!result.count) return response.status(404).json({ error: 'link not found' })
  response.json({ ok: true })
})

app.get('/api/board', async (_request, response) => {
  const lists = await prisma.list.findMany({
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, cards: { orderBy: [{ position: 'asc' }, { id: 'asc' }], include: cardInclude } },
  })
  response.json(lists.map(({ cards, ...list }) => ({ ...list, cards: cards.map(cardJson) })))
})

app.get('/api/cards/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const detail = Number.isInteger(id) && await cardDetail(id)
  if (!detail) return response.status(404).json({ error: 'card not found' })
  response.json(detail)
})

app.post('/api/lists/:listId/cards', async (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'title is required' })
  const listId = idFrom(request.params.listId)
  if (!Number.isInteger(listId) || !await prisma.list.findUnique({ where: { id: listId }, select: { id: true } })) return response.status(404).json({ error: 'list not found' })
  const card = await prisma.card.create({ data: { listId, title, position: await nextCardPosition(prisma, listId), color: 'gray' }, include: cardInclude })
  response.status(201).json(cardJson(card))
})

app.patch('/api/cards/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const current = Number.isInteger(id) && await prisma.card.findUnique({ where: { id }, include: cardInclude })
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
  const nextDueDate = dueDate === undefined ? current.dueDate : dueDate
  const nextTitle = title ?? current.title
  const nextDescription = description ?? current.description
  const nextColor = color ?? current.color
  const nextRecurrenceInterval = recurrenceInterval ?? current.recurrenceInterval
  if (nextRecurrence !== 'none' && !nextDueDate) return response.status(400).json({ error: 'recurring tasks need a due date' })
  await prisma.$transaction(async (tx) => {
    await tx.card.update({
      where: { id },
      data: {
        ...(title !== null && { title }),
        ...(description !== null && { description }),
        ...(color !== null && { color }),
        dueDate: nextDueDate,
        ...(priority !== null && { priority }),
        ...(recurrence !== null && { recurrence }),
        ...(recurrenceInterval !== null && { recurrenceInterval }),
      },
    })
    if (description !== null) {
      await syncCardDescriptionLinks(tx, id, description, nextDueDate)
      if (!/^!checklist$/m.test(description)) await tx.checklistItem.deleteMany({ where: { cardId: id } })
    }
    await syncCardDeadline(tx, { cardId: id, title: nextTitle, description: nextDescription, color: nextColor, dueDate: nextDueDate, recurrence: nextRecurrence, recurrenceInterval: nextRecurrenceInterval })
  })
  response.json(await getCardSummary(prisma, id))
})

app.delete('/api/cards/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const result = Number.isInteger(id) ? await prisma.card.deleteMany({ where: { id } }) : { count: 0 }
  if (!result.count) return response.status(404).json({ error: 'card not found' })
  response.json({ ok: true })
})

app.patch('/api/cards/:id/move', async (request, response) => {
  const cardId = idFrom(request.params.id)
  const listId = Number(request.body.listId)
  const index = Number(request.body.index)
  const card = Number.isInteger(cardId) && await prisma.card.findUnique({ where: { id: cardId } })
  if (!card) return response.status(404).json({ error: 'card not found' })
  if (!Number.isInteger(listId) || !await prisma.list.findUnique({ where: { id: listId }, select: { id: true } })) return response.status(404).json({ error: 'list not found' })
  if (!Number.isInteger(index) || index < 0) return response.status(400).json({ error: 'invalid position' })
  await moveCard(prisma, card, listId, index)
  response.json({ ok: true })
})

app.post('/api/cards/:id/comments', async (request, response) => {
  const input = commentInput(request)
  const invalid = validateComment(request, response, input)
  if (invalid) return invalid
  const cardId = idFrom(request.params.id)
  if (!Number.isInteger(cardId) || !await prisma.card.findUnique({ where: { id: cardId }, select: { id: true } })) return response.status(404).json({ error: 'card not found' })
  const comment = await prisma.cardComment.create({ data: { cardId, ...input } })
  response.status(201).json(commentJson(comment))
})

app.post('/api/cards/:id/checklist', async (request, response) => {
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
  if (!title) return response.status(400).json({ error: 'checklist title is required' })
  const cardId = idFrom(request.params.id)
  if (!Number.isInteger(cardId) || !await prisma.card.findUnique({ where: { id: cardId }, select: { id: true } })) return response.status(404).json({ error: 'card not found' })
  const item = await prisma.checklistItem.create({ data: { cardId, title, position: await nextChecklistPosition(prisma, cardId) } })
  response.status(201).json(checklistJson(item))
})

app.patch('/api/checklist/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const item = Number.isInteger(id) && await prisma.checklistItem.findUnique({ where: { id } })
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const title = typeof request.body.title === 'string' ? request.body.title.trim() : null
  const completed = typeof request.body.completed === 'boolean' ? Number(request.body.completed) : null
  if (title === '') return response.status(400).json({ error: 'checklist title is required' })
  const updated = await prisma.checklistItem.update({ where: { id }, data: { ...(title !== null && { title }), ...(completed !== null && { completed }) } })
  response.json(checklistJson(updated))
})

app.patch('/api/checklist/:id/move', async (request, response) => {
  const id = idFrom(request.params.id)
  const item = Number.isInteger(id) && await prisma.checklistItem.findUnique({ where: { id } })
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const direction = request.body.direction
  if (direction !== 'up' && direction !== 'down') return response.status(400).json({ error: 'direction must be up or down' })
  const sibling = await prisma.checklistItem.findFirst({
    where: { cardId: item.cardId, position: direction === 'up' ? { lt: item.position } : { gt: item.position } },
    orderBy: [{ position: direction === 'up' ? 'desc' : 'asc' }, { id: direction === 'up' ? 'desc' : 'asc' }],
  })
  if (sibling) await prisma.$transaction([
    prisma.checklistItem.update({ where: { id: item.id }, data: { position: sibling.position } }),
    prisma.checklistItem.update({ where: { id: sibling.id }, data: { position: item.position } }),
  ])
  response.json({ ok: true })
})

app.post('/api/checklist/:id/convert', async (request, response) => {
  const id = idFrom(request.params.id)
  const item = Number.isInteger(id) && await prisma.checklistItem.findUnique({ where: { id }, include: { card: { select: { listId: true } } } })
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  const createdId = await prisma.$transaction(async (tx) => {
    const card = await tx.card.create({ data: { listId: item.card.listId, title: item.title, position: await nextCardPosition(tx, item.card.listId), color: 'gray' } })
    await tx.checklistItem.delete({ where: { id } })
    return card.id
  })
  response.status(201).json(await getCardSummary(prisma, createdId))
})

app.delete('/api/checklist/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const item = Number.isInteger(id) && await prisma.checklistItem.findUnique({ where: { id }, select: { id: true, cardId: true } })
  if (!item) return response.status(404).json({ error: 'checklist item not found' })
  await prisma.$transaction(async (tx) => {
    await tx.checklistItem.delete({ where: { id } })
    if (!await tx.checklistItem.findFirst({ where: { cardId: item.cardId }, select: { id: true } })) {
      const card = await tx.card.findUnique({ where: { id: item.cardId }, select: { description: true } })
      const description = card.description.replace(/(^|\n)!checklist(?=\n|$)/g, '$1').replace(/\n{3,}/g, '\n\n').trim()
      await tx.card.update({ where: { id: item.cardId }, data: { description } })
    }
  })
  response.json({ ok: true })
})

app.post('/api/cards/:id/attachments', async (request, response) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim().slice(0, 255) : ''
  const mimeType = typeof request.body.mimeType === 'string' ? request.body.mimeType : ''
  const data = typeof request.body.data === 'string' ? request.body.data : ''
  const match = data.match(/^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!name || !match || match[1] !== mimeType) return response.status(400).json({ error: 'valid attachment is required' })
  const size = Buffer.from(match[2], 'base64').length
  if (size > 5_000_000) return response.status(413).json({ error: 'attachment must be 5 MB or smaller' })
  const cardId = idFrom(request.params.id)
  if (!Number.isInteger(cardId) || !await prisma.card.findUnique({ where: { id: cardId }, select: { id: true } })) return response.status(404).json({ error: 'card not found' })
  const attachment = await prisma.cardAttachment.create({ data: { cardId, name, mimeType, data, size } })
  response.status(201).json(attachmentJson(attachment))
})

app.delete('/api/attachments/:id', async (request, response) => {
  const id = idFrom(request.params.id)
  const result = Number.isInteger(id) ? await prisma.cardAttachment.deleteMany({ where: { id } }) : { count: 0 }
  if (!result.count) return response.status(404).json({ error: 'attachment not found' })
  response.json({ ok: true })
})

app.post('/api/cards/:id/links', async (request, response) => {
  const cardId = idFrom(request.params.id)
  const targetId = Number(request.body.targetId)
  const type = request.body.type
  if (!Number.isInteger(cardId) || !await prisma.card.findUnique({ where: { id: cardId }, select: { id: true } })) return response.status(404).json({ error: 'card not found' })
  if (type === 'event') {
    if (!Number.isInteger(targetId) || !await prisma.event.findUnique({ where: { id: targetId }, select: { id: true } })) return response.status(404).json({ error: 'event not found' })
    await prisma.cardEventLink.upsert({ where: { cardId_eventId: { cardId, eventId: targetId } }, update: {}, create: { cardId, eventId: targetId } })
  } else if (type === 'notebook') {
    if (!Number.isInteger(targetId) || !await prisma.notebook.findUnique({ where: { id: targetId }, select: { id: true } })) return response.status(404).json({ error: 'notebook not found' })
    await prisma.cardNotebookLink.upsert({ where: { cardId_notebookId: { cardId, notebookId: targetId } }, update: {}, create: { cardId, notebookId: targetId } })
  } else return response.status(400).json({ error: 'link type must be event or notebook' })
  response.status(201).json({ ok: true })
})

app.delete('/api/cards/:id/links/:type/:targetId', async (request, response) => {
  const cardId = idFrom(request.params.id)
  const targetId = idFrom(request.params.targetId)
  if (request.params.type !== 'event' && request.params.type !== 'notebook') return response.status(400).json({ error: 'link type must be event or notebook' })
  let result
  if (!Number.isInteger(cardId) || !Number.isInteger(targetId)) result = { count: 0 }
  else if (request.params.type === 'event') result = await prisma.cardEventLink.deleteMany({ where: { cardId, eventId: targetId } })
  else result = await prisma.cardNotebookLink.deleteMany({ where: { cardId, notebookId: targetId } })
  if (!result.count) return response.status(404).json({ error: 'link not found' })
  response.json({ ok: true })
})

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || '127.0.0.1'
const server = app.listen(port, host, () => console.log(`API listening on http://${host}:${port}`))

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
