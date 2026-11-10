import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { betterAuth } from 'better-auth'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { username } from 'better-auth/plugins'
import { prisma } from './store.js'

const usernameValue = process.env.AUTH_USERNAME?.trim().toLowerCase()
const passwordValue = process.env.AUTH_PASSWORD
const secret = process.env.BETTER_AUTH_SECRET?.trim()

if (!/^[a-z0-9_]{1,30}$/.test(usernameValue ?? '') || !passwordValue || passwordValue.length < 8 || passwordValue.length > 128 || !secret || secret.length < 32) {
  throw new Error('Set AUTH_USERNAME (1-30 letters, numbers or underscores), AUTH_PASSWORD (8-128 characters), and BETTER_AUTH_SECRET (at least 32 characters)')
}
const baseURL = process.env.BETTER_AUTH_URL || 'http://localhost:5173'
const origin = new URL(baseURL).origin

export const auth = betterAuth({
  secret,
  baseURL,
  database: prismaAdapter(prisma, { provider: 'sqlite' }),
  emailAndPassword: { enabled: true, disableSignUp: true },
  session: { expiresIn: 60 * 60 * 24 * 30, disableSessionRefresh: true },
  rateLimit: { enabled: true },
  plugins: [username({ immutableUsername: true, minUsernameLength: 1 })],
})

export const authHandler = toNodeHandler(auth)

export function requireApiOrigin(request, response, next) {
  response.set('Cache-Control', 'no-store')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.get('origin') !== origin) {
    return response.status(403).json({ error: 'invalid request origin' })
  }
  next()
}

export async function ensureAuthUser() {
  // ponytail: one shared organizer owner; add per-user data ownership before supporting registration.
  const id = 'organizer-owner'
  const accountId = 'organizer-owner-password'
  const existing = await prisma.account.findUnique({ where: { id: accountId }, include: { user: true } })
  if (existing?.user.username === usernameValue && await verifyPassword({ hash: existing.password, password: passwordValue })) return
  const password = await hashPassword(passwordValue)
  await prisma.$transaction(async (tx) => {
    const data = { name: usernameValue, email: 'owner@organizer.invalid', username: usernameValue, displayUsername: usernameValue }
    await tx.user.upsert({ where: { id }, update: data, create: { id, ...data } })
    await tx.account.upsert({
      where: { id: accountId },
      update: { password },
      create: { id: accountId, accountId: id, providerId: 'credential', userId: id, password },
    })
    await tx.session.deleteMany({ where: { userId: id } })
  })
}

export async function requireSession(request, response, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
    if (!session) return response.status(401).json({ error: 'authentication required', code: 'AUTH_REQUIRED' })
    next()
  } catch (error) {
    next(error)
  }
}
