import { BEAM_STYLE, LEG_COLORS, MODES } from '../config/modes'
import {
  BOLT, CITYBIKE, SCOOTER, TAXI_DAY, TAXI_NIGHT, TRAFFIC_FACTOR, UBER,
  cityBikePrice, hslFare, isTaxiNightRate, rideEstimate, scooterPrice,
} from '../config/pricing'
import { distanceMeters } from '../map/geo'
import type { Beam, BeamSegment, GroupResult, LngLat, ModeId, Place, TransitLeg, TripOption, TripStep } from '../types'
import {
  NoRouteError, decodeLeg, planBikeAndRide, planCityBikeAndRide, planDirect, planTransit,
  type OtpItinerary, type OtpLeg,
} from './digitransit'
import { driveRoute } from './osrm'

export type GroupKey = 'transit' | 'walk' | 'bike' | 'citybike' | 'car' | 'rideMix' | 'citybikeMix'

export interface TripGroup {
  key: GroupKey
  label: string
  modes: ModeId[]
  /** Combines a scooter or bike with public transport: listed under the Mix tab instead of Fastest/Cheapest. */
  mix?: boolean
  run: (from: Place, to: Place, signal: AbortSignal) => Promise<GroupResult>
}

const km = (meters: number) => meters / 1000
const co2 = (mode: ModeId, distanceKm: number) => Math.round(MODES[mode].co2PerKm * distanceKm)
const itineraryKm = (it: OtpItinerary) => km(it.legs.reduce((s, l) => s + l.distance, 0))
const ll = (c: LngLat) => `${c[1]},${c[0]}`

function mapsLink(from: Place, to: Place, travelmode: 'walking' | 'bicycling' | 'driving') {
  return `https://www.google.com/maps/dir/?api=1&origin=${ll(from.coord)}&destination=${ll(to.coord)}&travelmode=${travelmode}`
}

function reittiopasLink(from: Place, to: Place) {
  const part = (p: Place) => encodeURIComponent(`${p.label}::${ll(p.coord)}`)
  return `https://reittiopas.hsl.fi/reitti/${part(from)}/${part(to)}`
}

function uberLink(from: Place, to: Place) {
  const p = new URLSearchParams({
    action: 'setPickup',
    'pickup[latitude]': String(from.coord[1]),
    'pickup[longitude]': String(from.coord[0]),
    'dropoff[latitude]': String(to.coord[1]),
    'dropoff[longitude]': String(to.coord[0]),
    'dropoff[nickname]': to.label,
  })
  return `https://m.uber.com/ul/?${p}`
}

/** Public transport legs are the ones with a route; walking, cycling and scooter legs have none. */
const isTransit = (leg: OtpLeg) => !!leg.route
/** The leg's mode, except that rented bikes count as CITYBIKE (own bikes stay BICYCLE). */
const legKey = (leg: OtpLeg) => (leg.rentedBike ? 'CITYBIKE' : leg.mode)

function legSegments(it: OtpItinerary, rideColor?: string): BeamSegment[] {
  return it.legs.map((leg) => ({
    coords: decodeLeg(leg),
    color: leg.mode === 'WALK' ? LEG_COLORS.WALK : (rideColor ?? LEG_COLORS[legKey(leg)] ?? MODES.transit.color),
    dashed: leg.mode === 'WALK',
  }))
}

const VEHICLE: Record<string, string> = { BUS: 'bus', TRAM: 'tram', SUBWAY: 'metro', RAIL: 'train', FERRY: 'ferry' }

/** One step per itinerary leg (matching legSegments): walking and cycling count down, rides say where to get off. */
function legSteps(it: OtpItinerary): TripStep[] {
  return it.legs.map((leg) => {
    if (leg.mode === 'WALK') return { action: 'Walk', to: leg.to.name }
    if (leg.rentedBike) return { action: 'Cycle', to: leg.to.name, board: `Pick up a city bike at ${leg.from.name}` }
    if (leg.mode === 'BICYCLE') return { action: 'Cycle', to: leg.to.name }
    if (leg.mode === 'SCOOTER') return { action: 'Ride a scooter', to: leg.to.name, board: 'Grab a scooter nearby' }
    const line = `${VEHICLE[leg.mode] ?? leg.mode.toLowerCase()} ${leg.route?.shortName ?? ''}`.trim()
    return {
      action: `Ride ${line}`,
      to: leg.to.name,
      ride: true,
      board: `Take ${line} from ${leg.from.name} at ${clock(leg.start.scheduledTime)}`,
    }
  })
}

