// Checks that misspelled queries still find the right place. Needs the dev server running (npm run dev),
// since requests go through its Digitransit proxy. Run: npm run test:search
import { readFile } from 'node:fs/promises'
import { createSearch, normalize, type GeoFeature } from '../src/services/search.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const BASE = process.env.DEV_URL ?? 'http://localhost:5173'
const BOUNDS = 'boundary.rect.min_lat=59.9&boundary.rect.max_lat=60.5&boundary.rect.min_lon=24.2&boundary.rect.max_lon=25.6'

const { search } = createSearch({
  async fetchFeatures(endpoint, text) {
    // Digitransit rate-limits bursts, so back off and retry on 429.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/api/digitransit/geocoding/v1/${endpoint}?text=${encodeURIComponent(text)}&lang=en&size=10&${BOUNDS}`)
      if (res.status === 429 && attempt < 5) {
        await sleep(2000 * 2 ** attempt)
        continue
      }
      if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
      return ((await res.json()).features ?? []) as GeoFeature[]
    }
  },
  loadNames: async () => JSON.parse(await readFile(new URL('../public/helsinki-names.json', import.meta.url), 'utf8')),
})

// [what the user types, what the top result's name should start with — or, with a leading '=', exactly be]
const CASES: [string, string][] = [
  // correct spellings must keep working
  ['Kamppi', 'Kamppi'],
  ['Helsinki airport', 'Helsinki Airport'],
  ['Suomenlinna', 'Suomenlinna'],
  ['Bulevardi 10', 'Bulevardi 10'],
  ['Pasila', 'Pasila'],
  // typos
  ['Mannerheimintei 5', 'Mannerheimintie 5'],
  ['Mannerhemintie', 'Mannerheimintie'],
  ['Aleksanterinktu', 'Aleksanterinkatu'],
  ['Fredrikinktu 20', 'Fredrikinkatu 20'],
  ['Suomenlina', 'Suomenlinna'],
  ['Kaupatori', 'Kauppatori'],
  ['Senatintori', 'Senaatintori'],
  ['Stokmann', 'Stockmann'],
  ['Hakanimi', 'Hakaniemi'],
  ['Kalastama', 'Kalasata'],
  ['Kalasatma', 'Kalasata'],
  ['Pasla', 'Pasila'],
  ['Tikurila', '=Tikkurila'],
  ['Lautasaari', 'Lauttasaari'],
  ['Rautatintori', 'Rautatientori'],
  ['Bulevadi 10', 'Bulevardi 10'],
  ['Kampi', 'Kamp'],
  ['Kamppii', '=Kamppi'],
  ['Hämentie 10', 'Hämeentie 10'],
  ['Itäkesus', 'Itäkesku'],
  ['Espalanadi', 'Esplanadi'],
  ['Senaattori', 'Senaatintori'],
  ['Linnanmäkki', 'Linnanmäki'],
  ['Ruoholahdi', 'Ruoholah'],
  ['Herttoniemi', 'Herttoniemi'],
  ['Hertoniemi', 'Herttoniemi'],
  ['Kumpula', 'Kumpula'],
  ['Kumpla', 'Kumpula'],
  ['Arabianranta', 'Arabianranta'],
  ['Arabianrnta', 'Arabianranta'],
  ['Munkkiniemi', 'Munkkiniemi'],
  ['Munkiniemi', 'Munkkiniemi'],
  // missing ä/ö/å
  ['Toolo', '=Töölö'],
  ['Hameentie 10', 'Hämeentie 10'],
  ['Itakeskus', 'Itäkesku'],
  ['Linnanmaki', 'Linnanmäki'],
  ['Kasarmitori', 'Kasarmitori'],
  ['Toolonlahti', 'Töölönlahti'],
  ['Malmi', 'Malmi'],
  ['Kapyla', '=Käpylä'],
  ['Kapyla asema', 'Käpylä'],
  // swapped letters
  ['Kmappi', '=Kamppi'],
  ['Tooolo', 'Töölö'],
  ['Pasilaa', 'Pasila'],
  ['Hakaneimi', 'Hakaniemi'],
  // lowercase, double typos, suburbs
  ['kamppi', 'Kamppi'],
  ['mannerheimintie 5', 'Mannerheimintie 5'],
  ['Suomenlinnna', 'Suomenlinna'],
  ['Kauppatorri', 'Kauppatori'],
  ['Kaivopusto', 'Kaivopuisto'],
  ['Ulanlinna', 'Ullanlinna'],
  ['Kruunuhaka', 'Kruununhaka'],
  ['Vuosari', 'Vuosaari'],
  ['Myyrmaki', 'Myyrmäki'],
  ['Myrmäki', 'Myyrmäki'],
  ['Leppavara', 'Leppävaara'],
  ['Otanemi', 'Otaniemi'],
  ['Matinkyla', 'Matinkylä'],
  ['Lauttsaari', 'Lauttasaari'],
  ['Itakesks', 'Itäkesku'],
  ['Hakaniemen halli', 'Hakaniemen'],
  ['Hakanimen halli', 'Hakaniemen'],
  ['  Pasila  ', 'Pasila'],
  // half-typed
  ['Aleksanter', 'Aleksanter'],
  ['Mannerh', 'Mannerh'],
]

let failed = 0
for (const [query, expected] of CASES) {
  await sleep(400)
  const t0 = performance.now()
  const { places, correctedTo } = await search(query)
  const ms = Math.round(performance.now() - t0)
  const top = places[0] ? `${places[0].label}` : '— nothing —'
  const ok = expected.startsWith('=') ? top === expected.slice(1) : normalize(top).startsWith(normalize(expected))
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${query.padEnd(20)} → ${top}${correctedTo ? `   (showing results for "${correctedTo}")` : ''}  ${ms}ms`)
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`)
process.exit(failed ? 1 : 0)
