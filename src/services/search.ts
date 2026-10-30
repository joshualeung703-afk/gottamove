// Typo-tolerant place search. Digitransit's autocomplete only does prefix matching, so every query also
// goes to its fuzzy full-text search; results are merged and ranked by how closely they match what was typed.
// When nothing matches well, the query is corrected against an OpenStreetMap name index and searched again.
// Only type imports here, so the test script can run this file directly with Node.
import type { LngLat, Place } from '../types'

export interface GeoFeature {
  geometry: { coordinates: LngLat }
  properties: { label: string; name: string; locality?: string; layer: string }
}

export interface SearchDeps {
  fetchFeatures: (endpoint: 'autocomplete' | 'search', text: string, signal?: AbortSignal) => Promise<GeoFeature[]>
  loadNames: () => Promise<string[]>
}

export interface SearchResult {
  places: Place[]
  /** Set when results are for a corrected spelling, e.g. "Toolo" → "Töölö". */
  correctedTo?: string
}

const LAYER_NAMES: Record<string, string> = {
  stop: 'Stop', station: 'Station', venue: 'Place', address: 'Address', street: 'Street',
  neighbourhood: 'Area', localadmin: 'Area', locality: 'City', bikestation: 'City bike station',
}

/** Lowercase, strip diacritics (ä→a, ö→o, å→a) and punctuation. */
export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Fredrikinktu 20 B" → { core: "Fredrikinktu", number: "20 B" } */
export function splitHouseNumber(text: string) {
  const m = text.trim().match(/^(.*?\D)\s+(\d.*)$/)
  return m ? { core: m[1].trim(), number: m[2].trim() } : { core: text.trim(), number: '' }
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions), giving up above `max`. */
export function editDistance(a: string, b: string, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur.push(v)
      rowMin = Math.min(rowMin, v)
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[b.length]
}

/**
 * How well a (normalised) query matches a (normalised) name, 0–1. Allows for the user still typing
 * (compares against prefixes) and for the query matching a later word ("Central Station" in "Olivia Central Station").
 */
export function similarity(q: string, n: string) {
  if (!q || !n) return 0
  const starts = [0]
  for (let i = 1; i < n.length; i++) if (n[i - 1] === ' ') starts.push(i)
  let best = 0
  for (const start of starts) {
    const s = n.slice(start)
    const penalty = start ? 0.06 : 0
    if (s.startsWith(q)) {
      // Prefix scores stay below an exact match even after the autocomplete bonus.
      best = Math.max(best, (s.length === q.length ? 1 : 0.96) - penalty)
      continue
    }
    const max = Math.max(1, Math.floor(q.length / 3))
    // A whole-word match beats matching just the beginning of a longer name.
    const whole = editDistance(q, s, max)
    if (whole <= max) best = Math.max(best, 1 - whole / Math.max(q.length, 3) + 0.04 - penalty)
    for (let len = Math.max(1, q.length - 1); len <= Math.min(s.length, q.length + 2); len++) {
      const d = editDistance(q, s.slice(0, len), max)
      if (d <= max) best = Math.max(best, 1 - d / Math.max(q.length, 3) - 0.01 - penalty)
    }
  }
  return Math.min(1, best)
}

export function toPlace(f: GeoFeature): Place {
  const { name, label, locality, layer } = f.properties
  const where = locality ?? label.replace(`${name}, `, '')
  const kind = LAYER_NAMES[layer]
  return { coord: f.geometry.coordinates, label: name, sublabel: kind ? `${kind} · ${where}` : where }
}

interface Scored {
  feature: GeoFeature
  score: number
}