/** Road routes snap to the nearest street; draw dotted walking links to the exact start and end points. */
function withConnectors(from: LngLat, coords: LngLat[], to: LngLat, color: string): BeamSegment[] {
  const gap = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 55660, (a[1] - b[1]) * 111320) > 25
  const first = coords[0]
  const last = coords[coords.length - 1]
  return [
    ...(gap(from, first) ? [{ coords: [from, first], color: LEG_COLORS.WALK, dashed: true }] : []),
    { coords, color },
    ...(gap(last, to) ? [{ coords: [last, to], color: LEG_COLORS.WALK, dashed: true }] : []),
  ]
}

/** The card's leg chips: every ride, plus walks long enough to matter. */
function legChips(it: OtpItinerary): TransitLeg[] {
  return it.legs
    .filter((l) => l.mode !== 'WALK' || l.duration > 90)
    .map((l) => ({
      mode: legKey(l),
      line: l.route?.shortName,
      color: LEG_COLORS[legKey(l)] ?? MODES.transit.color,
      durationMin: Math.round(l.duration / 60),
      from: l.from.name,
    }))
}

/** One HSL ticket covers every ride of the trip, for the zones they touch. */
function fareFor(it: OtpItinerary) {
  const zones = it.legs.filter(isTransit).flatMap((l) => [l.from.stop?.zoneId, l.to.stop?.zoneId]).filter((z): z is string => !!z)
  return hslFare(zones)
}

/** "M2 from Lauttasaari at 16:20" */
function firstDeparture(it: OtpItinerary) {
  const ride = it.legs.find(isTransit)
  return ride && `${ride.route?.shortName ?? ''} from ${ride.from.name} at ${clock(ride.start.scheduledTime)}`
}

const quickest = (its: OtpItinerary[]) =>
  its.reduce<OtpItinerary | undefined>((best, it) => (!best || it.duration < best.duration ? it : best), undefined)

const transit: TripGroup = {
  key: 'transit',
  label: 'Public transport',
  modes: ['transit'],
  async run(from, to, signal) {
    const itineraries = await planTransit(from, to, signal)
    const beams: Beam[] = []
    const options: TripOption[] = itineraries.map((it, i) => {
      const beamId = `transit-${i}`
      beams.push({ id: beamId, segments: legSegments(it), offset: BEAM_STYLE.transit.offset, secondary: i > 0 })
      const fare = fareFor(it)
      const distanceKm = itineraryKm(it)
      return {
        id: beamId,
        mode: 'transit',
        beamId,
        title: 'Public transport',
        subtitle: it.legs.filter(isTransit).map((l) => l.route?.shortName ?? l.mode.toLowerCase()).join(' → '),
        durationMin: it.duration / 60,
        priceMin: fare?.price ?? 0,
        priceMax: fare?.price ?? 0,
        estimated: false,
        distanceKm,
        co2g: co2('transit', distanceKm),
        departure: it.start,
        arrival: it.end,
        legs: legChips(it),
        note: [fare && `HSL ${fare.ticket} ticket`, firstDeparture(it)].filter(Boolean).join(' · '),
        link: { label: 'Open in Reittiopas', href: reittiopasLink(from, to) },
        steps: legSteps(it),
      }
    })
    return { options, beams }
  },
}

const walk: TripGroup = {
  key: 'walk',
  label: 'Walk',
  modes: ['walk'],
  async run(from, to, signal) {
    const it = await planDirect(from, to, 'WALK', signal)
    const distanceKm = itineraryKm(it)
    return {
      beams: [{ id: 'walk', segments: legSegments(it, BEAM_STYLE.walk.color).map((s) => ({ ...s, dashed: false })), offset: BEAM_STYLE.walk.offset }],
      options: [{
        id: 'walk', mode: 'walk', beamId: 'walk', title: 'Walk',
        subtitle: `${distanceKm.toFixed(1)} km`,
        durationMin: it.duration / 60, priceMin: 0, priceMax: 0, estimated: false,
        distanceKm, co2g: 0, link: { label: 'Directions', href: mapsLink(from, to, 'walking') },
        steps: legSteps(it),
      }],
    }
  },
}

