import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A small menu anchored to its button. It is positioned against the viewport so scroll containers can't clip it,
 * and closes on outside press, Escape, scroll or resize.
 */
export function Dropdown({
  label,
  ariaLabel,
  className = '',
  buttonClassName = 'text-button',
  menuClassName = '',
  role = 'menu',
  children,
}: {
  label: ReactNode
  ariaLabel?: string
  className?: string
  buttonClassName?: string
  menuClassName?: string
  role?: 'menu' | 'dialog'
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return
    const anchor = button.current.getBoundingClientRect()
    const height = menu.current.offsetHeight
    const width = menu.current.offsetWidth
    const below = anchor.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : below
    const alignedRight = anchor.right - width
    const left = Math.max(8, Math.min(alignedRight, window.innerWidth - width - 8))
    setPlace({ top, left })
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close() }
    const scrolled = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', close); document.removeEventListener('keydown', key, true) }
  }, [open])
  return <>
    <button ref={button} type="button" className={`${buttonClassName} ${className}`.trim()} aria-haspopup={role === 'dialog' ? 'dialog' : 'menu'} aria-expanded={open} aria-label={ariaLabel} onClick={() => { setPlace(null); setOpen(!open) }}>{label}</button>
    {open && <div ref={menu} className={`menu dropdown ${menuClassName}`.trim()} role={role} aria-label={role === 'dialog' ? ariaLabel : undefined} style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}>{children(() => setOpen(false))}</div>}
  </>
}
