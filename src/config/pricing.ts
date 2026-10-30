// All prices in EUR. Ride-hail and scooter operators publish no public price API,
// so these are approximate Helsinki rates — tweak them here as tariffs change.

/** HSL single ticket (mobile app, adult). https://www.hsl.fi/en/tickets-and-fares */
export const HSL_FARES: Record<string, number> = {
  AB: 3.2,
  BC: 3.2,
  CD: 3.2,
  ABC: 4.4,
  BCD: 4.4,
  ABCD: 5.2,
}

export interface RideRate {
  base: number
  perKm: number
  perMin: number
  minimum: number
  /** Multipliers applied to the point estimate to show a realistic range (surge, traffic). */
  range: [number, number]
  /** Typical wait for pickup, added to trip time. */
  pickupMin: number
}

export const TAXI_DAY: RideRate = { base: 6.9, perKm: 1.45, perMin: 0.8, minimum: 10, range: [0.9, 1.15], pickupMin: 5 }
// Taxi start fee is higher evenings (20–06) and weekends.
export const TAXI_NIGHT: RideRate = { ...TAXI_DAY, base: 9.9 }
export const UBER: RideRate = { base: 3.6, perKm: 1.15, perMin: 0.35, minimum: 8, range: [0.9, 1.4], pickupMin: 5 }
export const BOLT: RideRate = { base: 2.9, perKm: 1.05, perMin: 0.32, minimum: 7, range: [0.9, 1.4], pickupMin: 5 }

/** Free-flow road times from OSRM are optimistic in the city centre. */
export const TRAFFIC_FACTOR = 1.25

export const SCOOTER = { unlock: 1.0, perMin: 0.3, range: [0.85, 1.2] as [number, number], speedVsBike: 0.85 }

/** One scooter ride, before the `range` spread. */
export const scooterPrice = (min: number) => SCOOTER.unlock + SCOOTER.perMin * min

/** HSL city bikes: day pass covers 30 min rides, €1 for each extra 30 min. Season 1 Apr – 31 Oct. */
export const CITYBIKE = { dayPass: 5, includedMin: 30, extraPer30: 1, season: { fromMonth: 3, toMonth: 9 } }

export const cityBikePrice = (rideMin: number) =>
  CITYBIKE.dayPass + Math.max(0, Math.ceil((rideMin - CITYBIKE.includedMin) / 30)) * CITYBIKE.extraPer30

export function isTaxiNightRate(d = new Date()) {
  const h = d.getHours()
  const day = d.getDay()
  return h < 6 || h >= 20 || day === 0 || day === 6
}

export function rideEstimate(rate: RideRate, km: number, min: number): [number, number] {
  const point = Math.max(rate.minimum, rate.base + rate.perKm * km + rate.perMin * min)
  return [point * rate.range[0], point * rate.range[1]]
}

/** Smallest contiguous HSL zone ticket covering every zone touched (e.g. A + C → ABC). */
export function hslFare(zones: string[]): { ticket: string; price: number } | null {
  const valid = zones.filter((z) => /^[A-D]$/.test(z)).sort()
  if (!valid.length) return null
  let lo = valid[0].charCodeAt(0)
  let hi = valid[valid.length - 1].charCodeAt(0)
  if (hi === lo) hi === 'D'.charCodeAt(0) ? lo-- : hi++ // tickets cover at least two zones
  let ticket = ''
  for (let c = lo; c <= hi; c++) ticket += String.fromCharCode(c)
  return { ticket, price: HSL_FARES[ticket] ?? HSL_FARES.ABCD }
}
