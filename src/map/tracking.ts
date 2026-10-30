import type { Beam, LngLat } from '../types'

/** Aim this far ahead along the route: past the doorstep, usually before the next turn. */
const LOOKAHEAD_M = 30
/** Further than this from the route and we point back to it instead. */
export const OFF_ROUTE_M = 40
const ARRIVED_M = 25

export interface RouteProgress {
  /** Metres along the route of the point nearest the user. */
  along: number
  total: number
  /** How far the user is from the route, in metres. */
  offRoute: number
  /** Index of the beam segment (trip leg) the user is on. */
  segment: number
  /** Metres covered of that segment, and metres left in it. */
  segmentDone: number
  segmentLeft: number
  /** Compass bearing to head in right now. */
  bearing: number
  arrived: boolean
}

interface Edge {
  a: [number, number]
  b: [number, number]
  len: number
  start: number
  segment: number
}

/**
 * Where the user is along a route. `lastAlong` is the previous result: matches far behind it, or
 * far ahead of it, are penalised so that legs sharing a street (walk out to a stop, ride back past it)
 * don't make the position jump.
 */
export function trackRoute(beam: Beam, user: LngLat, lastAlong = 0): RouteProgress | null {
  // Local metres around the user (x east, y north); plenty accurate across a city.
  const kx = 111320 * Math.cos(user[1] * (Math.PI / 180))
  const ky = 110540
  const xy = (c: LngLat): [number, number] => [(c[0] - user[0]) * kx, (c[1] - user[1]) * ky]

  const edges: Edge[] = []
  const segStart: number[] = []
  const segEnd: number[] = []
  let total = 0
  beam.segments.forEach((s, segment) => {
    segStart.push(total)
    for (let i = 1; i < s.coords.length; i++) {
      const a = xy(s.coords[i - 1])
      const b = xy(s.coords[i])
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len === 0) continue
      edges.push({ a, b, len, start: total, segment })
      total += len
    }
    segEnd.push(total)
  })
  if (!edges.length) return null

  let best = { score: Infinity, along: 0, off: 0, segment: 0, p: [0, 0] as [number, number] }
  for (const e of edges) {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    // The user is at (0, 0) in local coordinates.
    const t = Math.max(0, Math.min(1, -(e.a[0] * dx + e.a[1] * dy) / (e.len * e.len)))
    const p: [number, number] = [e.a[0] + dx * t, e.a[1] + dy * t]
    const off = Math.hypot(p[0], p[1])
    const along = e.start + e.len * t
    const penalty = Math.max(0, lastAlong - 40 - along) * 0.5 + Math.max(0, along - lastAlong - 150) * 0.3
    if (off + penalty < best.score) best = { score: off + penalty, along, off, segment: e.segment, p }
  }

  const pointAt = (d: number): [number, number] => {
    const e = edges.find((x) => x.start + x.len >= d) ?? edges[edges.length - 1]
    const t = Math.max(0, Math.min(1, (d - e.start) / e.len))
    return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]
  }
  // Off the route: head back to it. On it: head for a point a little further along.
  const target = best.off > OFF_ROUTE_M ? best.p : pointAt(Math.min(total, best.along + LOOKAHEAD_M))
  const bearing = (Math.atan2(target[0], target[1]) / (Math.PI / 180) + 360) % 360

  return {
    along: best.along,
    total,
    offRoute: best.off,
    segment: best.segment,
    segmentDone: best.along - segStart[best.segment],
    segmentLeft: segEnd[best.segment] - best.along,
    bearing,
    arrived: total - best.along < ARRIVED_M && best.off < OFF_ROUTE_M,
  }
}
