import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import type { Beam, BeamSegment, LngLat } from '../types'

const REVEAL_MS = 1300
const STAGGER_MS = 160
const COMET_FRACTION = 0.14
/** Router geometry has metre-scale zigzags (lane changes, cycle-path hops) that the glow turns into spikes. */
const SIMPLIFY_M = 6
const SMOOTH_PASSES = 2

interface Path {
  coords: LngLat[]
  cum: number[]
  total: number
}

interface BeamState {
  beam: Beam
  /** The beam's segments after smoothing; what actually gets drawn. */
  segs: BeamSegment[]
  segments: Path[]
  path: Path
  /** Where each segment starts along the combined path, in metres. */
  segStart: number[]
  addedAt: number
  revealed: boolean
  cometPeriod: number
}

function measure(coords: LngLat[]): Path {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1]
    const [x2, y2] = coords[i]
    const dx = (x2 - x1) * 111320 * Math.cos(((y1 + y2) / 2) * (Math.PI / 180))
    const dy = (y2 - y1) * 110540
    cum.push(cum[i - 1] + Math.hypot(dx, dy))
  }
  return { coords, cum, total: cum[cum.length - 1] }
}

/** Douglas–Peucker: drop points that sit within `tolerance` metres of the line through their neighbours. */
function simplify(coords: LngLat[], tolerance: number): LngLat[] {
  if (coords.length < 3) return coords
  const kx = 111320 * Math.cos(coords[0][1] * (Math.PI / 180))
  const ky = 110540
  const keep = new Uint8Array(coords.length)
  keep[0] = keep[coords.length - 1] = 1
  const stack: [number, number][] = [[0, coords.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = [coords[a][0] * kx, coords[a][1] * ky]
    const [dx, dy] = [coords[b][0] * kx - ax, coords[b][1] * ky - ay]
    const len2 = dx * dx + dy * dy
    let worst = 0
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = [coords[i][0] * kx - ax, coords[i][1] * ky - ay]
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0
      const dist = Math.hypot(px - t * dx, py - t * dy)
      if (dist > worst) {
        worst = dist
        index = i
      }
    }
    if (worst > tolerance) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  return coords.filter((_, i) => keep[i])
}

/** Chaikin corner cutting: rounds every corner while keeping both endpoints, so segments still join up. */
function chaikin(coords: LngLat[], passes: number): LngLat[] {
  let pts = coords
  for (let n = 0; n < passes && pts.length > 2; n++) {
    const out: LngLat[] = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[i + 1]
      if (i > 0) out.push([x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25])
      if (i < pts.length - 2) out.push([x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75])
    }
    out.push(pts[pts.length - 1])
    pts = out
  }
  return pts
}

const smoothLine = (coords: LngLat[]) => chaikin(simplify(coords, SIMPLIFY_M), SMOOTH_PASSES)

function pointAt(p: Path, d: number): LngLat {
  let i = p.cum.findIndex((c) => c >= d)
  if (i <= 0) return p.coords[Math.max(0, i)]
  const t = (d - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1)
  const [x1, y1] = p.coords[i - 1]
  const [x2, y2] = p.coords[i]
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]
}

