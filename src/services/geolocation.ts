import type { LngLat, Place } from '../types'
import { HSL_BOUNDS } from './digitransit'

export const HELSINKI_CENTRAL: Place = { coord: [24.9414, 60.1710], label: 'Helsinki Central Station', sublabel: 'Default start' }

export type LocationStatus = 'locating' | 'live' | 'denied' | 'unavailable' | 'outside'

const inHsl = (lon: number, lat: number) =>
  lat >= HSL_BOUNDS.minLat && lat <= HSL_BOUNDS.maxLat && lon >= HSL_BOUNDS.minLon && lon <= HSL_BOUNDS.maxLon

/** Fixes worse than this (metres) are ignored once we have a decent one, so the dot doesn't leap around. */
const MAX_ACCURACY_M = 150

/** Follows the user's position as they move. Returns a stop function. */
export function watchLocation(onFix: (coord: LngLat) => void, onStatus: (status: LocationStatus) => void) {
  if (!navigator.geolocation) {
    onStatus('unavailable')
    return () => {}
  }
  onStatus('locating')
  let haveGoodFix = false
  const id = navigator.geolocation.watchPosition(
    ({ coords }) => {
      if (!inHsl(coords.longitude, coords.latitude)) return onStatus('outside')
      if (haveGoodFix && coords.accuracy > MAX_ACCURACY_M) return
      haveGoodFix ||= coords.accuracy <= MAX_ACCURACY_M
      onStatus('live')
      onFix([coords.longitude, coords.latitude])
    },
    // A timeout doesn't end the watch; a fix can still arrive later.
    (err) => onStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