function rank(sources: { features: GeoFeature[]; bonus: number }[], core: string, hasNumber: boolean): Scored[] {
  const q = normalize(core)
  const scored = sources.flatMap(({ features, bonus }) =>
    features.map((feature) => {
      const { name, layer } = feature.properties
      // Addresses only lead when the user typed a house number.
      const layerAdj = layer === 'address' ? (hasNumber ? 0.04 : -0.08) : 0
      return { feature, score: similarity(q, normalize(name)) + bonus + layerAdj }
    }),
  )
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  let addresses = 0
  return scored.filter(({ feature, score }) => {
    const p = toPlace(feature)
    const key = `${p.label}|${p.sublabel}`
    if (seen.has(key)) return false
    seen.add(key)
    if (score < 0.4 && scored[0].score >= 0.6) return false
    if (!hasNumber && feature.properties.layer === 'address' && ++addresses > 3) return false
    return true
  })
}

interface NameIndex {
  names: string[]
  normalized: string[]
}

/** Closest OSM name to the query, comparing whole names and name prefixes. */
export function correctSpelling(core: string, index: NameIndex): { name: string; score: number } | null {
  const q = normalize(core)
  if (q.length < 3) return null
  const max = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3
  let best: { name: string; score: number } | null = null
  for (let i = 0; i < index.names.length; i++) {
    const n = index.normalized[i]
    if (Math.abs(n.length - q.length) > max && n.length < q.length) continue
    const whole = editDistance(q, n, max)
    const prefix = n.length > q.length ? editDistance(q, n.slice(0, q.length), max) : max + 1
    const d = Math.min(whole, prefix + 0.5) // prefer the full word over a longer name that starts similarly
    if (d > max) continue
    // Exact match apart from accents ("toolo" → "Töölö") ranks just below a true exact match.
    const score = 1 - d / Math.max(q.length, 3) - (d === 0 && index.names[i].toLowerCase() !== core.toLowerCase() ? 0.001 : 0)
    if (!best || score > best.score || (score === best.score && index.names[i].length < best.name.length)) {
      best = { name: index.names[i], score }
    }
  }
  return best
}

export function createSearch({ fetchFeatures, loadNames }: SearchDeps) {
  let index: Promise<NameIndex> | null = null
  const getIndex = () =>
    (index ??= loadNames().then((names) => ({ names, normalized: names.map(normalize) })).catch((e) => {
      index = null
      throw e
    }))

  const fetchBoth = async (text: string, signal?: AbortSignal) => {
    const [auto, fuzzy] = await Promise.all([
      fetchFeatures('autocomplete', text, signal),
      // The fuzzy search is a bonus: if it fails (e.g. rate-limited), still show the autocomplete hits.
      text.length >= 3 ? fetchFeatures('search', text, signal).catch(() => []) : Promise.resolve([]),
    ])
    return [{ features: auto, bonus: 0.03 }, { features: fuzzy, bonus: 0 }]
  }

  async function search(text: string, signal?: AbortSignal): Promise<SearchResult> {
    const { core, number } = splitHouseNumber(text)
    const sources = await fetchBoth(text, signal)
    let ranked = rank(sources, core, !!number)
    const q = normalize(core)

    // Unless the best hit already starts with what was typed, also search for the closest OSM name
    // ("Toolo" → "Töölö", "Kamppii" → "Kamppi") and rank everything against the original text.
    if (!ranked.length || !ranked[0].feature.properties.name.toLowerCase().startsWith(core.toLowerCase())) {
      const fix = correctSpelling(core, await getIndex())
      if (fix && fix.score >= 0.6 && fix.name.toLowerCase() !== core.toLowerCase()) {
        const more = await fetchBoth(number ? `${fix.name} ${number}` : fix.name, signal)
        ranked = rank([...more, ...sources], core, !!number)
      }
    }

    // Tell the user when the top result is a different spelling from what they typed.
    const top = ranked[0]?.feature.properties.name
    let correctedTo: string | undefined
    if (top && !top.toLowerCase().includes(core.toLowerCase()) && similarity(q, normalize(top)) >= 0.6) {
      correctedTo = number && !/\d/.test(top) ? `${top} ${number}` : top
    }
    return { places: ranked.slice(0, 8).map((s) => toPlace(s.feature)), correctedTo }
  }

  return { search, preload: () => void getIndex().catch(() => {}) }
}
