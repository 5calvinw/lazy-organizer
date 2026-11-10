import { useId, useState } from 'react'
import { organizerColors, recurrenceLabels, recurrenceUnits, type OrganizerColor, type Recurrence } from '../api'

/** Text that reads as plain content until focused; saves on blur or Enter and never saves an empty value. */
export function EditableText({ value, onCommit, label, className = '', id }: { value: string; onCommit: (value: string) => void; label: string; className?: string; id?: string }) {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  const [focused, setFocused] = useState(false)
  if (value !== seen) { setSeen(value); if (!focused) setDraft(value) }
  return <div className={`grow ${className}`} data-value={draft}>
    <textarea
      id={id}
      rows={1}
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        const next = draft.trim()
        if (!next) setDraft(value)
        else if (next !== value) { setDraft(next); onCommit(next) }
      }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
    />
  </div>
}

export function ColorPicker({ value, onChange, label = 'Color' }: { value: OrganizerColor; onChange: (color: OrganizerColor) => void; label?: string }) {
  const name = useId()
  return <div className="swatches" role="radiogroup" aria-label={label}>
    {organizerColors.map((color) => <label key={color} title={color === 'gray' ? 'No color' : color}>
      <input type="radio" name={name} value={color} checked={color === value} onChange={() => onChange(color)} />
      <span className={`swatch tone-${color}`} />
      <span className="sr-only">{color === 'gray' ? 'No color' : color}</span>
    </label>)}
  </div>
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
  const name = useId()
  return <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <label key={option.value}>
      <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </div>
}

/** Repeat rule: a select, plus "every N …" only once something repeats. */
export function RepeatField({ recurrence, interval, onChange, disabled = false }: { recurrence: Recurrence; interval: number; onChange: (recurrence: Recurrence, interval: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(interval))
  const [seen, setSeen] = useState(interval)
  if (interval !== seen) { setSeen(interval); setDraft(String(interval)) }
  const commit = () => {
    const next = Math.min(365, Math.max(1, Math.round(Number(draft)) || 1))
    setDraft(String(next))
    if (next !== interval) onChange(recurrence, next)
  }
  return <div className="repeat-field">
    <select value={recurrence} disabled={disabled} aria-label="Repeat" onChange={(event) => onChange(event.target.value as Recurrence, interval)}>
      {(Object.keys(recurrenceLabels) as Recurrence[]).map((item) => <option value={item} key={item}>{recurrenceLabels[item]}</option>)}
    </select>
    {recurrence !== 'none' && <label className="repeat-interval">every
      <input type="number" min="1" max="365" inputMode="numeric" value={draft} disabled={disabled} aria-label="Repeat interval" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />
      {recurrenceUnits[recurrence]}{interval === 1 ? '' : 's'}
    </label>}
  </div>
}

export function CheckCircle({ checked, onToggle, label, disabled = false }: { checked: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className="check" role="checkbox" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onToggle() }}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.2 8.4 2.5 2.5 5.1-5.6" /></svg>
  </button>
}
