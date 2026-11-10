import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { getSession, signOut } from './auth'
import { EventDialog } from './components/EventDialog'
import { ConfirmHost, ToastHost } from './components/Modal'
import { NotebookDialog } from './components/NotebookDialog'
import { TaskDialog } from './components/TaskDialog'
import { RecordsContext, toastError, type RecordRef } from './overlays'
import { Calendar } from './views/Calendar'
import { Notebooks } from './views/Notebooks'
import { Tasks } from './views/Tasks'
import { Today } from './views/Today'
import { Login } from './Login'

const views = ['today', 'tasks', 'calendar', 'notebooks'] as const
type View = typeof views[number]
const labels: Record<View, string> = { today: 'Today', tasks: 'Tasks', calendar: 'Calendar', notebooks: 'Notebooks' }

function currentView(): View {
  const name = window.location.hash.replace(/^#\/?/, '')
  if ((views as readonly string[]).includes(name)) return name as View
  // Google's consent screen sends you back with a result for the calendar.
  return new URLSearchParams(window.location.search).has('google_calendar') ? 'calendar' : 'today'
}
const same = (a: RecordRef, b: RecordRef) => a.type === b.type && a.id === b.id

function App() {
  const [authState, setAuthState] = useState<'checking' | 'signed-in' | 'signed-out'>('checking')
  useEffect(() => {
    getSession().then((session) => {
      if (session) {
        if (window.location.pathname === '/login') window.history.replaceState({}, '', '/')
        setAuthState('signed-in')
      } else {
        if (window.location.pathname !== '/login') window.history.replaceState({}, '', '/login')
        setAuthState('signed-out')
      }
    }).catch(() => {
      if (window.location.pathname !== '/login') window.history.replaceState({}, '', '/login')
      setAuthState('signed-out')
    })
  }, [])
  if (authState === 'checking') return null
  if (authState === 'signed-out') return <Login onSuccess={() => window.location.replace('/')} />
  return <Organizer />
}

function Organizer() {
  const [view, setView] = useState<View>(currentView)
  // Open tasks, events and notebooks stack: following a link opens it on top, closing returns to where you were.
  const [stack, setStack] = useState<RecordRef[]>([])

  useEffect(() => {
    const changed = () => setView(currentView())
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => { document.title = `${labels[view]} · Lazy Organizer` }, [view])

  const open = useCallback((record: RecordRef) => setStack((current) => {
    const index = current.findIndex((item) => same(item, record))
    return index >= 0 ? current.slice(0, index + 1) : [...current, record]
  }), [])
  const close = useCallback((record: RecordRef) => setStack((current) => {
    const index = current.findIndex((item) => same(item, record))
    return index >= 0 ? current.slice(0, index) : current
  }), [])
  const records = useMemo(() => ({ open, close }), [open, close])

  return <RecordsContext value={records}>
    <div className="app">
      <header className="topbar">
        <a className="wordmark" href="#/today">Lazy Organizer</a>
        <nav aria-label="Sections">
          {views.map((name) => <a key={name} href={`#/${name}`} aria-current={view === name ? 'page' : undefined}>{labels[name]}</a>)}
        </nav>
        <button className="text-button sign-out" type="button" onClick={async () => {
          try { await signOut(); window.location.replace('/login') }
          catch { toastError('Could not sign out. Please try again.') }
        }}>Sign out</button>
      </header>
      <main className="stage">
        <section hidden={view !== 'today'} aria-label="Today"><Today active={view === 'today'} /></section>
        <section hidden={view !== 'tasks'} aria-label="Tasks"><Tasks active={view === 'tasks'} /></section>
        <section hidden={view !== 'calendar'} aria-label="Calendar"><Calendar active={view === 'calendar'} /></section>
        <section hidden={view !== 'notebooks'} aria-label="Notebooks"><Notebooks active={view === 'notebooks'} /></section>
      </main>
      {stack.map((record) => {
        const key = `${record.type}-${record.id}`
        const onClose = () => close(record)
        if (record.type === 'card') return <TaskDialog key={key} id={record.id} onClose={onClose} />
        if (record.type === 'event') return <EventDialog key={key} id={record.id} onClose={onClose} />
        return <NotebookDialog key={key} id={record.id} onClose={onClose} />
      })}
      <ConfirmHost />
      <ToastHost />
    </div>
  </RecordsContext>
}

export default App
