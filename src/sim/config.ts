import type { LodTuning } from './lod.ts'
import type { JunkClass, Rank } from './types.ts'

export const TAU = Math.PI * 2

/**
 * Space-map world scale. The Sun, the planets, their orbits and every space-only
 * distance are multiplied by this, while the tug and the ISS keep their real
 * size — so the ship reads as a speck against worlds that deserve the name.
 * Ship speeds and the landing limit scale with it too, which keeps every trip
 * the same length in seconds and every approach the same handful of seconds.
 * The surface planes have their own radius and speeds and never see it.
 */
export const SPACE_SCALE = 10

// ---------------------------------------------------------------- surface
/**
 * The Moon and Mars are balls of this radius, and their landscapes are written
 * for it. Earth is not: its valley was composed as real ground - a 1300 m map,
 * trees nine to twenty-four metres, turbines a hundred and fifty - and at 96 m
 * the curvature alone would put every mountain of it under the horizon. So the
 * radius is a property of the world, not of the engine; see `surfaceRadius` on
 * each `PlanetDef`.
 */
export const SURFACE_RADIUS = 96

/**
 * Earth's landing site, sized by its own landscape rather than by taste.
 *
 * The valley's peaks stand 563 m from the landing pad and 260-330 m high, and
 * whether they exist at all is pure geometry: a point only shows above the curve
 * if it clears the tangent ray from your eye. On a ball of 550 their summits sit
 * ten degrees *below* the horizon and the whole range is invisible; the flanks
 * would need 381 m to show even a sliver. At 700 you get a twenty-metre smudge.
 * A thousand is where they become mountains - about a hundred metres of peak
 * standing six degrees above the horizon - and it is also the size at which the
 * valley fits inside forty-two degrees, well clear of the poles.
 */
export const EARTH_SURFACE_RADIUS = 1000

/**
 * The Moon's landscape is composed as real ground as well - a metre to the unit,
 * a 760 m playfield, an 18 m trench that is five and a half metres deep - and a
 * trench is only a hazard while it is still that deep. Onto the 96 m ball the
 * small worlds share, the whole field would have to shrink eightfold, which
 * turns the cut into a curb and the craters into speckle. So the Moon gets its
 * own radius, big enough to lay the field on at 1:1.
 *
 * Eight hundred rather than Earth's thousand: the playfield only reaches 380 m
 * from the landing site, so a smaller ball keeps more of the surface within
 * walking distance of the interesting ground.
 */
export const MOON_SURFACE_RADIUS = 800

/**
 * The landscape of the two small worlds was composed against a ball of radius
 * 55, and this is what carries that design up: a crater stays in proportion to
 * the ground it sits in, the bowl keeps a walkable slope, and the ring keeps its
 * place on the skyline instead of going over the curve. Everything measured in
 * metres in a terrain function is the radius-55 design multiplied by this.
 */
export const SURFACE_SCALE = SURFACE_RADIUS / 55

/** Players walk anywhere except the last 30 degrees to each pole (keeps the maths sane). */
export const POLE_CLAMP = 1.04
export const WALK_SPEED = 7.4
/** how fast the janitor swings around to face the pointer (radians per second) */
export const SURFACE_TURN_RATE = 4.2
/** how fast the chase camera follows the pointer's height up into the sky */
export const SURFACE_PITCH_RATE = 6.5
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

/**
 * The concrete apron the lander stands on: its radius in metres, the same on
 * every world. The three terrain fields in `sim/` level the ground toward the
 * pad's own height across this and out past it, so the disc never has to bend
 * and the rim is never left hanging over a slope.
 */
export const PAD_RADIUS = 12

/**
 * The apron as the terrain fields apply it: level within `flat`, blended back
 * into the landscape by `blend`. It has to clear `PAD_RADIUS` with room to
 * spare, because what the mesh draws is a triangle between vertices up to six
 * metres apart and the last of those can straddle the edge.
 */
