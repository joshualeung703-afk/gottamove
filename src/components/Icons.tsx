import type { ReactNode } from 'react'
import type { ModeId } from '../types'

export type IconKind =
  | 'walk' | 'bike' | 'citybike' | 'scooter' | 'metro' | 'bus' | 'tram' | 'train' | 'ferry'
  | 'taxi' | 'car' | 'bolt' | 'plus' | 'minus' | 'locate'

// Line icons on a 24px grid. They're stroked in currentColor so CSS can make them glow in each mode's colour.
const PATHS: Record<IconKind, ReactNode> = {
  walk: (
    <>
      <circle cx="13.5" cy="4.5" r="1.8" />
      <path d="M12.8 8 11 13.2l2.8 2.4.8 5.4M11 13.2 9 21M8.2 11.4 12.8 8l3.4 3" />
    </>
  ),
  bike: (
    <>
      <circle cx="5.5" cy="16.5" r="3.5" />
      <circle cx="18.5" cy="16.5" r="3.5" />
      <path d="M5.5 16.5 9.5 9.5h5.7l3.3 7M9.5 9.5l2.7 7 3-7M8 7.5h3M15.2 9.5l.4-3M14.2 6.5H17" />
    </>
  ),
  // HSL city bikes have a basket up front.
  citybike: (
    <>
      <circle cx="5.5" cy="16.5" r="3.5" />
      <circle cx="18.5" cy="16.5" r="3.5" />
      <path d="M5.5 16.5 9.5 9.5h5.7l3.3 7M9.5 9.5l2.7 7 3-7M8 7.5h3M15.2 9.5l.4-3M16.4 5h4.4l-.9 3.4h-3z" />
    </>
  ),
  scooter: (
    <>
      <circle cx="5.5" cy="18" r="2.4" />
      <circle cx="18.5" cy="18" r="2.4" />
      <path d="M7.9 18h8.2M18.5 15.6 16 4.5M13.5 4.5H18" />
    </>
  ),
  metro: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="3.5" />
      <rect x="7.5" y="5.5" width="9" height="4.5" rx="1" />
      <path d="M8.5 13.8h.01M15.5 13.8h.01M8 17l-2 4M16 17l2 4" />
    </>
  ),
  bus: (
    <>
      <rect x="4" y="3" width="16" height="15" rx="2.5" />
      <path d="M4 10h16M9 6h6M7.5 14.5h.01M16.5 14.5h.01M7 18v2.5M17 18v2.5" />
    </>
  ),
  tram: (
    <>
      <rect x="6" y="5" width="12" height="13" rx="2.5" />
      <path d="M8 2.5h8M12 2.5V5M6 11h12M9 14.5h.01M15 14.5h.01M8.5 18 7 21M15.5 18l1.5 3" />
    </>
  ),
  train: (
    <path d="M6 17V8a6 5 0 0 1 12 0v9zM8 9.5h8M9 14h.01M15 14h.01M8 17l-2 4M16 17l2 4M7 19.5h10" />
  ),
  ferry: (
    <path d="M3 13.5h18l-2.6 5H5.6zM7 13.5V9h8l2 4.5M10 9V5.5M3 21.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" />
  ),
  taxi: (
    <>
      <path d="M3.5 16v-3.2L6 7.5h12l2.5 5.3V16zM3.5 12.8h17M10 4.5h4v3h-4z" />
      <circle cx="7.5" cy="16.5" r="1.8" />
      <circle cx="16.5" cy="16.5" r="1.8" />
    </>
  ),
  car: (
    <>
      <path d="M3.5 16v-3.2L6 7.5h12l2.5 5.3V16zM3.5 12.8h17" />
      <circle cx="7.5" cy="16.5" r="1.8" />
      <circle cx="16.5" cy="16.5" r="1.8" />
    </>
  ),
  bolt: <path d="M13.5 2.5 5.5 13.5h6l-1 8 8.5-11.5h-6z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  locate: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
}

export function Icon({ kind, className }: { kind: IconKind; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[kind]}
    </svg>
  )
}

/** The icon for each trip option; transit cards use their first vehicle's icon instead. */
export const MODE_ICON: Record<ModeId, IconKind> = {
  walk: 'walk', bike: 'bike', citybike: 'citybike', scooter: 'scooter',
  transit: 'metro', taxi: 'taxi', uber: 'car', bolt: 'bolt',
}

/** Icons for trip legs, keyed by OTP leg mode (CITYBIKE for rented bikes, SCOOTER in mixed trips). */
export const LEG_ICON: Record<string, IconKind> = {
  BUS: 'bus', TRAM: 'tram', SUBWAY: 'metro', RAIL: 'train', FERRY: 'ferry', WALK: 'walk', BICYCLE: 'bike',
  CITYBIKE: 'citybike', SCOOTER: 'scooter',
}
