import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { signIn } from './auth'

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { document.title = 'Sign in | Lazy Organizer' }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(username.trim(), password)
      onSuccess()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return <main className="login-page">
    <form className="login-form" onSubmit={submit}>
      <p className="eyebrow">Lazy Organizer</p>
      <h1>Sign in</h1>
      <label>Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={30} value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>Password<input type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
    </form>
  </main>
}