const bike: TripGroup = {
  key: 'bike',
  label: 'Bike & scooter',
  modes: ['bike', 'scooter'],
  async run(from, to, signal) {
    const it = await planDirect(from, to, 'BICYCLE', signal)
    const distanceKm = itineraryKm(it)
    const bikeMin = it.duration / 60
    const scooterMin = bikeMin * SCOOTER.speedVsBike
    const scooterCost = scooterPrice(scooterMin)
    const segments = legSegments(it, BEAM_STYLE.bike.color).map((s) => ({ ...s, color: BEAM_STYLE.bike.color, dashed: false }))
    return {
      beams: [
        { id: 'bike', segments, offset: BEAM_STYLE.bike.offset },
        { id: 'scooter', segments: segments.map((s) => ({ ...s, color: BEAM_STYLE.scooter.color })), offset: BEAM_STYLE.scooter.offset },
      ],
      options: [
        {
          id: 'bike', mode: 'bike', beamId: 'bike', title: 'Own bike', subtitle: `${distanceKm.toFixed(1)} km`,
          durationMin: bikeMin, priceMin: 0, priceMax: 0, estimated: false, distanceKm, co2g: 0,
          link: { label: 'Directions', href: mapsLink(from, to, 'bicycling') },
          steps: legSteps(it),
        },
        {
          id: 'scooter', mode: 'scooter', beamId: 'scooter', title: 'E-scooter', subtitle: 'Voi · Dott · Lime · Bolt',
          durationMin: scooterMin, priceMin: scooterCost * SCOOTER.range[0], priceMax: scooterCost * SCOOTER.range[1],
          estimated: true, distanceKm, co2g: co2('scooter', distanceKm),
          note: `€${SCOOTER.unlock.toFixed(2)} unlock + ~€${SCOOTER.perMin.toFixed(2)}/min`,
          steps: [{ action: 'Ride', to: to.label, board: 'Find a scooter nearby' }],
        },
      ],
    }
  },
}

function cityBikeInSeason(d = new Date()) {
  return d.getMonth() >= CITYBIKE.season.fromMonth && d.getMonth() <= CITYBIKE.season.toMonth
}

const citybike: TripGroup = {
  key: 'citybike',
  label: 'City bike',
  modes: ['citybike'],
  async run(from, to, signal) {
    if (!cityBikeInSeason()) throw new Error('HSL city bikes are off-season (Apr–Oct)')
    const it = await planDirect(from, to, 'BICYCLE_RENTAL', signal)
    const ride = it.legs.filter((l) => l.rentedBike)
    if (!ride.length) throw new Error('Walking beats a city bike here')
    const price = cityBikePrice(ride.reduce((s, l) => s + l.duration, 0) / 60)
    const distanceKm = itineraryKm(it)
    return {
      beams: [{ id: 'citybike', segments: legSegments(it, BEAM_STYLE.citybike.color), offset: BEAM_STYLE.citybike.offset }],
      options: [{
        id: 'citybike', mode: 'citybike', beamId: 'citybike', title: 'HSL city bike',
        subtitle: `Pick up at ${ride[0].from.name}`,
        durationMin: it.duration / 60, priceMin: price, priceMax: price,
        estimated: false, distanceKm, co2g: 0,
        note: `Day pass €${CITYBIKE.dayPass} · drop at ${ride[ride.length - 1].to.name}`,
        steps: legSteps(it),
        link: { label: 'Open in Reittiopas', href: reittiopasLink(from, to) },
      }],
    }
  },
}

const car: TripGroup = {
  key: 'car',
  label: 'Taxi & ride-hail',
  modes: ['taxi', 'uber', 'bolt'],
  async run(from, to, signal) {
    const route = await driveRoute(from.coord, to.coord, signal).catch(async (err) => {
      if (signal.aborted) throw err
      const it = await planDirect(from, to, 'CAR', signal)
      return { coords: it.legs.flatMap(decodeLeg), distanceKm: itineraryKm(it), durationMin: it.duration / 60, ferry: false }
    })
    if (route.ferry) throw new Error('No road connection — cars can only get there by ferry')
    const driveMin = route.durationMin * TRAFFIC_FACTOR
    const segments = withConnectors(from.coord, route.coords, to.coord, MODES.taxi.color)
    const night = isTaxiNightRate()
    const taxiRate = night ? TAXI_NIGHT : TAXI_DAY
    const rides = [
      { mode: 'taxi' as const, title: 'Taxi', rate: taxiRate, subtitle: night ? 'Evening/weekend tariff' : 'Daytime tariff', link: { label: 'Call Taksi Helsinki', href: 'tel:+3581000700' } },
      { mode: 'uber' as const, title: 'Uber', rate: UBER, subtitle: 'UberX', link: { label: 'Open Uber', href: uberLink(from, to) } },
      { mode: 'bolt' as const, title: 'Bolt', rate: BOLT, subtitle: 'Bolt standard', link: { label: 'Open Bolt', href: 'https://bolt.eu/en-fi/' } },
    ]
    return {
      // Same road route for all three; each gets its own beam in its own colour (walking links stay grey).
      beams: rides.map(({ mode }) => ({
        id: mode,
        segments: segments.map((seg) => (seg.dashed ? seg : { ...seg, color: MODES[mode].color, glow: MODES[mode].glow })),
        offset: BEAM_STYLE[mode].offset,
      })),
      options: rides.map(({ mode, title, rate, subtitle, link }) => {
        const [lo, hi] = rideEstimate(rate, route.distanceKm, driveMin)
        return {
          id: mode, mode, beamId: mode, title, subtitle,
          durationMin: driveMin + rate.pickupMin, priceMin: lo, priceMax: hi, estimated: true,
          distanceKm: route.distanceKm, co2g: co2(mode, route.distanceKm),
          note: `${route.distanceKm.toFixed(1)} km · incl. ~${rate.pickupMin} min pickup`,
          steps: segments.map((seg, i) => seg.dashed
            ? { action: 'Walk', to: i === 0 ? 'the pickup point' : to.label }
            : { action: 'Ride', to: to.label, ride: true, board: `Wait here for your ${mode === 'taxi' ? 'taxi' : title}` }),
          link,
        }
      }),
    }
  },
}

