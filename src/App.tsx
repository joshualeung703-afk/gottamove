import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ComparePanel, type GroupState, type View } from './components/ComparePanel'
import { Compass } from './components/Compass'
import { Guidance } from './components/Guidance'
import { SearchBox } from './components/SearchBox'
import { distanceMeters } from './map/geo'
import { MapView, type CompassMode } from './map/MapView'
import { trackRoute } from './map/tracking'
import { TRIP_GROUPS, type GroupKey } from './services/compare'
import { ApiKeyError, reverseGeocode } from './services/digitransit'
import { HELSINKI_CENTRAL, watchLocation } from './services/geolocation'
import { compassNeedsPermission, requestCompassPermission, watchHeading } from './services/heading'
import type { Beam, LngLat, Place } from './types'

type Results = Partial<Record<GroupKey, GroupState & { beams?: Beam[] }>>

/**
 * Where routes start from:
 * live     – the user's real location (fixed when the routes were fetched; the dot keeps moving)
 * fallback – Helsinki Central Station, while there's no location
 * manual   – a spot the user dragged the dot to
 */
type StartKind = 'live' | 'fallback' | 'manual'

/** Without a location fix by now, start from the default so the app is still usable. */
const LOCATION_FALLBACK_MS = 8000
/** If no compass reading arrives this soon after asking, the device has no compass (most laptops). */
const COMPASS_TIMEOUT_MS = 2500

