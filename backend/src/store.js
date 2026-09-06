import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

export const cardInclude = {
  list: { select: { title: true } },
  _count: {
    select: {
      checklist: true,
      attachments: true,
    },
  },
  checklist: { where: { completed: 1 }, select: { id: true } },
}

export function cardJson(card) {
  return {
    id: card.id,
    list_id: card.listId,
    title: card.title,
    description: card.description,
    color: card.color,
    due_date: card.dueDate,
    priority: card.priority,
    recurrence: card.recurrence,
    recurrence_interval: card.recurrenceInterval,
    created_at: card.createdAt,
    list_title: card.list.title,
    checklist_count: card._count.checklist,
    checklist_completed: card.checklist.filter((item) => item.completed === 1).length,
    attachment_count: card._count.attachments,
  }
}

export function eventJson(event) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    event_date: event.eventDate,
    event_time: event.eventTime,
    end_time: event.endTime,
    end_date: event.endDate,
    all_day: event.allDay,
    time_zone: event.timeZone,
    is_deadline: event.isDeadline,
    color: event.color,
    recurrence: event.recurrence,
    recurrence_interval: event.recurrenceInterval,
    recurrence_parent_id: event.recurrenceParentId,
    created_at: event.createdAt,
  }
}

export function commentJson(comment) {
  return {
    id: comment.id,
    body: comment.body,
    image: comment.image,
    file_name: comment.fileName,
    file_mime_type: comment.fileMimeType,
    file_data: comment.fileData,
    file_size: comment.fileSize,
    created_at: comment.createdAt,
  }
}

export function checklistJson(item, includeCardId = false) {
  return {
    id: item.id,
    ...(includeCardId ? { card_id: item.cardId } : {}),
    title: item.title,
    completed: item.completed,
    position: item.position,
    created_at: item.createdAt,
  }
}

export function attachmentJson(attachment, includeData = true) {
  return {
    id: attachment.id,
    name: attachment.name,
    mime_type: attachment.mimeType,
    ...(includeData ? { data: attachment.data } : {}),
    size: attachment.size,
    created_at: attachment.createdAt,
  }
}

export function notebookJson(notebook, includeImages = true) {
  return {
    id: notebook.id,
    title: notebook.title,
    content: notebook.content,
    ...(includeImages ? { images: JSON.parse(notebook.images) } : {}),
    created_at: notebook.createdAt,
  }
}

