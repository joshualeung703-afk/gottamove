import { cardinalShort } from '../map/geo'
import type { CompassMode } from '../map/MapView'

interface Props {
  /** Map bearing: the compass direction the top of the screen points to. */
  bearing: number
  mode: CompassMode
  onClick: () => void
}

const LABELS: Record<CompassMode, string> = {
  north: 'Compass: north is up. Tap to turn the map with your phone.',
  heading: 'The map turns with your phone. Tap to put north up.',
  free: 'Map rotated. Tap to put north up.',
}

export function Compass({ bearing, mode, onClick }: Props) {
  const facing = `${cardinalShort(bearing)} ${Math.round((bearing + 360) % 360)}°`
  return (
    <button className={`compass compass-${mode}`} onClick={onClick} aria-label={LABELS[mode]} title={LABELS[mode]}>
      <span className="compass-dial">
        <svg className="compass-rose" viewBox="0 0 64 64" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden>
          <circle cx="32" cy="32" r="29.5" className="cp-ring" />
          {/* A tick every 30°, with longer ones at E, S and W; N sits just inside the rim. */}
          <circle cx="32" cy="32" r="26.5" className="cp-ticks" />
          {[90, 180, 270].map((a) => (
            <line key={a} x1="32" y1="4.2" x2="32" y2="8.8" className="cp-major" transform={`rotate(${a} 32 32)`} />
          ))}
          <text x="32" y="14" className="cp-n">N</text>
          <path d="M32 16.5 36 32h-8z" className="cp-north" />
          <path d="M32 47.5 36 32h-8z" className="cp-south" />
          <circle cx="32" cy="32" r="2.6" className="cp-hub" />
        </svg>
      </span>
      <span className="compass-label">{mode === 'north' ? 'North up' : mode === 'heading' ? facing : 'Tap: north'}</span>
    </button>
  )
}
