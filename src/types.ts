export type LngLat = [number, number]

export interface Place {
  coord: LngLat
  label: string
  sublabel?: string
}

export type ModeId = 'walk' | 'bike' | 'citybike' | 'scooter' | 'transit' | 'taxi' | 'uber' | 'bolt'

export interface BeamSegment {
  coords: LngLat[]
  color: string
  /** Halo colour, when the line colour alone wouldn't show up on the dark map. */
  glow?: string
  dashed?: boolean
}

export interface Beam {
  id: string
  segments: BeamSegment[]
  /** Pixel offset so beams sharing a street don't sit on top of each other. */
  offset: number
  /** Hidden unless its card is highlighted (e.g. alternative transit itineraries). */
  secondary?: boolean
}

export interface TransitLeg {
  mode: string
  line?: string
  color: string
  durationMin: number
  from?: string
}

export interface TripOption {
  id: string
  mode: ModeId
  beamId: string
  title: string
  subtitle?: string
  durationMin: number
  priceMin: number
  priceMax: number
  estimated: boolean
  distanceKm: number
  co2g: number
  departure?: string
  arrival?: string
  legs?: TransitLeg[]
  link?: { label: string; href: string }
  note?: string
  /** One per segment of the option's beam, in order, so the direction banner can follow along. */
  steps: TripStep[]
}

export interface TripStep {
  /** "Walk", "Cycle", "Ride tram 4" … */
  action: string
  /** Where the step ends: a stop, a bike station, the destination. */
  to: string
  /** A ride the user sits in (no "x m to go" countdown). */
  ride?: boolean
  /** What to do just before this step starts, e.g. "Take tram 4 from Ylioppilastalo at 09:11". */
  board?: string
}

export interface GroupResult {
  options: TripOption[]
  beams: Beam[]
}
