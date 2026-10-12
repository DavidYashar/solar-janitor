export interface ShopItem {
  id: string
  name: string
  description: string
  kind: 'suit' | 'tool' | 'ship'
  cost: number
  /** can be bought again after being consumed (Emergency Beacon) */
  repeatable?: boolean
}

export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'o2tank', name: 'O2 Tank I', description: '+30 max oxygen', kind: 'suit', cost: 500,
  },
  {
    id: 'widescoop', name: 'Wide Scoop', description: '+1.6 vacuum radius', kind: 'tool', cost: 600,
  },
  {
    id: 'cargogloves', name: 'Cargo Gloves', description: '+3 carry slots', kind: 'tool', cost: 750,
  },
  {
    id: 'thrusterkit', name: 'Thruster Kit', description: '+25% ship speed', kind: 'ship', cost: 800,
  },
  {
    id: 'cargoracks', name: 'Cargo Racks', description: '+24 ship hold', kind: 'ship', cost: 750,
  },
  {
    id: 'beacon', name: 'Emergency Beacon', description: 'Rescues you from one KO', kind: 'suit', cost: 1200,
    repeatable: true,
  },
]

export const SHOP_BY_ID: Record<string, ShopItem> = Object.fromEntries(
  SHOP_ITEMS.map(item => [item.id, item]),
)