export default function App() {
  const [origin, setOrigin] = useState<Place | null>(null)
  const [startKind, setStartKind] = useState<StartKind>('fallback')
  /** Live GPS position, updated as the user moves. */
  const [position, setPosition] = useState<LngLat | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [destination, setDestination] = useState<Place | null>(null)
  const [results, setResults] = useState<Results>({})
  const [view, setView] = useState<View>('fastest')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** Double-tapped option: only its route is drawn and the options panel steps aside. */
  const [focused, setFocused] = useState<string | null>(null)
  const [compassMode, setCompassMode] = useState<CompassMode>('north')
  const [heading, setHeading] = useState<number | null>(null)
  const [bearing, setBearing] = useState(0)
  const headingRef = useRef(heading)
  headingRef.current = heading
  const stopHeading = useRef<(() => void) | null>(null)
  // Latest values for callbacks that outlive a render (location fixes, map gestures).
  const latest = useRef({ origin, startKind, position })
  latest.current = { origin, startKind, position }
  /** The next fix becomes the route start (at launch, or after "Use my location"). */
  const nextFixIsStart = useRef(true)
  const stopLocation = useRef<(() => void) | null>(null)

  const startHeading = useCallback(() => {
    stopHeading.current ??= watchHeading(setHeading)
  }, [])

  // Where no permission prompt is needed (Android), listen straight away so the location dot shows which way you face.
  useEffect(() => {
    if (!compassNeedsPermission()) startHeading()
    return () => {
      stopHeading.current?.()
      stopHeading.current = null
    }
  }, [startHeading])

  const startLocation = useCallback(() => {
    stopLocation.current?.()
    stopLocation.current = watchLocation(
      (coord) => {
        setPosition(coord)
        if (!nextFixIsStart.current) return
        nextFixIsStart.current = false
        setOrigin({ coord, label: 'Your location' })
        setStartKind('live')
      },
      (status) => {
        if (status !== 'denied' && status !== 'outside') return
        if (!latest.current.origin) setOrigin(HELSINKI_CENTRAL)
        setNotice(
          status === 'denied'
            ? 'Location access denied — starting from Helsinki Central Station. Drag the blue dot to move it.'
            : "You're outside the Helsinki area — starting from Helsinki Central Station.",
        )
      },
    )
  }, [])

  useEffect(() => {
    startLocation()
    const timer = setTimeout(() => {
      if (latest.current.origin) return
      setOrigin(HELSINKI_CENTRAL)
      setNotice("Still looking for your location — starting from Helsinki Central Station for now.")
    }, LOCATION_FALLBACK_MS)
    return () => {
      clearTimeout(timer)
      stopLocation.current?.()
      stopLocation.current = null
    }
  }, [startLocation])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [notice])

  // A new destination starts a fresh choice; re-routing from a new start keeps the chosen option.
  useEffect(() => {
    setHighlight(null)
    setSelected(null)
    setFocused(null)
  }, [destination])

  useEffect(() => {
    if (!origin || !destination) return
    const ctrl = new AbortController()
    setResults(Object.fromEntries(TRIP_GROUPS.map((g) => [g.key, { status: 'loading' }])))
    for (const group of TRIP_GROUPS) {
      group
        .run(origin, destination, ctrl.signal)
        .then((r) => !ctrl.signal.aborted && setResults((prev) => ({ ...prev, [group.key]: { status: 'done', options: r.options, beams: r.beams } })))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return
          const error = e instanceof ApiKeyError ? 'Digitransit API key missing or invalid (see .env)' : e instanceof Error ? e.message : 'Failed'
          setResults((prev) => ({ ...prev, [group.key]: { status: 'error', error } }))
        })
    }
    return () => ctrl.abort()
  }, [origin, destination])

  // The Mix tab shows only the mixed trips, the other tabs everything else; the map, focus and guidance follow suit.
  const shownGroups = useMemo(() => TRIP_GROUPS.filter((g) => !!g.mix === (view === 'mix')), [view])
  const beams = useMemo(
    () => shownGroups.flatMap((g) => results[g.key]?.beams ?? []),
    [shownGroups, results],
  )
  const options = useMemo(
    () => shownGroups.flatMap((g) => {
      const r = results[g.key]
      return r?.status === 'done' ? r.options : []
    }),
    [shownGroups, results],
  )

  const focusedOption = focused ? options.find((o) => o.id === focused) : undefined
  // While focused, draw only that route (nothing until it reloads, e.g. after a re-route).
  const visibleBeams = useMemo(
    () => (focused ? beams.filter((b) => b.id === focusedOption?.beamId) : beams),
    [beams, focused, focusedOption],
  )
  const highlightBeam = useMemo(() => {
    if (focused) return focusedOption?.beamId ?? null
    const id = highlight ?? selected
    return options.find((o) => o.id === id)?.beamId ?? null
  }, [focused, focusedOption, highlight, selected, options])

  // If a re-route no longer offers the focused option, show everything again rather than an empty map.
  const loading = Object.values(results).some((r) => r?.status === 'loading')
  useEffect(() => {
    if (focused && !focusedOption && !loading) setFocused(null)
  }, [focused, focusedOption, loading])

  const focusOption = useCallback((id: string) => {
    setSelected(id)
    setHighlight(null)
    setFocused(id)
  }, [])
  const unfocus = useCallback(() => setFocused(null), [])
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFocused(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])

  /** The dot: the live position while routing from it, otherwise the route start. */
  const userCoord = startKind === 'live' && position ? position : (origin?.coord ?? null)

  // Where the user is along the chosen option (or the fastest one until something is chosen), as they move.
  const progressMemo = useRef({ key: '', along: 0 })
  const guide = useMemo(() => {
    if (!userCoord) return null
    // Ties go to the cheaper option, as in the panel (a scooter and a bike often share one mixed route).
    const option = options.find((o) => o.id === selected) ?? [...options].sort((a, b) => a.durationMin - b.durationMin || a.priceMin - b.priceMin)[0]
    const beam = beams.find((b) => b.id === option?.beamId)
    if (!option || !beam) return null
    // Remember progress per route, so legs that share a street don't make the position jump back and forth.
    const key = `${option.id}@${beam.segments[0]?.coords[0]?.join()}`
    const last = progressMemo.current.key === key ? progressMemo.current.along : 0
    const progress = trackRoute(beam, userCoord, last)
    if (!progress) return null
    progressMemo.current = { key, along: progress.along }
    return { option, progress }
  }, [userCoord, options, beams, selected])

  const onCompassClick = async () => {
    if (compassMode !== 'north') return setCompassMode('north')
    // iOS asks for compass access here; this has to run straight from the tap.
    if (!(await requestCompassPermission())) return setNotice("Couldn't use this device's compass, so the map stays north-up. The red needle always points north.")
    startHeading()
    setCompassMode('heading')
    window.setTimeout(() => {
      if (headingRef.current !== null) return
      setCompassMode('north')
      setNotice("This device has no compass, so the map stays north-up. The red needle always points north.")
    }, COMPASS_TIMEOUT_MS)
  }

  // Rotating by hand leaves north-up; panning away leaves heading-up (it would just snap back otherwise).
  const onUserMove = useCallback((kind: 'rotate' | 'pan') => {
    setCompassMode((mode) => (kind === 'rotate' || mode === 'heading' ? 'free' : mode))
  }, [])

  /** Plan from where the user is now, not where they were when the app opened. */
  const chooseDestination = useCallback((place: Place) => {
    const { startKind, position, origin } = latest.current
    if (startKind === 'live' && position && (!origin || distanceMeters(position, origin.coord) > 30)) {
      setOrigin({ coord: position, label: 'Your location' })
    }
    setDestination(place)
  }, [])
  const pick = useCallback(async (coord: LngLat) => chooseDestination(await reverseGeocode(coord)), [chooseDestination])

  const reroute = useCallback(() => {
    const { position } = latest.current
    if (position) setOrigin({ coord: position, label: 'Your location' })
  }, [])

  /** Back to the real location after dragging the start or being denied: asks again if needed. */
  const locateMe = useCallback(() => {
    const { position } = latest.current
    nextFixIsStart.current = !position
    if (position) {
      setOrigin({ coord: position, label: 'Your location' })
      setStartKind('live')
    }
    startLocation()
  }, [startLocation])

  // The locate button always re-centres the map; it only re-plans when routes don't already start from the live location.
  const locate = useCallback(() => {
    if (latest.current.startKind !== 'live') locateMe()
  }, [locateMe])

  const moveOrigin = useCallback((coord: LngLat) => {
    nextFixIsStart.current = false
    setStartKind('manual')
    setOrigin({ coord, label: 'Chosen start', sublabel: `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}` })
  }, [])
  const clear = useCallback(() => {
    setDestination(null)
    setResults({})
  }, [])

  return (
    <div className="app">
      <MapView
        origin={origin}
        userCoord={userCoord}
        destination={destination}
        beams={destination ? visibleBeams : []}
        highlightBeam={highlightBeam}
        panelOpen={!focused}
        compassMode={compassMode}
        heading={heading}
        onOriginMove={moveOrigin}
        onPick={pick}
        onBearingChange={setBearing}
        onUserMove={onUserMove}
        onLocate={locate}
        locationLive={startKind === 'live'}
      />
      <SearchBox destination={destination} onSelect={chooseDestination} onClear={clear} />
      <Compass bearing={bearing} mode={compassMode} onClick={onCompassClick} />
      {destination && guide && (
        <Guidance
          option={guide.option}
          progress={guide.progress}
          mapBearing={bearing}
          heading={heading}
          onReroute={startKind === 'live' && position ? reroute : undefined}
        />
      )}
      {focused && (
        <button className="focus-exit" onClick={unfocus}>
          <span aria-hidden>☰</span> Show all options
        </button>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      <ComparePanel
        destination={destination}
        groups={shownGroups}
        states={results}
        view={view}
        onViewChange={setView}
        highlight={highlight}
        selected={selected}
        onHighlight={setHighlight}
        onSelect={setSelected}
        onFocusOption={focusOption}
        hidden={!!focused}
      />
    </div>
  )
}
