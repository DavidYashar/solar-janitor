import type { JunkClass, Rank } from './types.ts'

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

// -------------------------------------------------------------- suit & tools
export const MAGBOOTS_BONUS = 0.15
export const STRIDE_BONUS = 0.2
export const GRAV_HOP_BONUS = 0.25
export const GRAV_LAND_BONUS = 0.3
export const HAZARD_WEAVE_REDUCTION = 0.4
export const RECYCLER_REDUCTION = 0.2
export const O2_TANK_BONUS = 30
export const O2_TANK2_BONUS = 40
export const WIDE_SCOOP_BONUS = 1.6
export const CARGO_GLOVES_BONUS = 3
export const CARGO_RACKS_BONUS = 24
export const THRUSTER_BONUS = 0.25
export const SCANNER_RANGE = 30

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
/** angular rates, radians per second, applied in the ship's local frame */
export const SHIP_YAW_RATE = 1.9
export const SHIP_PITCH_RATE = 1.7
export const SHIP_ROLL_RATE = 2.6
/** gentle auto-bank that rolls the ship back level with the orbital plane */
export const SHIP_LEVEL_K = 0.55
export const DOCK_RADIUS = 5
export const DOCK_ASSIST_RADIUS = 9
/** within this range the Docking Assist upgrade auto-aligns the ship to the hatch */
export const DOCK_ASSIST_RANGE = 14
export const DOCK_ASSIST_TURN = 3.4
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
export const MARS_ORBIT = 900
export const MARS_ORBIT_RATE = 0.0075
export const MARS_RADIUS = 13

// ---------------------------------------------------------------- hazards
/** seconds between meteor volleys on the Moon */
export const METEOR_INTERVAL_MIN = 6
export const METEOR_INTERVAL_MAX = 11
export const METEOR_TELEGRAPH = 2.5
/** Storm Sense shows every hazard telegraph this many seconds earlier */
export const METEOR_TELEGRAPH_BONUS = 3
export const METEOR_RADIUS = 3.8
export const METEOR_DAMAGE = 12
/** how far from the player a meteor target can land, in surface units */
export const METEOR_RANGE = 20
export const STORM_PERIOD = 45
export const STORM_DURATION = 14
export const STORM_DRAIN_MULT = 1.35
/** sideways drift the storm wind puts on the janitor, surface units per second */
export const STORM_PUSH = 3.2
/** warning lead time before a storm hits; Storm Sense triples it */
export const STORM_WARN_LEAD = 4
export const STORM_WARN_LEAD_BONUS = 8

// ---------------------------------------------------------------- economy
export const JUNK_POINTS: Record<JunkClass, number> = {
  scrap: 40, tech: 110, hazardous: 180, relic: 400,
}
export const JUNK_LABELS: Record<JunkClass, string> = {
  scrap: 'Scrap', tech: 'Tech', hazardous: 'Hazardous', relic: 'Relic',
}
export const JUNK_COLORS: Record<JunkClass, number> = {
  scrap: 0xd8b46a, tech: 0x8fd3ff, hazardous: 0xb6ff6a, relic: 0xffc24d,
}
export const BATCH_BONUS_SIZE = 6
export const BATCH_BONUS = 0.15
export const FULL_HOLD_BONUS = 0.25
export const CLEAN_BONUS = 1000

// ------------------------------------------------------------ ranks & saves
/**
 * Plan §5.6 lists 8 000 / 14 000 / 22 000 / 32 000, which assumed career totals.
 * A full three-planet v1 run tops out near 12 000, so the thresholds are tuned
 * to the achievable range (documented in README).
 */
export const RANKS: { name: Rank; min: number }[] = [
  { name: 'LEGEND', min: 12000 },
  { name: 'PLATINUM', min: 9500 },
  { name: 'GOLD', min: 7000 },
  { name: 'SILVER', min: 4000 },
  { name: 'BRONZE', min: 0 },
]
export const SAVE_VERSION = 1
export const SAVE_KEY = 'solar-janitor:save'
export const BEST_KEY = 'solar-janitor:best'
export const MUTE_KEY = 'solar-janitor:muted'