/** The part of a path between two distances along it. */
function slice(p: Path, from: number, to: number): LngLat[] {
  from = Math.max(0, from)
  to = Math.min(p.total, to)
  if (to <= from) return []
  const out: LngLat[] = [pointAt(p, from)]
  for (let i = 0; i < p.coords.length; i++) if (p.cum[i] > from && p.cum[i] < to) out.push(p.coords[i])
  out.push(pointAt(p, to))
  return out
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
/** A FeatureCollection of the given lines, skipping any too short to draw. */
const lines = (items: { coords: LngLat[]; props?: Record<string, unknown> }[]) => ({
  type: 'FeatureCollection' as const,
  features: items
    .filter((l) => l.coords.length > 1)
    .map((l) => ({ type: 'Feature' as const, properties: l.props ?? {}, geometry: { type: 'LineString' as const, coordinates: l.coords } })),
})

/** The layer that beams (and 3D buildings) go beneath: above every road/rail line, below place labels. */
export function labelAnchor(map: MlMap) {
  const layers = map.getStyle().layers
  const lastLine = layers.findLastIndex((l) => (l.type === 'line' || l.type === 'fill') && !l.id.startsWith('beam-'))
  return layers.slice(lastLine + 1).find((l) => l.type === 'symbol')?.id
}

/** Draws routes as glowing lines that shoot out from the origin, then carry a travelling light pulse. */
export class BeamRenderer {
  private beams = new Map<string, BeamState>()
  private highlight: string | null = null
  private frame = 0

  constructor(private map: MlMap) {
    this.frame = requestAnimationFrame(this.tick)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    for (const id of [...this.beams.keys()]) this.remove(id)
  }

  setBeams(beams: Beam[]) {
    const next = new Set(beams.map((b) => b.id))
    for (const id of [...this.beams.keys()]) if (!next.has(id)) this.remove(id)
    const now = performance.now()
    let fresh = 0
    for (const beam of beams) {
      const existing = this.beams.get(beam.id)
      if (existing?.beam === beam) continue
      if (existing) this.remove(beam.id)
      this.add(beam, now + fresh++ * STAGGER_MS)
    }
    this.applyHighlight()
  }

  setHighlight(id: string | null) {
    this.highlight = id
    this.applyHighlight()
  }

  private add(beam: Beam, addedAt: number) {
    const segs = beam.segments.map((s) => ({ ...s, coords: smoothLine(s.coords) }))
    const segments = segs.map((s) => measure(s.coords))
    const segStart: number[] = []
    let acc = 0
    for (const s of segments) {
      segStart.push(acc)
      acc += s.total
    }
    const path = measure(segs.flatMap((s) => s.coords))
    const state: BeamState = {
      beam, segs, segments, path, segStart, addedAt, revealed: false,
      cometPeriod: Math.min(6000, Math.max(2600, path.total * 0.6)),
    }
    this.beams.set(beam.id, state)

    const id = `beam-${beam.id}`
    const before = labelAnchor(this.map)
    const main = beam.segments.find((s) => !s.dashed) ?? beam.segments[0]
    // The travelling pulse glows in the halo colour, so a dark beam (Uber grey) still shows it.
    const color = main?.glow ?? main?.color ?? '#fff'
    const empty = { type: 'FeatureCollection' as const, features: [] }
    this.map.addSource(id, { type: 'geojson', data: empty })
    this.map.addSource(`${id}-comet`, { type: 'geojson', data: empty, lineMetrics: true })

    const offset = beam.offset
    const lineLayout = { 'line-cap': 'round' as const, 'line-join': 'round' as const }
    this.map.addLayer({
      id: `${id}-glow`, type: 'line', source: id, layout: lineLayout,
      paint: { 'line-color': ['coalesce', ['get', 'glow'], ['get', 'color']], 'line-width': 16, 'line-blur': 12, 'line-opacity': 0.4, 'line-offset': offset },
    }, before)
    this.map.addLayer({
      id: `${id}-core`, type: 'line', source: id, layout: lineLayout, filter: ['!=', ['get', 'dashed'], true],
      paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.95, 'line-offset': offset },
    }, before)
    this.map.addLayer({
      id: `${id}-dash`, type: 'line', source: id, filter: ['==', ['get', 'dashed'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [0.1, 2], 'line-opacity': 0.9, 'line-offset': offset },
    }, before)
    this.map.addLayer({
      id: `${id}-comet-glow`, type: 'line', source: `${id}-comet`, layout: lineLayout,
      paint: {
        'line-width': 18, 'line-blur': 10, 'line-offset': offset,
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(0,0,0,0)', 1, color],
      },
    }, before)
    this.map.addLayer({
      id: `${id}-comet`, type: 'line', source: `${id}-comet`, layout: lineLayout,
      paint: {
        'line-width': 5, 'line-offset': offset,
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(255,255,255,0)', 1, 'rgba(255,255,255,1)'],
      },
    }, before)
  }

  private remove(beamId: string) {
    const id = `beam-${beamId}`
    for (const suffix of ['-comet', '-comet-glow', '-dash', '-core', '-glow']) {
      if (this.map.getLayer(id + suffix)) this.map.removeLayer(id + suffix)
    }
    if (this.map.getSource(`${id}-comet`)) this.map.removeSource(`${id}-comet`)
    if (this.map.getSource(id)) this.map.removeSource(id)
    this.beams.delete(beamId)
  }

  private visible(s: BeamState) {
    return !s.beam.secondary || this.highlight === s.beam.id
  }

  private applyHighlight() {
    for (const s of this.beams.values()) {
      const id = `beam-${s.beam.id}`
      const dim = this.highlight !== null && this.highlight !== s.beam.id
      const focus = this.highlight === s.beam.id
      const vis = this.visible(s) ? 'visible' : 'none'
      for (const suffix of ['-glow', '-core', '-dash', '-comet', '-comet-glow']) {
        this.map.setLayoutProperty(id + suffix, 'visibility', suffix.startsWith('-comet') && dim ? 'none' : vis)
      }
      this.map.setPaintProperty(`${id}-glow`, 'line-opacity', dim ? 0.06 : focus ? 0.7 : 0.4)
      this.map.setPaintProperty(`${id}-core`, 'line-opacity', dim ? 0.18 : 0.95)
      this.map.setPaintProperty(`${id}-dash`, 'line-opacity', dim ? 0.18 : 0.9)
      this.map.setPaintProperty(`${id}-core`, 'line-width', focus ? 6 : 4)
      this.map.setPaintProperty(`${id}-glow`, 'line-width', focus ? 24 : 16)
      if (focus) for (const suffix of ['-glow', '-core', '-dash', '-comet-glow', '-comet']) this.map.moveLayer(id + suffix, labelAnchor(this.map))
    }
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick)
    for (const s of this.beams.values()) {
      const elapsed = now - s.addedAt
      if (elapsed < 0) continue
      const id = `beam-${s.beam.id}`
      if (!s.revealed) {
        const t = easeOut(Math.min(1, elapsed / REVEAL_MS))
        const head = t * s.path.total
        const data = lines(s.segs.map((seg, i) => ({
          coords: slice(s.segments[i], 0, head - s.segStart[i]),
          props: { color: seg.color, glow: seg.glow ?? null, dashed: !!seg.dashed },
        })))
        ;(this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data)
        // While revealing, the comet rides the leading edge of the beam.
        this.setComet(id, s, head)
        if (t >= 1) s.revealed = true
        continue
      }
      if (!this.visible(s)) continue
      const p = ((elapsed - REVEAL_MS) % s.cometPeriod) / s.cometPeriod
      this.setComet(id, s, easeInOut(p) * s.path.total * (1 + COMET_FRACTION))
    }
  }

  private setComet(id: string, s: BeamState, head: number) {
    const coords = slice(s.path, head - s.path.total * COMET_FRACTION, head)
    ;(this.map.getSource(`${id}-comet`) as GeoJSONSource | undefined)?.setData(lines([{ coords }]))
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
