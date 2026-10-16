export interface ShopItem {
  id: string
  name: string
  description: string
  kind: 'suit' | 'tool' | 'ship'
  cost: number
  /** can be bought again after being consumed (Emergency Beacon) */
  repeatable?: boolean
  /** must be installed before this one can be bought */
  requires?: string
}

/** Plan §5.5 — the full ISS catalogue. Prices are the first-pass values. */
export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'o2tank', name: 'O2 Tank I', description: '+30 max oxygen', kind: 'suit', cost: 500,
  },
  {
    id: 'o2tank2', name: 'O2 Tank II', description: '+40 max oxygen', kind: 'suit', cost: 900,
    requires: 'o2tank',
  },
  {
    id: 'recycler', name: 'Recycler Mask', description: '-20% oxygen drain', kind: 'suit', cost: 700,
  },
  {
    id: 'magboots', name: 'Magboots', description: '+15% move speed', kind: 'suit', cost: 550,
  },
  {
    id: 'gravharness', name: 'Grav Harness', description: 'Higher hops, softer landings', kind: 'suit', cost: 650,
  },
  {
    id: 'hazardweave', name: 'Hazard Weave', description: '-40% hazard damage', kind: 'suit', cost: 1100,
  },
  {
    id: 'widescoop', name: 'Wide Scoop', description: '+1.6 vacuum radius', kind: 'tool', cost: 600,
  },
  {
    id: 'cargogloves', name: 'Cargo Gloves', description: '+3 carry slots', kind: 'tool', cost: 750,
  },
  {
    id: 'scanner', name: 'Junk Scanner', description: 'Surface radar pings every nearby junk piece', kind: 'tool', cost: 850,
  },
  {
    id: 'beacon', name: 'Emergency Beacon', description: 'Rescues you from one KO', kind: 'suit', cost: 1200,
    repeatable: true,
  },
  {
    id: 'thrusterkit', name: 'Thruster Kit', description: '+25% ship speed', kind: 'ship', cost: 800,
  },
  {
    id: 'thirdengine', name: 'Third Engine', description: 'Dorsal thruster: x2 ship speed', kind: 'ship', cost: 1600,
  },
  {
    id: 'navcomputer', name: 'Nav Computer', description: 'System radar: junk left on every world', kind: 'ship', cost: 700,
  },
  {
    id: 'cargoracks', name: 'Cargo Racks', description: '+24 ship hold', kind: 'ship', cost: 750,
  },
  {
    id: 'dockingassist', name: 'Docking Assist', description: 'Wider dock radius, auto-align', kind: 'ship', cost: 500,
  },
]

export const SHOP_BY_ID: Record<string, ShopItem> = Object.fromEntries(
  SHOP_ITEMS.map(item => [item.id, item]),
)

/** Plan §5.5 — relics are found in the junk, never sold. */
export interface RelicDef {
  planet: number
  name: string
  tool: string
  toolName: string
  effect: string
}

export const RELICS: RelicDef[] = [
  {
    planet: 0,
    name: 'Courier Drone Core',
    tool: 'eye',
    toolName: 'Eye in the Sky',
    effect: 'surface radar tracks every piece of junk',
  },
  {
    planet: 1,
    name: 'Rover Axle',
    tool: 'stride',
    toolName: 'Surefoot Stride',
    effect: '+20% walk speed, stable landings',
  },
  {
    planet: 2,
    name: 'Weather Balloon Antenna',
    tool: 'stormsense',
    toolName: 'Storm Sense',
    effect: 'hazards telegraph 3 s earlier',
  },
]

export const RELIC_BY_PLANET: Record<number, RelicDef> = Object.fromEntries(
  RELICS.map(relic => [relic.planet, relic]),
)

export const RELIC_BY_TOOL: Record<string, RelicDef> = Object.fromEntries(
  RELICS.map(relic => [relic.tool, relic]),
)