export const PAD_APRON = { flat: 15, blend: 25 }

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
/**
 * The dorsal third engine (plan §5.5): it doubles every commanded speed - cruise,
 * boost, reverse and strafe - because "twice the ship" has to mean twice the ship,
 * not twice the top speed and the same brakes.
 *
 * It does **not** touch `SHIP_WELL_ACCEL`. Thrust authority stays what it was, so a
 * fast tug is a committed tug: going twice as quickly through a gravity well means
 * needing twice the runway to slow down, and the landing limit is measured relative
 * to the world. The power comes with the same price every upgrade in this game
 * charges - you have to fly it.
 */
export const THIRD_ENGINE_BONUS = 2
export const SCANNER_RANGE = 30

// ------------------------------------------------------------------ oxygen
export const OXYGEN_MAX = 100
export const OXYGEN_DRAIN = 1.6
export const OXYGEN_REFILL = 66
export const OXYGEN_WARN = 30
export const SUFFOCATION_DAMAGE = 8
export const HEALTH_MAX = 100

// -------------------------------------------------------------------- ship
/**
 * The ship's speeds are in ORBITAL units, not map units, and deliberately do NOT
 * carry SPACE_SCALE.
 *
 * They used to, and it broke gravity outright. The world's orbits were scaled with
 * the map but their rates were not, so the station still laps the Earth in 25 s and
 * keeps a circular speed of 55 u/s - while a ship scaled by ten flew past it at 550.
 * Ten times the speed of every orbit is a flyby so fast that the well cannot bend
 * its course by even a degree, no world can capture it, and yet it was still being
 * asked to dock with a station doing one tenth of its speed.
 *
 * Cruise is now the station's own speed, so "match the ISS" is simply flying, and
 * the booster - twice orbital - is the one thing that still flies past a world
 * without being caught by it.
 */
export const SHIP_SPEED = 55
export const SHIP_BOOST_SPEED = 110
export const SHIP_REVERSE_SPEED = 24
/** lateral thruster speed for arrow-key strafing */
export const SHIP_STRAFE_SPEED = 34
/** exponential velocity blend rate - heavy damping, no drift-fighter float */
export const SHIP_ACCEL_K = 3.1
/** angular rates, radians per second, applied in the ship's local frame */
export const SHIP_YAW_RATE = 1.9
export const SHIP_PITCH_RATE = 1.7
export const SHIP_ROLL_RATE = 2.6
/** gentle auto-bank that rolls the ship back level with the orbital plane */
export const SHIP_LEVEL_K = 0.55
/** ship-relative, so these do not follow SPACE_SCALE */
export const DOCK_RADIUS = 5
export const DOCK_ASSIST_RADIUS = 9
/** within this range the Docking Assist upgrade auto-aligns the ship to the hatch */
export const DOCK_ASSIST_RANGE = 14
export const DOCK_ASSIST_TURN = 3.4
/** hull contact: below this closing speed the shell just stops the ship, above it bounces */
export const BODY_REST_SPEED = 12
export const BODY_BOUNCE = 1.35
export const LAND_ZONE_HEIGHT = 16 * SPACE_SCALE
/** a SPEED, so orbital units like the ship's own - the zone wants you slower than a
 *  circle, and this is what makes "SLOW DOWN TO LAND" mean something */
export const LAND_MAX_SPEED = 30
export const BODY_CLEARANCE = 2 * SPACE_SCALE

// -------------------------------------------------------------- transitions
export const TRANSITION_TIME = 1.7

// -------------------------------------------------------------- space map
export const SUN_RADIUS = 70 * SPACE_SCALE
export const EARTH_ORBIT = 520 * SPACE_SCALE
export const EARTH_ORBIT_RATE = 0.011
export const EARTH_RADIUS = 16 * SPACE_SCALE
export const ISS_ORBIT = 22 * SPACE_SCALE
export const ISS_ORBIT_RATE = 0.25
/** the station's docking port: on the outward face of the arm, away from Earth */
export const ISS_PORT_OFFSET = 4.5
/**
 * How far the tug's nose reaches ahead of its own origin.
 *
 * Docking has to put the NOSE on the port or the tug reads as parked beside the
 * station rather than joined to it - so the berth is the port plus this, and a
 * docked tug's origin sits that much further out with its nose in the airlock.
 */
