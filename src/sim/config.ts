import type { JunkClass } from './types.ts'

export const TAU = Math.PI * 2

// ---------------------------------------------------------------- surface
export const SURFACE_RADIUS = 55
/** Players walk anywhere except the last 30 degrees to each pole (keeps the maths sane). */
export const POLE_CLAMP = 1.04
export const WALK_SPEED = 7.4
export const SPRINT_MULTIPLIER = 1.6
export const AIR_CONTROL_K = 3.4
export const HOP_SPEED = 11.5
export const HOP_COOLDOWN = 0.25
export const GRAVITY_BASE = 20
export const HARD_LAND_SPEED = 15
export const HARD_LAND_DAMAGE = 5
export const SCOOP_RADIUS = 2.8
export const CARRY_SLOTS = 8
export const HOLD_SLOTS = 30
export const LANDER_RING_RADIUS = 6.5

// ------------------------------------------------------------------ oxygen
export const OXYGEN_MAX = 100
export const OXYGEN_DRAIN = 1.6
export const OXYGEN_REFILL = 66
export const OXYGEN_WARN = 30
export const SUFFOCATION_DAMAGE = 8
export const HEALTH_MAX = 100

// -------------------------------------------------------------------- ship
export const SHIP_SPEED = 55
export const SHIP_BOOST_SPEED = 110
export const SHIP_REVERSE_SPEED = 24
/** exponential velocity blend rate - heavy damping, no drift-fighter float */
export const SHIP_ACCEL_K = 3.1
export const SHIP_YAW_RATE = 1.9
export const DOCK_RADIUS = 5
export const LAND_ZONE_HEIGHT = 16
export const LAND_MAX_SPEED = 30
export const BODY_CLEARANCE = 2

// -------------------------------------------------------------- transitions
export const TRANSITION_TIME = 1.7

// -------------------------------------------------------------- space map
export const SUN_RADIUS = 70
export const EARTH_ORBIT = 520
export const EARTH_ORBIT_RATE = 0.011
export const EARTH_RADIUS = 16
export const ISS_ORBIT = 22
export const ISS_ORBIT_RATE = 0.25
/** airlock sits on the outward face of the station, away from Earth */
export const ISS_DOCK_OFFSET = 4.5
export const MOON_ORBIT = 42
export const MOON_ORBIT_RATE = 0.2
export const MOON_RADIUS = 8

// ---------------------------------------------------------------- economy
export const JUNK_POINTS: Record<JunkClass, number> = { scrap: 40, tech: 110, hazardous: 180 }
export const JUNK_LABELS: Record<JunkClass, string> = {
  scrap: 'Scrap', tech: 'Tech', hazardous: 'Hazardous',
}
export const JUNK_COLORS: Record<JunkClass, number> = {
  scrap: 0xd8b46a, tech: 0x8fd3ff, hazardous: 0xb6ff6a,
}
export const BATCH_BONUS_SIZE = 6
export const BATCH_BONUS = 0.15
export const FULL_HOLD_BONUS = 0.25
export const CLEAN_BONUS = 1000
