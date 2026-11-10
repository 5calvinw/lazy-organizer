export type AuthSession = { user: { username?: string; name: string } }

export async function getSession(): Promise<AuthSession | null> {
  const response = await fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) return null
  return response.json()
}

export async function signIn(username: string, password: string) {
  const response = await fetch('/api/auth/sign-in/username', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, rememberMe: true }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? 'Invalid username or password')
}

export async function signOut() {
  const response = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' })
  if (!response.ok) throw new Error('Could not sign out. Please try again.')
}
