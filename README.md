# gottamove

A one-screen Helsinki trip comparer. Type a destination (or right-click / long-press the map) and every way to get there lights up as a glowing beam from your location: public transport, walking, own bike, HSL city bike, e-scooter, taxi, Uber and Bolt. Each comes with travel time and price.

## Finding your way

- **3D map:** the map is tilted, and buildings rise to their real heights (from OpenStreetMap) as you zoom in. Routes glow on top of the buildings.
- **Compass** (top right): the red needle always points north. Tap it on a phone to switch to **heading-up mode**: the map turns with the phone so that up is the way you're facing, zoomed in on you in 3D. A light cone on your location dot shows which way the phone points. Tap again, or drag the map, to go back. On iPhone the first tap asks for motion access. Laptops have no compass, so the map stays north-up.
- **Live location:** the blue dot follows you as you move, gliding between GPS fixes. In heading-up mode the map stays centred on you. Routes keep their starting point while you walk, so they aren't re-fetched with every fix. Picking a new destination plans from where you are now. If you drag the dot to plan from somewhere else, tap the locate button (under the zoom buttons) to go back to your real position. It also re-centres the map on you.
- **Mix:** the third tab next to Fastest and Cheapest lists trips that combine modes, fastest first: a scooter to the metro (or from the last stop), your own bike to a station's bike park, or an HSL city bike to and from public transport. Each card says how much sooner it gets there than public transport alone, and the map shows just those routes. HSL's planner has no scooter data, so scooter legs are bike routes, timed at bike speed.
- **Focus on one option:** double-tap an option card to show only that route. The options panel slides away, the map zooms to fit the route, and the direction banner follows it. Tap **Show all options** (or press Esc) to bring everything back.
- **Direction banner:** follows your progress along the option you tap (the fastest one until you choose). It points the way from where you are right now. With a live compass it says "Straight ahead", "Turn left", "Turn around" and so on; otherwise "Head north-east". It counts down each leg ("Walk 240 m to Ylioppilastalo"), says how to board near a stop ("Take tram 4 from Ylioppilastalo at 09:11") and says when you've arrived. More than 40 m off the route, it points you back and offers **Re-route**.

## Setup

```bash
npm install
cp .env.example .env   # then paste your key into DIGITRANSIT_KEY
npm run dev
```

Get a free Digitransit key at <https://portal-api.digitransit.fi>. The Vite dev/preview proxy attaches the key server-side (`vite.config.ts`), so it never reaches the browser. In production, put the same `/api/digitransit` → `https://api.digitransit.fi` proxy (adding the `digitransit-subscription-key` header) in front of `dist/`.

### Testing on a phone

Phones only allow compass and location access on HTTPS pages, so there's a separate HTTPS dev mode:

```bash
npm run dev:phone
```

Open the `Network:` URL it prints on a phone that's on the same Wi-Fi. Accept the certificate warning (the certificate is self-signed), then tap the compass.

## Data

| What | Source |
|---|---|
| Map | [OpenFreeMap](https://openfreemap.org) dark style, OpenStreetMap / OpenMapTiles vector tiles |
| Search, transit, walk, bike, city bike | [Digitransit](https://digitransit.fi/en/developers/) HSL geocoding + routing v2 (`planConnection`) |
| Spelling correction | `public/helsinki-names.json`: about 41k street, place and station names from OpenStreetMap (rebuild with `npm run build:names`) |
| Car route for taxi / Uber / Bolt | Public [OSRM](https://project-osrm.org) server (OSM data), with Digitransit `CAR` as fallback |
| Transit fare | HSL zone ticket computed from the stops' zones (`src/config/pricing.ts`) |
| Taxi / Uber / Bolt / scooter prices | **Estimates** from typical Helsinki rates in `src/config/pricing.ts`. None of these services has a public price API |

## Layout

- `src/services/compare.ts`: one `TripGroup` per data source. Each group returns normalised `TripOption`s and the `Beam` geometry to draw
- `src/map/beams.ts`: MapLibre beam renderer that handles the glow, core and dashed walking legs, the shoot-out reveal and the travelling light pulse
- `src/services/search.ts`: typo-tolerant search. It merges Digitransit's prefix search with its fuzzy search, ranks the results by similarity to what was typed, and corrects misspellings against the OSM name index ("Toolo" → Töölö, "Kaupatori" → Kauppatori)
- `src/services/heading.ts`: live compass heading from the phone's orientation sensors (iOS and Android), smoothed
- `src/map/MapView.tsx`: 3D buildings, tilted camera, the moving location dot and heading-up following
- `src/map/tracking.ts`: snaps your position onto the chosen route to tell how far along you are, which leg you're on, and which way to go
- `src/components/`: search box with autocomplete, compare panel, option cards, compass and direction banner

## Tests

- `npm run test:search` (with `npm run dev` running) checks 70 misspelled, accent-less and half-typed queries against the live API.
- `npm run test:tracking` checks route tracking: progress along each leg, going off route, arriving, and legs that share a street (walking out to a stop, then riding back past it).
