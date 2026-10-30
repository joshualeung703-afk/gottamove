import * as maplibregl from 'maplibre-gl'
import { LngLatBounds, type ExpressionSpecification, type Map as MlMap, type Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icons'
import type { Beam, LngLat, Place } from '../types'
import { BeamRenderer, labelAnchor } from './beams'
import { angleDiff } from './geo'

// Bundle MapLibre's worker ourselves so it resolves in both dev and production builds.
maplibregl.setWorkerUrl(workerUrl)

const STYLE = 'https://tiles.openfreemap.org/styles/dark'
const FALLBACK_STYLE = 'https://tiles.openfreemap.org/styles/positron'

/** Tilt for browsing and route overviews; heading-up mode leans in further, like a navigation view. */
const OVERVIEW_PITCH = 50
const HEADING_PITCH = 60
const HEADING_ZOOM = 17
/** How much bigger the near half of a 50°-tilted view draws things; a trip filling the height zooms out ~0.7 levels. */
const TILT_SPREAD = 0.62
/** GPS fixes arrive about once a second; glide the dot between them instead of hopping. */
const MARKER_GLIDE_MS = 900

/**
 * north   – north is up (the default)
 * heading – the map turns with the phone's compass, so up is the way you're facing
 * free    – the user rotated the map by hand
 */
export type CompassMode = 'north' | 'heading' | 'free'

interface Props {
  /** Where the routes start. */
  origin: Place | null
  /** Where to draw the "you are here" dot: the live position, or the route start without one. */
  userCoord: LngLat | null
  destination: Place | null
  beams: Beam[]
  highlightBeam: string | null
  /** False while an option is focused and the options panel is out of the way. */
  panelOpen: boolean
  compassMode: CompassMode
  /** Live device heading in degrees, or null when there's no compass reading. */
  heading: number | null
  onOriginMove: (coord: LngLat) => void
  onPick: (coord: LngLat) => void
  onBearingChange: (bearing: number) => void
  /** The user rotated or panned the map themselves. */
  onUserMove: (kind: 'rotate' | 'pan') => void
  /** Locate button: back to the real location if routes start elsewhere (the map re-centres either way). */
  onLocate: () => void
  /** Routes start from the live GPS position. */
  locationLive: boolean
}

function el(className: string) {
  const div = document.createElement('div')
  div.className = className
  return div
}

/** Room taken by the options panel: on the left on desktop, a bottom sheet on phones (just the exit button when hidden). */
function panelRoom(panelOpen: boolean) {
  const desktop = window.innerWidth >= 768
  if (desktop) return { left: panelOpen ? 400 : 0, bottom: 0 }
  return { left: 0, bottom: panelOpen ? Math.round(window.innerHeight * 0.48) : 70 }
}

function fitPadding(panelOpen: boolean) {
  const room = panelRoom(panelOpen)
  return window.innerWidth >= 768
    ? { top: 110, bottom: 60 + room.bottom, left: 40 + room.left, right: 90 }
    : { top: 150, bottom: 20 + room.bottom, left: 30, right: 70 }
}

/** In heading-up mode, centre the user in the part of the map not covered by the panel and banner. */
function headingPadding(panelOpen: boolean) {
  const room = panelRoom(panelOpen)
  return window.innerWidth >= 768
    ? { top: 100, bottom: 40, left: 40 + room.left, right: 40 }
    : { top: 150, bottom: room.bottom, left: 0, right: 0 }
}

/** Width and height of the bounds in metres, as they'd lie on screen at this bearing. */
function screenExtent(bounds: LngLatBounds, bearing: number) {
  const c = bounds.getCenter()
  const kx = 111320 * Math.cos(c.lat * (Math.PI / 180))
  const b = bearing * (Math.PI / 180)
  const xs: number[] = []
  const ys: number[] = []
  for (const p of [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthWest(), bounds.getSouthEast()]) {
    const [x, y] = [(p.lng - c.lng) * kx, (p.lat - c.lat) * 110540]
    xs.push(x * Math.cos(b) - y * Math.sin(b))
    ys.push(x * Math.sin(b) + y * Math.cos(b))
  }
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
}

/**
 * Frame a trip in the tilted overview. MapLibre sizes the view as if the map were flat, but tilting
 * magnifies the near half of the screen. Only a trip that fills the view top to bottom needs the full
 * correction; a wide, short one (or a single focused route) can stay much closer.
 */
function frame(map: MlMap, bounds: LngLatBounds, maxZoom: number, panelOpen: boolean) {
  const padding = fitPadding(panelOpen)
  const bearing = map.getBearing()
  const cam = map.cameraForBounds(bounds, { padding, absolutePadding: true, bearing })
  if (!cam) return
  const canvas = map.getCanvas()
  const [w, h] = screenExtent(bounds, bearing)
  const fitW = w / Math.max(1, canvas.clientWidth - padding.left - padding.right)
  const fitH = h / Math.max(1, canvas.clientHeight - padding.top - padding.bottom)
  const fill = fitH / Math.max(fitW, fitH, 1e-9)
  const zoomOut = Math.log2(1 + TILT_SPREAD * fill)
  map.easeTo({ ...cam, zoom: Math.min(maxZoom, (cam.zoom ?? map.getZoom()) - zoomOut), pitch: OVERVIEW_PITCH, duration: 1000 })
}

/** Extrude OpenMapTiles buildings by their real heights and add a night sky at the horizon. */
function add3d(map: MlMap) {
  if (map.getSource('openmaptiles') && !map.getLayer('buildings-3d')) {
    const height: ExpressionSpecification = ['coalesce', ['get', 'render_height'], 0]
    map.addLayer({
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], height, 0, '#151a26', 30, '#1e2535', 100, '#2a3449'],
        // Buildings rise out of the ground as you zoom in.
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, height],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-opacity': 0.88,
      },
    }, labelAnchor(map))
  }
  map.setSky({
    'sky-color': '#0b0f17',
    'horizon-color': '#1c2638',
    'fog-color': '#0b0f17',
    'sky-horizon-blend': 0.7,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.5,
    'atmosphere-blend': 0,
  })
}