type MixKind = 'scooter' | 'bike' | 'citybike'

const MIX_PART: Record<string, string> = { SCOOTER: 'scooter', BICYCLE: 'bike', CITYBIKE: 'city bike', ...VEHICLE }

/** What the scooter or bike part adds to the HSL ticket, as a [low, high] range. */
function mixExtra(kind: MixKind, it: OtpItinerary): { cost: [number, number]; note?: string } {
  if (kind === 'scooter') {
    const cost = it.legs.filter((l) => l.mode === 'SCOOTER').reduce((s, l) => s + scooterPrice(l.duration / 60), 0)
    return { cost: [cost * SCOOTER.range[0], cost * SCOOTER.range[1]], note: `scooter ~€${cost.toFixed(2)}` }
  }
  if (kind === 'citybike') {
    const cost = cityBikePrice(it.legs.filter((l) => l.rentedBike).reduce((s, l) => s + l.duration, 0) / 60)
    return { cost: [cost, cost], note: `city bike €${cost}` }
  }
  const park = it.legs.find((l) => l.mode === 'BICYCLE')?.to.name
  return { cost: [0, 0], note: park && `park at ${park}` }
}

/** A scooter or bike combined with public transport, as one option with its own beam. */
function mixTrip(kind: MixKind, it: OtpItinerary, from: Place, to: Place): GroupResult {
  const id = `${kind}-mix`
  // "Scooter + metro + bus": each kind of ride, in the order they come.
  const parts = [...new Set(it.legs.filter((l) => l.mode !== 'WALK').map((l) => MIX_PART[legKey(l)] ?? l.mode.toLowerCase()))]
  const fare = fareFor(it)
  const extra = mixExtra(kind, it)
  const perKm = (l: OtpLeg) => (isTransit(l) ? MODES.transit.co2PerKm : l.mode === 'SCOOTER' ? MODES.scooter.co2PerKm : 0)
  return {
    beams: [{ id, segments: legSegments(it), offset: BEAM_STYLE[`${kind}Mix` as const].offset }],
    options: [{
      id, mode: kind, beamId: id,
      title: parts.join(' + ').replace(/^./, (c) => c.toUpperCase()),
      durationMin: it.duration / 60,
      priceMin: (fare?.price ?? 0) + extra.cost[0],
      priceMax: (fare?.price ?? 0) + extra.cost[1],
      estimated: kind === 'scooter',
      distanceKm: itineraryKm(it),
      co2g: Math.round(it.legs.reduce((g, l) => g + perKm(l) * km(l.distance), 0)),
      departure: it.start,
      arrival: it.end,
      legs: legChips(it),
      note: [fare && `HSL ${fare.ticket} ticket`, extra.note, firstDeparture(it)].filter(Boolean).join(' · '),
      link: { label: 'Open in Reittiopas', href: reittiopasLink(from, to) },
      steps: legSteps(it),
    }],
  }
}

/** Metres cycled before the first ride. */
function cycledToStop(it: OtpItinerary) {
  const first = it.legs.findIndex(isTransit)
  return it.legs.slice(0, Math.max(first, 0)).reduce((m, l) => m + (l.mode === 'BICYCLE' ? l.distance : 0), 0)
}

/**
 * A bike & ride trip, told for an own bike (left in the stop's bike park) or for a rental scooter,
 * which rides the same lanes and can be left right by the stop.
 */
