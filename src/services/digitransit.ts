import polyline from '@mapbox/polyline'
import type { LngLat, Place } from '../types'
import { createSearch, toPlace, type GeoFeature } from './search'

const BASE = '/api/digitransit'
const ROUTING = `${BASE}/routing/v2/hsl/gtfs/v1`

/** Rough HSL service area, used to bound geocoding and to sanity-check the user's location. */
export const HSL_BOUNDS = { minLat: 59.9, maxLat: 60.5, minLon: 24.2, maxLon: 25.6 }

export class ApiKeyError extends Error {
  constructor() {
    super('Digitransit API key missing or invalid — set DIGITRANSIT_KEY in .env and restart the dev server')
  }
}

/** The planner answered fine but found no trip with these modes (too short, too far, across water …). */
export class NoRouteError extends Error {}

/** Digitransit's gateway sometimes answers 502/503/504, or rate-limits, for a moment. Those are worth a quick retry. */
const RETRY_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [400, 1200]

async function request(url: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    if (res.status === 401 || res.status === 403) throw new ApiKeyError()
    if (RETRY_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      continue
    }
    if (RETRY_STATUS.has(res.status)) throw new Error('The HSL route planner is busy. Try again in a moment.')
    if (!res.ok) throw new Error(`Digitransit ${res.status}`)
    return res.json()
  }
}

const geoParams = (extra: Record<string, string>) =>
  new URLSearchParams({
    lang: 'en',
    'boundary.rect.min_lat': String(HSL_BOUNDS.minLat),
    'boundary.rect.max_lat': String(HSL_BOUNDS.maxLat),
    'boundary.rect.min_lon': String(HSL_BOUNDS.minLon),
    'boundary.rect.max_lon': String(HSL_BOUNDS.maxLon),
    ...extra,
  })

// No focus point on purpose: biasing towards the user floods results with nearby house numbers.
const placeSearch = createSearch({
  fetchFeatures: async (endpoint, text, signal) =>
    (await request(`${BASE}/geocoding/v1/${endpoint}?${geoParams({ text, size: '10' })}`, { signal })).features as GeoFeature[],
  loadNames: async () => {
    const res = await fetch('/helsinki-names.json')
    if (!res.ok) throw new Error('Name index unavailable')
    return res.json()
  },
})

/** Typo-tolerant destination search (see search.ts). */
export const geocode = placeSearch.search
/** Fetch the spelling-correction index ahead of time, e.g. when the search box gets focus. */
export const preloadSearch = placeSearch.preload

export async function reverseGeocode(coord: LngLat): Promise<Place> {
  const p = new URLSearchParams({ 'point.lon': String(coord[0]), 'point.lat': String(coord[1]), size: '1', lang: 'en' })
  try {
    const json = await request(`${BASE}/geocoding/v1/reverse?${p}`)
    const f = json.features?.[0] as GeoFeature | undefined
    if (f) return { ...toPlace(f), coord }
  } catch {
    // Fall through to a coordinate label — a missing name shouldn't block routing.
  }
  return { coord, label: 'Dropped pin', sublabel: `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}` }
}

export interface OtpLeg {
  mode: string
  duration: number
  distance: number
  rentedBike?: boolean
  start: { scheduledTime: string }
  end: { scheduledTime: string }
  route?: { shortName?: string } | null
  from: { name: string; stop?: { zoneId?: string } | null }
  to: { name: string; stop?: { zoneId?: string } | null }
  legGeometry: { points: string }
}

export interface OtpItinerary {
  start: string
  end: string
  duration: number
  legs: OtpLeg[]
}

const PLAN_QUERY = `
query Plan($origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!, $first: Int, $modes: PlanModesInput) {
  planConnection(origin: $origin, destination: $destination, first: $first, modes: $modes) {
    routingErrors { code description }
    edges {
      node {
        start
        end
        duration
        legs {
          mode
          duration
          distance
          rentedBike
          start { scheduledTime }
          end { scheduledTime }
          route { shortName }
          from { name stop { zoneId } }
          to { name stop { zoneId } }
          legGeometry { points }
        }
      }
    }
  }
}`

const loc = (p: Place) => ({
  label: p.label,
  location: { coordinate: { latitude: p.coord[1], longitude: p.coord[0] } },
})

async function plan(from: Place, to: Place, modes: object, first: number, signal?: AbortSignal): Promise<OtpItinerary[]> {
  const json = await request(ROUTING, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: PLAN_QUERY, variables: { origin: loc(from), destination: loc(to), first, modes } }),
    signal,
  })
  if (json.errors?.length) throw new Error(json.errors[0].message)
  const conn = json.data.planConnection
  const itineraries = (conn.edges as { node: OtpItinerary }[]).map((e) => e.node)
  if (!itineraries.length) {
    const err = conn.routingErrors?.[0]
    throw new NoRouteError(err ? humanRoutingError(err.code, err.description) : 'No route found')
  }
  return itineraries
}

function humanRoutingError(code: string, description: string) {
  if (code === 'WALKING_BETTER_THAN_TRANSIT') return 'Walking is faster than any transit here'
  if (code === 'NO_TRANSIT_CONNECTION' || code === 'NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW') return 'No transit connection right now'
  if (code === 'NO_DIRECT_MODE_CONNECTION') return 'No direct route — too far or across water'
  if (code === 'OUTSIDE_BOUNDS' || code === 'OUTSIDE_SERVICE_PERIOD') return 'Outside the HSL area'
  return description || 'No route found'
}

export const planTransit = (from: Place, to: Place, signal?: AbortSignal) =>
  plan(from, to, { transitOnly: true }, 3, signal)

/** Cycle to a bike park at a stop, then public transport. HSL's planner has no scooter data, so this stands in for scooters too. */
export const planBikeAndRide = (from: Place, to: Place, signal?: AbortSignal) =>
  plan(from, to, { transitOnly: true, transit: { access: ['BICYCLE_PARKING'] } }, 5, signal)

/** HSL city bikes to and from public transport (rentals need walking allowed alongside, as above). */
export const planCityBikeAndRide = (from: Place, to: Place, signal?: AbortSignal) =>
  plan(from, to, { transitOnly: true, transit: { access: ['BICYCLE_RENTAL', 'WALK'], egress: ['BICYCLE_RENTAL', 'WALK'] } }, 5, signal)

export const planDirect = (from: Place, to: Place, mode: 'WALK' | 'BICYCLE' | 'BICYCLE_RENTAL' | 'CAR', signal?: AbortSignal) =>
  // OTP only routes rental bikes when walking is allowed for the legs to and from the station.
  plan(from, to, { directOnly: true, direct: mode === 'BICYCLE_RENTAL' ? [mode, 'WALK'] : [mode] }, 1, signal).then((its) => its[0])

export const decodeLeg = (leg: OtpLeg): LngLat[] =>
  polyline.decode(leg.legGeometry.points).map(([lat, lon]) => [lon, lat])