export const SHIP_NOSE_OFFSET = 3.5
/** where a docked tug's own origin sits */
export const ISS_DOCK_OFFSET = ISS_PORT_OFFSET + SHIP_NOSE_OFFSET
/**
 * Twice the distance it was, and the rate follows Kepler with it.
 *
 * An orbit twice as wide takes 2^1.5 times as long, so at 840 u the Moon comes round
 * in 89 s instead of 31 and travels at 59 u/s instead of 84 - a slower, more distant
 * companion, and one the tug can still catch, since cruise is 55. Holding the old
 * rate would have doubled its SPEED to 168 u/s: faster than the tug can fly, so the
 * Moon would have been there and unreachable.
 */
export const MOON_ORBIT = 84 * SPACE_SCALE
export const MOON_ORBIT_RATE = 0.2 * Math.pow(2, -1.5)
export const MOON_RADIUS = 8 * SPACE_SCALE
export const MARS_ORBIT = 900 * SPACE_SCALE
export const MARS_ORBIT_RATE = 0.0075
export const MARS_RADIUS = 13 * SPACE_SCALE

// ------------------------------------------------------------------- gravity
// Real inverse-square gravity, patched per world: inside a sphere of influence
// only that world's field acts, which keeps each world's pull clean even though
// this map is compressed (our Moon sits 2.6 Earth radii out, not 60).

/** real relative surface gravity, Earth = 1 - the wells scale with these */
export const GRAVITY_REL = [1, 0.165, 0.379]

/** Earth's gravitational parameter, read off the station's own orbit (mu = w^2 r^3),
 *  so a ship matching the ISS's speed really is in a circular orbit with it. */
export const EARTH_MU = ISS_ORBIT_RATE * ISS_ORBIT_RATE * ISS_ORBIT * ISS_ORBIT * ISS_ORBIT

/** what that works out to at Earth's own surface - the reference g for the wells */
export const EARTH_SURFACE_G = EARTH_MU / (EARTH_RADIUS * EARTH_RADIUS)

/** per-planet gravitational parameter, index matches PLANETS */
export const PLANET_MU = [
  EARTH_MU,
  EARTH_SURFACE_G * GRAVITY_REL[1] * MOON_RADIUS * MOON_RADIUS,
  EARTH_SURFACE_G * GRAVITY_REL[2] * MARS_RADIUS * MARS_RADIUS,
]

/** sphere of influence per planet: the smallest one holding the ship wins */
export const GRAVITY_SOI = [130 * SPACE_SCALE, 16 * SPACE_SCALE, 70 * SPACE_SCALE]

/** the field fades to nothing across the outer slice of the SOI */
export const GRAVITY_SOI_FADE = 0.3

/** inside a well the tug flies like a real engine: thrust is an acceleration.
 *  Scaled with the ship's own speeds rather than left absolute: at 1700 a tug whose
 *  cruise is 55 reaches it in 30 ms and gravity is 65x too weak to be part of the
 *  picture, so the throttle reads as a switch. This is the same authority relative
 *  to gravity it always had - six times the pull at a world's surface. */
export const SHIP_WELL_ACCEL = 170
/** ... easing off over the last slice of each speed cap, so the caps still hold */
export const SHIP_WELL_SOFT = 0.25

/** Idle in a well, the tug trims itself into the local orbit - but only while its
 *  speed relative to that world sits inside this band of the circular speed, so a
 *  fast flyby stays a flyby and a slow arrival becomes a satellite.
 *
 *  The ceiling has to clear a normal arrival or the whole thing is unreachable, and
 *  it has to do so at EVERY world - the smaller the world the faster its cruise
 *  arrival looks, because a circular orbit at the edge of its pull is slower. At
 *  cruise, on the inner edge where the trim starts working: Earth 2.0x, Mars 3.0x,
 *  the Moon 3.5x. At boost the same three read 4.1x, 6.0x and 7.0x. So 4.0 is the
 *  number that catches a cruising arrival everywhere and still lets a sprinting one
 *  fly past - and flying past is still there for anyone holding the throttle, since
 *  the autopilot only ever touches a tug that has been let go of. */
