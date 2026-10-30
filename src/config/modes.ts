import type { ModeId } from '../types'

export interface ModeMeta {
  label: string
  color: string
  /** Lighter halo for a colour that would disappear on the dark map (Uber's dark grey). */
  glow?: string
  /** Rough g CO₂ per passenger-km, for the comparison hint. */
  co2PerKm: number
}

export const MODES: Record<ModeId, ModeMeta> = {
  walk: { label: 'Walk', color: '#e6e9f0', co2PerKm: 0 },
  bike: { label: 'Own bike', color: '#9be564', co2PerKm: 0 },
  citybike: { label: 'City bike', color: '#fcb919', co2PerKm: 0 },
  scooter: { label: 'E-scooter', color: '#ff6ec7', co2PerKm: 35 },
  transit: { label: 'Public transport', color: '#00b9e4', co2PerKm: 45 },
  taxi: { label: 'Taxi', color: '#ffe98a', co2PerKm: 110 },
  uber: { label: 'Uber', color: '#5c626c', glow: '#b4bac4', co2PerKm: 110 },
  bolt: { label: 'Bolt', color: '#34d186', co2PerKm: 110 },
}

/** Official HSL vehicle colours, keyed by OTP leg mode, plus the rides that link up with them in mixed trips. */
export const LEG_COLORS: Record<string, string> = {
  BUS: '#007ac9',
  TRAM: '#00985f',
  SUBWAY: '#ff6319',
  RAIL: '#8c4799',
  FERRY: '#00b9e4',
  WALK: '#aab2c0',
  BICYCLE: MODES.bike.color,
  CITYBIKE: MODES.citybike.color,
  SCOOTER: MODES.scooter.color,
}

// Options that share a road route (own bike + scooter, taxi + Uber + Bolt) each get their own beam,
// side by side, so every option's colour shows on the map.
export const BEAM_STYLE = {
  walk: { color: MODES.walk.color, offset: -4 },
  bike: { color: MODES.bike.color, offset: 4 },
  scooter: { color: MODES.scooter.color, offset: 8 },
  citybike: { color: MODES.citybike.color, offset: 12 },
  taxi: { offset: -8 },
  uber: { offset: -12 },
  bolt: { offset: -16 },
  transit: { offset: 0 },
  // Mixed trips are drawn on their own (Mix tab), side by side where they share a ride.
  scooterMix: { offset: -6 },
  bikeMix: { offset: 0 },
  citybikeMix: { offset: 6 },
}
