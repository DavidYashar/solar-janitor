import {
  EARTH_ORBIT, EARTH_ORBIT_RATE, EARTH_RADIUS, MOON_ORBIT, MOON_ORBIT_RATE, MOON_RADIUS,
} from './config.ts'

export interface PlanetDef {
  id: number
  key: string
  name: string
  tagline: string
  /** relative gravity, 1 = Earth */
  gravity: number
  /** radius in the space map */
  spaceRadius: number
  orbit: number
  orbitRate: number
  landable: boolean
  junkCount: number
  landerLat: number
  landerLon: number
  /** how far junk can scatter from the lander, radians */
  spread: { lat: number; lon: number }
  /** palette */
  spaceColor: number
  atmosphere: number
  groundLow: number
  groundHigh: number
  accent: number
}

export const EARTH: PlanetDef = {
  id: 0,
  key: 'earth',
  name: 'Earth',
  tagline: 'Home. Drowning in a century of junk.',
  gravity: 1,
  spaceRadius: EARTH_RADIUS,
  orbit: EARTH_ORBIT,
  orbitRate: EARTH_ORBIT_RATE,
  landable: true,
  junkCount: 24,
  landerLat: 0,
  landerLon: 0.6,
  spread: { lat: 0.62, lon: 1.05 },
  spaceColor: 0x2f6fd0,
  atmosphere: 0x7fc4ff,
  groundLow: 0x2f7d4f,
  groundHigh: 0x7cc46a,
  accent: 0x9fe8ff,
}

export const PLANETS: PlanetDef[] = [EARTH]

export const MOON = {
  name: 'Moon',
  radius: MOON_RADIUS,
  orbit: MOON_ORBIT,
  orbitRate: MOON_ORBIT_RATE,
  color: 0xb9bfc9,
}

export function planetById(id: number): PlanetDef {
  return PLANETS[id] ?? EARTH
}

// ------------------------------------------------------- procedural terrain
// Shared by the sim (spawn rules stay clear of bumps) and the renderer
// (props and the player ride the same surface). Pure and deterministic.

function hash2(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  const u = smooth(xf)
  const v = smooth(yf)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** Rolling hills in surface units, roughly -2 .. +2. */
export function surfaceHeight(lat: number, lon: number, seed: number): number {
  const x = lon * 9.5
  const y = lat * 9.5
  return (valueNoise(x, y, seed) - 0.5) * 3.4 + (valueNoise(x * 2.7, y * 2.7, seed ^ 0x9e3779b9) - 0.5) * 1.1
}

/** Where the lander sits on the surface, in sim lat/lon. */
export function landerSite(planetId: number): { lat: number; lon: number } {
  const planet = planetById(planetId)
  return { lat: planet.landerLat, lon: planet.landerLon }
}
