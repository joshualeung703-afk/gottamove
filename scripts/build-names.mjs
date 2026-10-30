// Builds public/helsinki-names.json: every street, place, station and attraction name in the HSL area
// from OpenStreetMap (via Overpass). The search uses it to correct misspelled queries.
// Run: node scripts/build-names.mjs
import { writeFile } from 'node:fs/promises'

// Matches HSL_BOUNDS in src/services/digitransit.ts. Fetched in tiles: one query for the whole
// region is heavy enough that busy public servers time out on it.
const BOUNDS = { south: 59.9, west: 24.2, north: 60.5, east: 25.6 }
const ROWS = 3
const COLS = 4

const queryFor = (bbox) => `[out:json][timeout:90];
(
  way["highway"]["name"](${bbox});
  nwr["place"]["name"](${bbox});
  nwr["railway"~"^(station|halt)$"]["name"](${bbox});
  nwr["public_transport"="station"]["name"](${bbox});
  nwr["tourism"~"^(attraction|museum|gallery|zoo|theme_park|viewpoint)$"]["name"](${bbox});
  nwr["leisure"~"^(park|stadium|sports_centre)$"]["name"](${bbox});
  nwr["amenity"~"^(library|university|college|hospital|theatre|arts_centre|ferry_terminal)$"]["name"](${bbox});
  nwr["shop"="mall"]["name"](${bbox});
);
out tags;`

// The public servers are often busy, so try each mirror with a short backoff.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

async function overpass(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gottamove-name-index' },
          body: new URLSearchParams({ data: query }),
          // A stalled request shouldn't hang the whole run.
          signal: AbortSignal.timeout(120_000),
        })
        if (res.ok) return await res.json()
        console.warn(`  ${url}: HTTP ${res.status}`)
      } catch (e) {
        console.warn(`  ${url}: ${e.message}`)
      }
    }
    await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt))
  }
  throw new Error('All Overpass mirrors failed')
}

const names = new Set()
let elementCount = 0
const latStep = (BOUNDS.north - BOUNDS.south) / ROWS
const lonStep = (BOUNDS.east - BOUNDS.west) / COLS
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const south = BOUNDS.south + row * latStep
    const west = BOUNDS.west + col * lonStep
    const bbox = [south, west, south + latStep, west + lonStep].map((v) => v.toFixed(4)).join(',')
    const { elements } = await overpass(queryFor(bbox))
    elementCount += elements.length
    for (const { tags } of elements) {
      for (const key of ['name', 'name:sv', 'name:en']) {
        const n = tags[key]?.trim()
        if (n && n.length >= 3 && n.length <= 60 && !/^\d/.test(n)) names.add(n)
      }
    }
    console.log(`tile ${row * COLS + col + 1}/${ROWS * COLS}: ${elements.length} elements, ${names.size} names so far`)
  }
}
const sorted = [...names].sort((a, b) => a.localeCompare(b, 'fi'))
await writeFile(new URL('../public/helsinki-names.json', import.meta.url), JSON.stringify(sorted))
console.log(`${elementCount} OSM elements → ${sorted.length} unique names`)
