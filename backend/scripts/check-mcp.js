import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp'
const apiKey = process.env.MCP_API_KEY
assert(apiKey, 'MCP_API_KEY is required')

const client = new Client({ name: 'lazy-organizer-check', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
})

await client.connect(transport)
const { tools } = await client.listTools()
assert(tools.some(({ name }) => name === 'get_board'))
assert(tools.some(({ name }) => name === 'create_card'))
assert(tools.some(({ name }) => name === 'create_event'))
assert(tools.some(({ name }) => name === 'update_notebook'))
assert(tools.some(({ name }) => name === 'delete_card'))
assert(tools.some(({ name }) => name === 'delete_event'))
assert(tools.some(({ name }) => name === 'delete_notebook'))

const boardCall = await client.callTool({ name: 'get_board', arguments: {} })
assert.equal(boardCall.isError, undefined)
const board = boardCall.structuredContent?.result
assert(Array.isArray(board) && board.length > 0, 'get_board must return at least one list')

const marker = `MCP check ${Date.now()}`
const createCall = await client.callTool({
  name: 'create_card',
  arguments: { list_id: board[0].id, title: marker, description: 'Created by scripts/check-mcp.js', due_date: '2099-12-30' },
})
assert.equal(createCall.isError, undefined)
const created = createCall.structuredContent?.result
assert.equal(created.title, marker)

const createdDetailCall = await client.callTool({ name: 'get_card', arguments: { card_id: created.id } })
assert.equal(createdDetailCall.isError, undefined)
assert.deepEqual(createdDetailCall.structuredContent?.result.links.events.map(({ event_date, is_deadline }) => ({ event_date, is_deadline })), [{ event_date: '2099-12-30', is_deadline: 1 }])
const deadlineId = createdDetailCall.structuredContent?.result.links.events[0].id
const calendarCall = await client.callTool({ name: 'list_events', arguments: { month: '2099-12' } })
assert.equal(calendarCall.isError, undefined)
assert(calendarCall.structuredContent?.result.some(({ id, event_date, is_deadline }) => id === deadlineId && event_date === '2099-12-30' && is_deadline === 1))

const updateCall = await client.callTool({
  name: 'update_card',
  arguments: { card_id: created.id, description: 'MCP mutation verified', due_date: '2099-12-31' },
})
assert.equal(updateCall.isError, undefined)
assert.equal(updateCall.structuredContent?.result.description, 'MCP mutation verified')

const updatedDetailCall = await client.callTool({ name: 'get_card', arguments: { card_id: created.id } })
assert.equal(updatedDetailCall.isError, undefined)
assert.deepEqual(updatedDetailCall.structuredContent?.result.links.events.map(({ event_date, is_deadline }) => ({ event_date, is_deadline })), [{ event_date: '2099-12-31', is_deadline: 1 }])

const clearDeadlineCall = await client.callTool({ name: 'update_card', arguments: { card_id: created.id, due_date: null } })
assert.equal(clearDeadlineCall.isError, undefined)
const clearedDetailCall = await client.callTool({ name: 'get_card', arguments: { card_id: created.id } })
assert.equal(clearedDetailCall.isError, undefined)
assert.deepEqual(clearedDetailCall.structuredContent?.result.links.events, [])

const deleteCall = await client.callTool({ name: 'delete_card', arguments: { card_id: created.id } })
assert.equal(deleteCall.isError, undefined)
assert.equal(deleteCall.structuredContent?.result.ok, true)

console.log(`MCP check passed: ${tools.length} tools; created, updated, and deleted card ${created.id}`)
await client.close()
