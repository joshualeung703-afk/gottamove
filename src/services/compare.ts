import { BEAM_STYLE, LEG_COLORS, MODES } from '../config/modes'
import {
  BOLT, CITYBIKE, SCOOTER, TAXI_DAY, TAXI_NIGHT, TRAFFIC_FACTOR, UBER,
  hslFare, isTaxiNightRate, rideEstimate,
} from '../config/pricing'
import type { Beam, BeamSegment, GroupResult, LngLat, ModeId, Place, TransitLeg, TripOption, TripStep } from '../types'
import { decodeLeg, planDirect, planTransit, type OtpItinerary } from './digitransit'
import { driveRoute } from './osrm'

export type GroupKey = 'transit' | 'walk' | 'bike' | 'citybike' | 'car'

export interface TripGroup {
  key: GroupKey
  label: string
  modes: ModeId[]
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

function legSegments(it: OtpItinerary, rideColor?: string): BeamSegment[] {
  return it.legs.map((leg) => ({
    coords: decodeLeg(leg),
    color: leg.mode === 'WALK' ? LEG_COLORS.WALK : (rideColor ?? LEG_COLORS[leg.mode] ?? MODES.transit.color),
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
      const rides = it.legs.filter((l) => l.mode !== 'WALK')
      const zones = rides.flatMap((l) => [l.from.stop?.zoneId, l.to.stop?.zoneId]).filter((z): z is string => !!z)
      const fare = hslFare(zones)
      const legs: TransitLeg[] = it.legs
        .filter((l) => l.mode !== 'WALK' || l.duration > 90)
        .map((l) => ({
          mode: l.mode,
          line: l.route?.shortName,
          color: LEG_COLORS[l.mode] ?? MODES.transit.color,
          durationMin: Math.round(l.duration / 60),
          from: l.from.name,
        }))
      const firstRide = rides[0]
      const distanceKm = itineraryKm(it)
      return {
        id: beamId,
        mode: 'transit',
        beamId,
        title: 'Public transport',
        subtitle: rides.map((l) => l.route?.shortName ?? l.mode.toLowerCase()).join(' → '),
        durationMin: it.duration / 60,
        priceMin: fare?.price ?? 0,
        priceMax: fare?.price ?? 0,
        estimated: false,
        distanceKm,
        co2g: co2('transit', distanceKm),
        departure: it.start,
        arrival: it.end,
        legs,
        note: [
          fare && `HSL ${fare.ticket} ticket`,
          firstRide && `${firstRide.route?.shortName ?? ''} from ${firstRide.from.name} at ${clock(firstRide.start.scheduledTime)}`,
        ].filter(Boolean).join(' · '),
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
    const scooterPrice = SCOOTER.unlock + SCOOTER.perMin * scooterMin
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
          durationMin: scooterMin, priceMin: scooterPrice * SCOOTER.range[0], priceMax: scooterPrice * SCOOTER.range[1],
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
    const rideMin = ride.reduce((s, l) => s + l.duration, 0) / 60
    const extra = Math.max(0, Math.ceil((rideMin - CITYBIKE.includedMin) / 30)) * CITYBIKE.extraPer30
    const distanceKm = itineraryKm(it)
    return {
      beams: [{ id: 'citybike', segments: legSegments(it, BEAM_STYLE.citybike.color), offset: BEAM_STYLE.citybike.offset }],
      options: [{
        id: 'citybike', mode: 'citybike', beamId: 'citybike', title: 'HSL city bike',
        subtitle: `Pick up at ${ride[0].from.name}`,
        durationMin: it.duration / 60, priceMin: CITYBIKE.dayPass + extra, priceMax: CITYBIKE.dayPass + extra,
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

export const TRIP_GROUPS: TripGroup[] = [transit, walk, bike, citybike, car]

export function clock(iso: string | number) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
