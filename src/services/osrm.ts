import type { LngLat } from '../types'

export interface DriveRoute {
  coords: LngLat[]
  distanceKm: number
  durationMin: number
  /** True when the route only works by putting the car on a ferry (e.g. Suomenlinna's service ferry). */
  ferry: boolean
}

/** Car routing on OpenStreetMap data via the public OSRM server. */
export async function driveRoute(from: LngLat, to: LngLat, signal?: AbortSignal): Promise<DriveRoute> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&steps=true`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`OSRM ${res.status}`)
  const json = await res.json()
  const route = json.routes?.[0]
  if (json.code !== 'Ok' || !route) throw new Error('No road route')
  const ferry = route.legs.some((leg: { steps: { mode: string }[] }) => leg.steps.some((s) => s.mode === 'ferry'))
  return { coords: route.geometry.coordinates, distanceKm: route.distance / 1000, durationMin: route.duration / 60, ferry }
}
