export function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const parseDate = (value: string) => new Date(`${value}T00:00:00`)

export function addDays(value: string, days: number) {
  const date = parseDate(value)
  date.setDate(date.getDate() + days)
  return isoDate(date)
}

export function dayShift(from: string, to: string) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000)
}

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = parseDate(value)
  return !Number.isNaN(parsed.valueOf()) && isoDate(parsed) === value
}

export function addMonths(value: string, months: number) {
  const date = parseDate(value)
  const day = date.getDate()
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDay))
  return isoDate(target)
}

/** Monday of the Monday–Sunday week containing `value`. */
export function startOfWeek(value: string) {
  const date = parseDate(value)
  return addDays(value, -((date.getDay() + 6) % 7))
}

export function monthBounds(value: string) {
  const date = parseDate(value)
  const start = isoDate(new Date(date.getFullYear(), date.getMonth(), 1))
  const end = isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0))
  return { start, end }
}

export function formatMonthYear(value: string) {
  return parseDate(value).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function formatFullDate(value: string) {
  return parseDate(value).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export function formatWeekday(value: string) {
  return parseDate(value).toLocaleDateString(undefined, { weekday: 'long' })
}

export function formatRangeHeading(start: string, end: string) {
  if (start === end) return formatFullDate(start)
  const a = parseDate(start)
  const b = parseDate(end)
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    const month = a.toLocaleDateString(undefined, { month: 'short' })
    return `${month} ${a.getDate()} – ${b.getDate()}, ${a.getFullYear()}`
  }
  if (a.getFullYear() === b.getFullYear()) {
    const left = a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const right = b.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${left} – ${right}, ${a.getFullYear()}`
  }
  const left = a.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const right = b.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${left} – ${right}`
}

export function compactTime(value: string) {
  return readableTime(value).replace(':00', '').replace(/\s?([AP]M)/i, (_, half: string) => half.toLowerCase())
}

export function readableDate(value: string) {
  const date = parseDate(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** "Today", "Tomorrow", "Yesterday", a weekday within the coming week, otherwise a short date. */
export function relativeDate(value: string, today = isoDate(new Date())) {
  const days = Math.round((parseDate(value).getTime() - parseDate(today).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 1 && days < 7) return parseDate(value).toLocaleDateString(undefined, { weekday: 'long' })
  return readableDate(value)
}

/** The same label for the middle of a sentence: "today" and "tomorrow" drop their capital, names keep theirs. */
export function relativePhrase(value: string, today?: string) {
  const label = relativeDate(value, today)
  return /^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label
}

export function readableTime(value: string) {
  return new Date(`2000-01-01T${value}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Server timestamps are UTC, either "YYYY-MM-DD HH:MM:SS" or ISO. */
export function readableTimestamp(value: string) {
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.valueOf())) return ''
  const day = relativeDate(isoDate(date))
  return `${day}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export const fileSize = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