function rideToStation(it: OtpItinerary, by: 'bike' | 'scooter'): OtpItinerary {
  const first = it.legs.findIndex(isTransit)
  return {
    ...it,
    legs: it.legs.map((l, i) => {
      if (i >= first || l.mode !== 'BICYCLE') return l
      return by === 'scooter'
        ? { ...l, mode: 'SCOOTER', to: { ...l.to, name: it.legs[first].from.name } }
        : { ...l, to: { ...l.to, name: `${l.to.name} bike park` } }
    }),
  }
}

/** Finishing by scooter is only worth a look if the rest of the trip takes this long, from a stop this far away. */
const EGRESS_MIN_REST_S = 5 * 60
const EGRESS_RANGE_M = [300, 6000]

/**
 * Try finishing the trip by scooter straight after one of its last rides (metro, then scooter, instead of
 * metro + bus + walk). The scooter part is a bike route from that stop; it's kept if it arrives a minute sooner.
 */
async function withScooterEgress(it: OtpItinerary, to: Place, signal: AbortSignal): Promise<OtpItinerary> {
  const arrival = Date.parse(it.end)
  const tries = it.legs.flatMap((leg, i) => {
    if (!isTransit(leg) || arrival - Date.parse(leg.end.scheduledTime) < EGRESS_MIN_REST_S * 1000) return []
    const stop = decodeLeg(leg).at(-1)
    const far = stop ? distanceMeters(stop, to.coord) : 0
    return stop && far >= EGRESS_RANGE_M[0] && far <= EGRESS_RANGE_M[1] ? [{ leg, i, stop }] : []
  }).slice(-2)
  const rides = await Promise.all(tries.map(({ leg, stop }) =>
    planDirect({ coord: stop, label: leg.to.name }, to, 'BICYCLE', signal).catch(() => null)))
  let best = it
  let bestArrival = arrival - 60_000
  tries.forEach(({ leg, i }, n) => {
    const ride = rides[n]
    const at = ride && Date.parse(leg.end.scheduledTime) + ride.duration * 1000
    if (!ride || !at || at > bestArrival) return
    bestArrival = at
    best = {
      ...it,
      end: new Date(at).toISOString(),
      duration: (at - Date.parse(it.start)) / 1000,
      legs: [...it.legs.slice(0, i + 1), ...ride.legs.map((l) => (l.mode === 'BICYCLE' ? { ...l, mode: 'SCOOTER' } : l))],
    }
  })
  return best
}

/** Cycling less than this to the bike park is a hop next door: the trip is really plain public transport. */
const MIN_RIDE_TO_STOP_M = 400

/** For mixed trips "no route" just means no mix; the panel says so once rather than an error per group. */
function noMix(e: unknown): OtpItinerary[] {
  if (e instanceof NoRouteError) return []
  throw e
}

const rideMix: TripGroup = {
  key: 'rideMix',
  label: 'Scooter & bike + transit',
  modes: ['scooter', 'bike'],
  mix: true,
  async run(from, to, signal) {
    const [parked, plain] = await Promise.all([
      planBikeAndRide(from, to, signal).catch(noMix),
      planTransit(from, to, signal).catch(noMix),
    ])
    const bike = quickest(parked.filter((it) => cycledToStop(it) >= MIN_RIDE_TO_STOP_M))
    // A scooter can start the trip (as on the bike) or finish it after the quickest plain transit trip.
    // Only the quickest of each is tried: every attempt to finish by scooter costs a routing request.
    const bases = [bike && rideToStation(bike, 'scooter'), quickest(plain)].filter((it): it is OtpItinerary => !!it)
    const scooter = quickest((await Promise.all(bases.map((it) => withScooterEgress(it, to, signal))))
      .filter((it) => it.legs.some((l) => l.mode === 'SCOOTER')))
    const trips = [scooter && mixTrip('scooter', scooter, from, to), bike && mixTrip('bike', rideToStation(bike, 'bike'), from, to)]
      .filter((t): t is GroupResult => !!t)
    return { options: trips.flatMap((t) => t.options), beams: trips.flatMap((t) => t.beams) }
  },
}

const citybikeMix: TripGroup = {
  key: 'citybikeMix',
  label: 'City bike + transit',
  modes: ['citybike'],
  mix: true,
  async run(from, to, signal) {
    if (!cityBikeInSeason()) return { options: [], beams: [] }
    const best = quickest((await planCityBikeAndRide(from, to, signal).catch(noMix)).filter((it) => it.legs.some((l) => l.rentedBike)))
    return best ? mixTrip('citybike', best, from, to) : { options: [], beams: [] }
  },
}

export const TRIP_GROUPS: TripGroup[] = [transit, walk, bike, citybike, car, rideMix, citybikeMix]

export function clock(iso: string | number) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