export const ORBIT_TRIM_BAND_MIN = 0.5
export const ORBIT_TRIM_BAND_MAX = 4.0
export const ORBIT_TRIM_RATE = 0.6
/** this close to the hatch the trim matches the station instead of the orbit */
export const ORBIT_HOLD_RANGE = DOCK_ASSIST_RANGE

/** leaving a well, the fly-by-wire handling eases back in over this distance */
export const DEEP_SPACE_ASSIST_FADE = 40 * SPACE_SCALE

// ------------------------------------------------------------------ the Sun
/**
 * The Sun is a body like the others here: it has a well of its own, wider than
 * every world's sphere of influence, so it only ever takes over where no planet's
 * pull reaches. What makes it different is that it does not move, nothing lands
 * on it, and standing off it is a way to die.
 */
export const SUN_BODY = 3

/** its gravitational parameter, from the acceleration at its own surface */
export const SUN_SURFACE_G = 190
export const SUN_MU = SUN_SURFACE_G * SUN_RADIUS * SUN_RADIUS

/**
 * The Sun's sphere of influence.
 *
 * Deliberately small: it reaches a little past the heat ring and no further, so
 * the pull is felt before the heat is, and ordinary flying - Earth to Mars, the
 * Moon to Earth - is nowhere near it. A Sun that held half the map in its well
 * would quietly rewrite how the tug handles everywhere, which is not what this
 * is for.
 */
export const GRAVITY_SOI_SUN = SUN_RADIUS * 4.4
export const GRAVITY_SOI_FADE_SUN = 0.45

/** where the corona starts to bite, and where the hull is being cooked outright */
export const SUN_HEAT_RADIUS = SUN_RADIUS * 3.1
export const SUN_BURN_RADIUS = SUN_RADIUS * 1.5

/**
 * Music triggers (plan §8).
 *
 * The Sun's bed starts **exactly where the corona does**, so the music is the heat:
 * there is no distance at which it plays while the Sun is still harmless, and none at
 * which the hull heats without it. The heat *warning* still arrives later still
 * (`SUN_WARN_HEAT` takes time to build), so the bed is a lead on the banner, not a
 * substitute for it.
 *
 * This started life as the Sun's sphere of influence (3 080 u), which is 1.42x the
 * corona and therefore played while nothing was happening to the ship: measured over
 * 300 straight Earth -> Mars lines, 95/300 pass inside 3 080 u against 63/300 inside
 * the corona, and those 32 extra are the false alarms. Re-measure with
 * `.tools/sun-chord.mjs` if the orbits ever move.
 */
export const MUSIC_SUN_RADIUS = SUN_HEAT_RADIUS
/** how close to Earth's river the janitor has to be for its own bed to take over */
export const MUSIC_RIVER_RANGE = 45

/** heat per second at the burn ring - it falls off as the square of the gap */
export const SUN_HEAT_RATE = 0.3
/** and the flat rate the sky takes it back out at */
export const SUN_COOL_RATE = 0.34
/** heat at which the hull is hot enough to warn about, and to start failing */
export const SUN_WARN_HEAT = 0.22
export const SUN_DAMAGE_HEAT = 0.72
/** hull per second lost at full heat, above the damage threshold */
export const SUN_DAMAGE_PER_SEC = 26

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
/** how fast the storm wind carries the janitor downwind, surface units per second */
export const STORM_PUSH = 3.2
/**
 * How far a new storm's wind must be turned from the one before it, in radians.
 * Every storm picks a fresh bearing off the whole compass; this is the wedge around
 * the previous one that is off limits, so "a different direction each time" is a
 * promise rather than a tendency.
 */
export const STORM_WIND_TURN = 0.7
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

/**
 * The sweep bet (plan §5.8).
 *
 * Every piece already in your arms makes the next one worth more, so how far to walk
 * out before turning back is a judgement about your oxygen instead of a question the
 * carry limit already answered. It pays in SCORE only - credits stay on class value -
 * so taking the risk buys rank, and cannot inflate what the market can sell you.
 */