export function nextOccurrence(value, recurrence, interval = 1) {
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

export async function nextCardPosition(db, listId) {
  const result = await db.card.aggregate({ where: { listId }, _max: { position: true } })
  return (result._max.position ?? -1) + 1
}

export async function nextChecklistPosition(db, cardId) {
  const result = await db.checklistItem.aggregate({ where: { cardId }, _max: { position: true } })
  return (result._max.position ?? -1) + 1
}

export async function getCardSummary(db, id) {
  const card = await db.card.findUnique({ where: { id }, include: cardInclude })
  return card ? cardJson(card) : null
}

export async function syncCardDeadline(tx, { cardId, title, description, color, dueDate, recurrence, recurrenceInterval }) {
  const deadlines = await tx.event.findMany({
    where: { cardLinks: { some: { cardId } }, isDeadline: 1 },
    orderBy: [{ recurrenceParentId: 'asc' }, { id: 'asc' }],
  })
  if (dueDate === null) {
    await tx.event.deleteMany({ where: { id: { in: deadlines.map(({ id }) => id) } } })
    return
  }
  const existing = deadlines[0]
  const eventTime = existing?.eventTime ?? '09:00'
  if (existing) {
    if (existing.recurrenceParentId === null) await tx.event.deleteMany({ where: { recurrenceParentId: existing.id } })
    await tx.event.update({
      where: { id: existing.id },
      data: { title, description, eventDate: dueDate, eventTime, endTime: eventTime, isDeadline: 1, color, recurrence, recurrenceInterval },
    })
    return
  }
  await tx.event.create({
    data: {
      title,
      description,
      eventDate: dueDate,
      eventTime,
      endTime: eventTime,
      isDeadline: 1,
      color,
      recurrence,
      recurrenceInterval,
      cardLinks: { create: { cardId } },
    },
  })
}

export function eventOverlapWhere(startDate, endDate) {
  return { eventDate: { lt: endDate }, OR: [{ eventDate: { gte: startDate } }, { endDate: { gt: startDate } }, { allDay: false, endDate: startDate, endTime: { gt: '00:00' } }] }
}

export async function ensureRecurringEvents(endDate, db = prisma) {
  await db.$transaction(async (tx) => {
    const tombstones = await tx.googleEventMapping.findMany({ where: { tombstone: true, localSnapshot: { not: null } }, select: { localSnapshot: true } })
    const deletedOccurrences = new Set(tombstones.map(({ localSnapshot }) => {
      const event = JSON.parse(localSnapshot)
      return `${event.recurrenceParentId}/${event.eventDate}/${event.eventTime}`
    }))
    const roots = await tx.event.findMany({ where: { recurrence: { not: 'none' }, recurrenceParentId: null } })
    for (const root of roots) {
      const latest = await tx.event.findFirst({
        where: { OR: [{ id: root.id }, { recurrenceParentId: root.id }] },
        orderBy: { eventDate: 'desc' },
        select: { eventDate: true },
      })
      let occurrenceDate = latest.eventDate
      while (occurrenceDate < endDate) {
        occurrenceDate = nextOccurrence(occurrenceDate, root.recurrence, root.recurrenceInterval)
        if (!occurrenceDate || occurrenceDate > endDate) break
        if (deletedOccurrences.has(`${root.id}/${occurrenceDate}/${root.eventTime}`)) continue
        await tx.event.upsert({
          where: { recurrenceParentId_eventDate_eventTime: { recurrenceParentId: root.id, eventDate: occurrenceDate, eventTime: root.eventTime } },
          update: {},
          create: {
            title: root.title,
            description: root.description,
            eventDate: occurrenceDate,
            eventTime: root.eventTime,
            endTime: root.endTime,
            timeZone: root.timeZone,
            isDeadline: root.isDeadline,
            color: root.color,
            recurrence: 'none',
            recurrenceInterval: 1,
            recurrenceParentId: root.id,
          },
        })
      }
    }
  })
}

export async function completeRecurringCard(tx, card, destinationListId) {
  const [source, destination] = await Promise.all([
    tx.list.findUnique({ where: { id: card.listId }, select: { title: true } }),
    tx.list.findUnique({ where: { id: destinationListId }, select: { title: true } }),
  ])
  if (destination?.title.toLocaleLowerCase() !== 'done' || source?.title.toLocaleLowerCase() === 'done' || card.recurrence === 'none') return
  const nextDueDate = nextOccurrence(card.dueDate, card.recurrence, card.recurrenceInterval)
  if (!nextDueDate) return
  const [position, checklist, eventLinks, notebookLinks] = await Promise.all([
    nextCardPosition(tx, card.listId),
    tx.checklistItem.findMany({ where: { cardId: card.id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
    tx.cardEventLink.findMany({ where: { cardId: card.id }, select: { eventId: true } }),
    tx.cardNotebookLink.findMany({ where: { cardId: card.id }, select: { notebookId: true } }),
  ])
  const created = await tx.card.create({
    data: {
      listId: card.listId,
      title: card.title,
      description: card.description,
      position,
      color: card.color,
      dueDate: nextDueDate,
      priority: card.priority,
      recurrence: card.recurrence,
      recurrenceInterval: card.recurrenceInterval,
    },
  })
  await tx.card.update({ where: { id: card.id }, data: { recurrence: 'none', recurrenceInterval: 1 } })
  if (checklist.length) await tx.checklistItem.createMany({ data: checklist.map((item) => ({ cardId: created.id, title: item.title, position: item.position })) })
  if (eventLinks.length) await tx.cardEventLink.createMany({ data: eventLinks.map(({ eventId }) => ({ cardId: created.id, eventId })) })
  if (notebookLinks.length) await tx.cardNotebookLink.createMany({ data: notebookLinks.map(({ notebookId }) => ({ cardId: created.id, notebookId })) })
}

export async function moveCard(db, card, listId, index) {
  await db.$transaction(async (tx) => {
    const source = await tx.card.findMany({
      where: { listId: card.listId, id: { not: card.id } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    const destination = card.listId === listId ? source : await tx.card.findMany({
      where: { listId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    destination.splice(Math.min(index, destination.length), 0, { id: card.id })
    if (card.listId !== listId) {
      await Promise.all(source.map((item, position) => tx.card.update({ where: { id: item.id }, data: { listId: card.listId, position } })))
    }
    await Promise.all(destination.map((item, position) => tx.card.update({ where: { id: item.id }, data: { listId, position } })))
    await completeRecurringCard(tx, card, listId)
  })
}
