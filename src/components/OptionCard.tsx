import { useRef } from 'react'
import { MODES } from '../config/modes'
import { clock } from '../services/compare'
import type { TripOption } from '../types'
import { Icon, LEG_ICON, MODE_ICON } from './Icons'

export function formatPrice(o: TripOption) {
  if (o.priceMax === 0) return 'Free'
  const fmt = (n: number) => (n >= 10 ? `€${Math.round(n)}` : `€${n.toFixed(2)}`)
  if (Math.abs(o.priceMax - o.priceMin) < 0.05) return fmt(o.priceMin)
  return `${fmt(o.priceMin)}–${fmt(o.priceMax).slice(1)}`
}

export function formatDuration(min: number) {
  const m = Math.max(1, Math.round(min))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim()
}

/** Two taps this close together focus the option. Timed by hand: iOS doesn't send dblclick for taps. */
const DOUBLE_TAP_MS = 350

interface Props {
  option: TripOption
  badges: string[]
  /** e.g. "6 min faster than public transport", on mixed trips. */
  gain?: string
  highlighted: boolean
  selected: boolean
  onHighlight: (id: string | null) => void
  onSelect: (id: string) => void
  /** Double-tap: show only this option's route. */
  onFocusOption: (id: string) => void
}

export function OptionCard({ option: o, badges, gain, highlighted, selected, onHighlight, onSelect, onFocusOption }: Props) {
  const meta = MODES[o.mode]
  // Transit cards take their first vehicle's look; mixed trips keep their scooter or bike's.
  const firstRide = o.mode === 'transit' ? o.legs?.find((l) => l.mode !== 'WALK') : undefined
  const accent = firstRide?.color ?? meta.color
  const icon = (firstRide && LEG_ICON[firstRide.mode]) ?? MODE_ICON[o.mode]
  const lastTap = useRef(0)
  const tap = () => {
    const now = Date.now()
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0
      onFocusOption(o.id)
    } else {
      lastTap.current = now
      onSelect(o.id)
    }
  }
  return (
    <li
      className={`card${highlighted || selected ? ' highlighted' : ''}${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      style={{ '--accent': accent, '--icon': meta.glow ?? accent } as React.CSSProperties}
      tabIndex={0}
      onMouseEnter={() => onHighlight(o.id)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(o.id)}
      onClick={tap}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        tap()
      }}
      title="Double-tap to show only this route"
    >
      <div className="card-icon" aria-hidden>
        <span className="icon-frame">
          <Icon kind={icon} />
        </span>
      </div>
      <div className="card-body">
        <div className="card-top">
          <span className="card-title">{o.title}</span>
          {badges.map((b) => <span key={b} className={`badge badge-${b.toLowerCase()}`}>{b}</span>)}
        </div>
        {o.legs ? (
          <div className="legs">
            {o.legs.map((l, i) => (
              <span key={i} className="leg" style={{ '--leg': l.color } as React.CSSProperties}>
                <Icon kind={LEG_ICON[l.mode] ?? 'metro'} className="leg-icon" />
                {l.line ? <b>{l.line}</b> : <small>{l.durationMin}′</small>}
              </span>
            ))}
          </div>
        ) : (
          o.subtitle && <div className="card-sub">{o.subtitle}</div>
        )}
        <div className="card-meta">
          {gain && <span className="card-gain">{gain}</span>}
          {o.departure && o.arrival && <span>{clock(o.departure)} → {clock(o.arrival)}</span>}
          {o.note && <span>{o.note}</span>}
          <span>{o.co2g === 0 ? 'Zero emissions' : `~${o.co2g >= 1000 ? `${(o.co2g / 1000).toFixed(1)} kg` : `${o.co2g} g`} CO₂`}</span>
        </div>
        {o.link && (highlighted || selected) && (
          <a className="card-link" href={o.link.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {o.link.label} ↗
          </a>
        )}
        {selected && <div className="card-hint">Double-tap to show only this route</div>}
      </div>
      <div className="card-figures">
        <span className="card-time">{formatDuration(o.durationMin)}</span>
        <span className="card-price">{formatPrice(o)}</span>
        {o.estimated && <span className="card-est">estimate</span>}
      </div>
    </li>
  )
}
