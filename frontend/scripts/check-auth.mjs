import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { default: App } = await server.ssrLoadModule('/src/App.tsx')
  assert.equal(renderToString(React.createElement(App)), '')
  const { Login } = await server.ssrLoadModule('/src/Login.tsx')
  const html = renderToString(React.createElement(Login, { onSuccess() {} }))
  assert.match(html, /autocomplete="username"/i)
  assert.match(html, /autocomplete="current-password"/i)
  assert(!html.includes('Sections'))
  console.log('Auth render check passed: no organizer markup before session verification.')
} finally {
  await server.close()
}
