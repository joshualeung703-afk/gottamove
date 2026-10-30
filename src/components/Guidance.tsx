import { MODES } from '../config/modes'
import { angleDiff, cardinal, formatDistance } from '../map/geo'
import { OFF_ROUTE_M, type RouteProgress } from '../map/tracking'
import type { TripOption } from '../types'

interface Props {
  option: TripOption
  /** Where the user is along the option's route. */
  progress: RouteProgress
  /** Current map bearing, so the arrow matches what's on screen. */
  mapBearing: number
  /** Which way the phone is facing, when it has a compass. */
  heading: number | null
  /** Offered when the user has wandered off the route and we know where they are. */
  onReroute?: () => void
}

/** This close to where a ride starts, say how to board instead of counting down metres. */
const BOARD_ZONE_M = 20

/** With a live compass, say it relative to the user: "Turn left" beats "Head west" when you're in a hurry. */
function relative(diff: number) {
  const a = Math.abs(diff)
  if (a <= 20) return 'Straight ahead'
  const side = diff > 0 ? 'right' : 'left'
  if (a <= 60) return `Bear ${side}`
  if (a <= 125) return `Turn ${side}`
  return 'Turn around'
}

function stepText(option: TripOption, p: RouteProgress) {
  const step = option.steps[p.segment]
  const next = option.steps[p.segment + 1]
  if (!step) return ''
  if (step.board && p.segmentDone < BOARD_ZONE_M) return step.board
  if (next?.board && p.segmentLeft < BOARD_ZONE_M) return next.board
  return step.ride ? `${step.action} to ${step.to}` : `${step.action} ${formatDistance(p.segmentLeft)} to ${step.to}`
}

export function Guidance({ option, progress, mapBearing, heading, onReroute }: Props) {
  const off = !progress.arrived && progress.offRoute > OFF_ROUTE_M
  const headline = progress.arrived
    ? "You've arrived"
    : heading === null ? `Head ${cardinal(progress.bearing)}` : relative(angleDiff(heading, progress.bearing))
  // The banner has to be readable at a glance, so dark mode colours (Uber grey) use their lighter halo.
  const accent = option.legs?.find((l) => l.mode !== 'WALK')?.color ?? MODES[option.mode].glow ?? MODES[option.mode].color
  const detail = (progress.arrived ? option.steps.at(-1)?.to : stepText(option, progress)) ?? ''
  return (
    <div
      className={`guidance${off ? ' off-route' : ''}`}
      role="status"
      aria-live="polite"
      style={{ '--accent': off ? '#ffb02e' : accent } as React.CSSProperties}
    >
      <div
        className="guidance-arrow"
        style={progress.arrived ? undefined : { transform: `rotate(${progress.bearing - mapBearing}deg)` }}
        aria-hidden
      >
        <svg viewBox="0 0 48 48">
          {progress.arrived ? <path className="guidance-check" d="M12 25 L21 34 L37 15" /> : <path d="M24 5 L38 39 L24 31 L10 39 Z" />}
        </svg>
      </div>
      <div className="guidance-text">
        <div className="guidance-head">
          {headline}
          {!progress.arrived && heading !== null && <span className="guidance-card"> · {cardinal(progress.bearing)}</span>}
        </div>
        <div className="guidance-sub">
          {off ? (
            <>Off route · {formatDistance(progress.offRoute)} back to it</>
          ) : (
            <>
              {/* "Walk · Walk 1.1 km to …" says it twice; skip the title when the step already does. */}
              {!detail.startsWith(option.title) && <><strong>{option.title}</strong> · </>}
              {detail}
            </>
          )}
        </div>
      </div>
      {off && onReroute && (
        <button className="guidance-reroute" onClick={onReroute}>
          Re-route
        </button>
      )}
    </div>
  )
}