export function MapView(props: Props) {
  const { origin, userCoord, destination, beams, highlightBeam, panelOpen, compassMode, heading } = props
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const rendererRef = useRef<BeamRenderer | null>(null)
  const userMarker = useRef<Marker | null>(null)
  /** Latest position to show, where the dot currently is, and the glide between them. */
  const userTarget = useRef<LngLat | null>(null)
  const userShown = useRef<LngLat | null>(null)
  const glide = useRef<{ from: LngLat; at: number } | null>(null)
  const dragging = useRef(false)
  const destMarker = useRef<Marker | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: [24.9414, 60.171],
      zoom: 12,
      pitch: OVERVIEW_PITCH,
      maxPitch: 70,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    let fellBack = false
    map.on('error', (e) => {
      // If the dark style itself can't load, retry once with a light OSM style.
      if (!fellBack && !map.isStyleLoaded() && String(e.error?.message ?? '').includes('style')) {
        fellBack = true
        map.setStyle(FALLBACK_STYLE)
      }
    })
    map.on('load', () => {
      add3d(map)
      rendererRef.current = new BeamRenderer(map)
      setReady(true)
    })

    let bearingFrame = 0
    map.on('rotate', () => {
      cancelAnimationFrame(bearingFrame)
      bearingFrame = requestAnimationFrame(() => callbacks.current.onBearingChange(map.getBearing()))
    })
    // Only gestures carry an originalEvent; our own camera moves don't.
    map.on('rotatestart', (e) => e.originalEvent && callbacks.current.onUserMove('rotate'))
    map.on('dragstart', (e) => {
      // A two-finger drag is a pinch-zoom, which shouldn't knock the map out of heading-up mode.
      const touches = (e.originalEvent as TouchEvent | undefined)?.touches
      if (e.originalEvent && !(touches && touches.length > 1)) callbacks.current.onUserMove('pan')
    })

    // Right-click on desktop; on touch screens a long-press (iOS never fires contextmenu, Android does, so dedupe).
    let lastLongPress = 0
    map.on('contextmenu', (e) => {
      if (Date.now() - lastLongPress > 800) callbacks.current.onPick([e.lngLat.lng, e.lngLat.lat])
    })
    let pressTimer = 0
    let pressStart: { x: number; y: number } | null = null
    const cancelPress = () => {
      clearTimeout(pressTimer)
      pressStart = null
    }
    map.on('touchstart', (e) => {
      cancelPress()
      if (e.originalEvent.touches.length !== 1) return
      pressStart = { x: e.point.x, y: e.point.y }
      const { lng, lat } = e.lngLat
      pressTimer = window.setTimeout(() => {
        lastLongPress = Date.now()
        navigator.vibrate?.(15)
        callbacks.current.onPick([lng, lat])
      }, 550)
    })
    map.on('touchmove', (e) => {
      if (pressStart && Math.hypot(e.point.x - pressStart.x, e.point.y - pressStart.y) > 10) cancelPress()
    })
    map.on('touchend', cancelPress)
    map.on('touchcancel', cancelPress)
    map.on('movestart', cancelPress)

    // Rotating the phone changes what the panels cover, so re-centre the heading-up view.
    map.on('resize', () => {
      if (callbacks.current.compassMode === 'heading') map.setPadding(headingPadding(callbacks.current.panelOpen))
    })

    // Every frame: glide the dot towards the latest fix and, in heading-up mode, keep the camera on it.
    let tickFrame = 0
    const tick = (now: number) => {
      tickFrame = requestAnimationFrame(tick)
      const marker = userMarker.current
      const target = userTarget.current
      if (marker && target && !dragging.current) {
        let pos = target
        const g = glide.current
        if (g) {
          const t = Math.min(1, (now - g.at) / MARKER_GLIDE_MS)
          const ease = t * (2 - t)
          pos = [g.from[0] + (target[0] - g.from[0]) * ease, g.from[1] + (target[1] - g.from[1]) * ease]
          if (t >= 1) glide.current = null
        }
        if (pos !== userShown.current) {
          marker.setLngLat(pos)
          userShown.current = pos
        }
      }
      const { compassMode, heading } = callbacks.current
      const you = userShown.current
      // Leave the camera alone during the swing-in animation and pinch-zooms; catch up once it settles.
      if (compassMode !== 'heading' || !you || map.isMoving()) return
      const bearing = heading ?? map.getBearing()
      const c = map.getCenter()
      const drift = Math.hypot((c.lng - you[0]) * 55660, (c.lat - you[1]) * 111320)
      if (drift > 0.5 || Math.abs(angleDiff(map.getBearing(), bearing)) >= 0.5) map.jumpTo({ center: you, bearing })
    }
    tickFrame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(tickFrame)
      cancelAnimationFrame(bearingFrame)
      rendererRef.current?.destroy()
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !userCoord) return
    const { destination, compassMode } = callbacks.current
    if (!userMarker.current) {
      // The marker lies flat on the map and turns with true north, so its cone points the way the phone faces.
      const element = el('user-marker')
      element.append(el('origin-cone'), el('origin-dot'))
      const marker = new maplibregl.Marker({ element, draggable: true, rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat(userCoord)
        .addTo(map)
      marker.on('dragstart', () => {
        dragging.current = true
      })
      marker.on('dragend', () => {
        dragging.current = false
        const { lng, lat } = marker.getLngLat()
        userShown.current = [lng, lat]
        glide.current = null
        callbacks.current.onOriginMove([lng, lat])
      })
      userMarker.current = marker
      userShown.current = userCoord
      if (!destination) map.easeTo({ center: userCoord, zoom: 15, pitch: OVERVIEW_PITCH, duration: 1200 })
    } else if (userShown.current) {
      const from = userShown.current
      glide.current = { from, at: performance.now() }
      // A big jump (location found after starting from the default) deserves a look, unless a trip is on screen.
      const jump = Math.hypot((from[0] - userCoord[0]) * 55660, (from[1] - userCoord[1]) * 111320)
      if (jump > 300 && !destination && compassMode !== 'heading') map.easeTo({ center: userCoord, zoom: 15, duration: 1200 })
    }
    userTarget.current = userCoord
  }, [userCoord])

  useEffect(() => {
    const marker = userMarker.current
    if (!marker) return
    marker.getElement().classList.toggle('has-heading', heading !== null)
    if (heading !== null) marker.setRotation(heading)
  }, [heading, userCoord])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    destMarker.current?.remove()
    destMarker.current = null
    if (!destination) return
    destMarker.current = new maplibregl.Marker({ element: el('dest-pin'), anchor: 'bottom' }).setLngLat(destination.coord).addTo(map)
    // In heading-up mode the camera stays on the user; otherwise frame the trip.
    if (origin && callbacks.current.compassMode !== 'heading') {
      frame(map, new LngLatBounds(origin.coord, origin.coord).extend(destination.coord), 15, callbacks.current.panelOpen)
    }
  }, [destination, origin])

  useEffect(() => {
    if (ready) rendererRef.current?.setBeams(beams)
  }, [beams, ready])

  useEffect(() => {
    if (ready) rendererRef.current?.setHighlight(highlightBeam)
  }, [highlightBeam, ready])

  // Once routes arrive, frame them all (debounced, since groups land one by one). A focused
  // alternative transit option is a "secondary" beam, so fall back to whatever is drawn.
  useEffect(() => {
    const map = mapRef.current
    const primary = beams.filter((b) => !b.secondary)
    const shown = primary.length ? primary : beams
    if (!map || !origin || !shown.length) return
    const timer = setTimeout(() => {
      if (callbacks.current.compassMode === 'heading') return
      const bounds = new LngLatBounds(origin.coord, origin.coord)
      for (const b of shown) for (const s of b.segments) for (const c of s.coords) bounds.extend(c)
      frame(map, bounds, 16, callbacks.current.panelOpen)
    }, 450)
    return () => clearTimeout(timer)
  }, [beams, origin])

  // The panel sliding in or out changes the free space; keep heading-up centred in it.
  useEffect(() => {
    const map = mapRef.current
    if (map && ready && callbacks.current.compassMode === 'heading') map.easeTo({ padding: headingPadding(panelOpen), duration: 400 })
  }, [panelOpen, ready])

  // Switching compass modes: back to north-up, or swing into a heading-up navigation view on the user.
  const prevMode = useRef(compassMode)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || prevMode.current === compassMode) return
    prevMode.current = compassMode
    if (compassMode === 'north') map.easeTo({ bearing: 0, duration: 700 })
    const you = userShown.current
    if (compassMode === 'heading' && you) {
      map.easeTo({
        center: you,
        zoom: Math.max(map.getZoom(), HEADING_ZOOM),
        pitch: HEADING_PITCH,
        bearing: heading ?? map.getBearing(),
        padding: headingPadding(callbacks.current.panelOpen),
        duration: 900,
      })
    }
  }, [compassMode, ready, heading])

  const locate = () => {
    callbacks.current.onLocate()
    const map = mapRef.current
    const you = userShown.current
    // Heading-up already keeps the camera on the user.
    if (map && you && callbacks.current.compassMode !== 'heading') {
      map.easeTo({ center: you, zoom: Math.max(map.getZoom(), 15.5), duration: 900 })
    }
  }

  return (
    <>
      <div ref={container} className="map" />
      <div className="hud" role="group" aria-label="Map controls">
        <button className="hud-btn" aria-label="Zoom in" title="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          <Icon kind="plus" />
        </button>
        <button className="hud-btn" aria-label="Zoom out" title="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          <Icon kind="minus" />
        </button>
        <button
          className={`hud-btn${props.locationLive ? ' hud-live' : ''}`}
          aria-label="Show my location"
          title="Show my location"
          onClick={locate}
        >
          <Icon kind="locate" />
        </button>
      </div>
    </>
  )
}
