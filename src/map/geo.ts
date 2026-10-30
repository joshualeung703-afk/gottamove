import type { LngLat } from '../types'

const RAD = Math.PI / 180

export function distanceMeters(a: LngLat, b: LngLat) {
  const dx = (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * RAD)
  const dy = (b[1] - a[1]) * 110540
  return Math.hypot(dx, dy)
}

/** Signed difference b − a in degrees, in (−180, 180]. */
export function angleDiff(a: number, b: number) {
  const d = (((b - a) % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

/** "240 m", "1.3 km" */
export function formatDistance(meters: number) {
  return meters < 950 ? `${Math.max(10, Math.round(meters / 10) * 10)} m` : `${(meters / 1000).toFixed(1)} km`
}

const CARDINALS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
const SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
export const cardinalShort = (deg: number) => SHORT[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