export const SWEEP_STEP = 0.15
/** the last tenth of a world's junk is a final sweep */
export const FINAL_SWEEP_FRACTION = 0.1
/** and pays double, on top of the chain */
export const FINAL_SWEEP_MULT = 2
/**
 * Loads already aboard when a shift opens: the previous janitor's, one pair a world.
 *
 * A run that starts at 6/68 finishes more often than one that starts at 0/68, and the
 * six are marked delivered rather than removed, so the tallies and the win condition
 * need no special case. Never a relic - a head start must not cost you a tool.
 */
export const STARTING_DELIVERED = 2

// ---------------------------------------------------- LOD streaming (plan §9)
/**
 * Progressive rendering: the space map refines from a glow impostor to a
 * low-poly sphere to the detailed globe as the janitor closes in, and every
 * heavy build runs across frames under a millisecond budget so flying at a
 * world never hitches. The pure scheduler lives in `sim/lod.ts`.
 */
/** ms of geometry building the streamer may spend in one frame */
export const LOD_FRAME_BUDGET_MS = 3
/** widened budget while a tier the player needs *right now* is still missing */
export const LOD_URGENT_BUDGET_MS = 6.5
/** a queued tier that lands within this many seconds counts as urgent */
export const LOD_URGENT_ETA = 3
/** ms of look-ahead: a body this far "into the future" is treated as being here */
export const LOD_LEAD_TIME = 6
/** space map: 0 = glow impostor, 1 = low-poly sphere, 2 = detailed globe */
export const LOD_SPACE_TUNING: LodTuning = {
  enter: [0, 620 * SPACE_SCALE, 300 * SPACE_SCALE],
  exit: [0, 720 * SPACE_SCALE, 390 * SPACE_SCALE],
  leadTime: LOD_LEAD_TIME,
}
/** landable worlds: 0 = nothing, 1 = stand-in crust, 2 = full terrain + props */
export const LOD_SURFACE_TUNING: LodTuning = {
  enter: [0, 520 * SPACE_SCALE, 150 * SPACE_SCALE],
  exit: [0, 620 * SPACE_SCALE, 260 * SPACE_SCALE],
  leadTime: LOD_LEAD_TIME,
}
/** vertices of the 112×72 surface sphere handled per build slice */
export const LOD_TERRAIN_SLICE = 4200
/** instanced props placed per build slice */
export const LOD_PROP_SLICE = 64
/** rough build-cost estimates in ms, for scheduling telemetry and debug output */
export const LOD_COST_STANDIN = 0.9
export const LOD_COST_DETAIL = 8
export const LOD_COST_SURFACE = 12

// ------------------------------------------------------------ ranks & saves
/**
 * Plan §5.6 lists 8 000 / 14 000 / 22 000 / 32 000, which assumed career totals.
 * These are tuned to what a v1 run actually pays out, measured rather than guessed
 * (the numbers below are from `.tools/sweep-economy.mjs` with the sweep bet in):
 *
 * - one world cleaned, sweeping     ~4 400
 * - two worlds cleaned              ~9 500
 * - the system restored, arms never
 *   more than half full             ~11 600
 * - the system restored, sweeping   ~13 900
 * - the system restored, every sweep
 *   full to the carry limit         ~15 700   <- the ceiling
 *
 * So the ladder reads as behaviour: finishing the system is PLATINUM, and the last
 * rank is what the sweep bet pays - LEGEND means you kept pushing your luck and got
 * away with it. Before this the ceiling was 10 188 against a 12 000 LEGEND, which
 * made the top rank unreachable.
 */
export const RANKS: { name: Rank; min: number }[] = [
  { name: 'LEGEND', min: 14500 },
  { name: 'PLATINUM', min: 12500 },
  { name: 'GOLD', min: 9000 },
  { name: 'SILVER', min: 4000 },
  { name: 'BRONZE', min: 0 },
]
export const SAVE_VERSION = 1
export const SAVE_KEY = 'solar-janitor:save'
export const BEST_KEY = 'solar-janitor:best'
export const MUTE_KEY = 'solar-janitor:muted'
