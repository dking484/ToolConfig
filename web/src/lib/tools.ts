// Derive a per-tool model from Klipper status objects (framework-agnostic).
import type { Status } from './moonraker'

export interface Xyz {
  x: number
  y: number
  z: number
}

export interface ToolInfo {
  number: number
  name: string // klipper object name, e.g. "tool T0"
  label: string // "T0"
  active: boolean
  extruder: string | null
  temp: number | null
  target: number | null
  power: number | null
  nozzle: number | null
  pressureAdvance: number | null
  park: Xyz
  safeY: number
  closeY: number
  offset: Xyz
  probeName: string | null
  probeZOffset: number | null
  probeState: 'open' | 'docked' | 'unknown' // from the last DETECT query
  fan: string | null
  shaper: { x: string; fx: number; y: string; fy: number }
  mcu: McuInfo | null
  color: string | null // gcode_macro Tn variable_color (Mainsail convention)
  warnings: string[]
}

export interface McuInfo {
  name: string // "EBBT0"
  canbusUuid: string | null
  serial: string | null
  version: string | null
  connected: boolean
  mcuType: string | null
  retransmits: number | null
}

const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : null)

/** "^EBBT0:PB6" / "EBBT0: PB13" -> "EBBT0" (null for main mcu pins) */
export function pinMcu(pin: any): string | null {
  if (typeof pin !== 'string') return null
  const m = pin.replace(/^[\^~!]+/, '').match(/^\s*([A-Za-z0-9_]+)\s*:/)
  return m ? m[1] : null
}

export function mcuInfo(status: Status, name: string): McuInfo {
  const settings = status.configfile?.settings ?? {}
  const sec = settings[`mcu ${name.toLowerCase()}`] ?? {}
  const st = status[`mcu ${name}`] ?? {}
  return {
    name,
    canbusUuid: sec.canbus_uuid ?? null,
    serial: sec.serial ?? null,
    version: st.mcu_version ?? null,
    connected: !!st.mcu_version && status.webhooks?.state === 'ready',
    mcuType: st.mcu_constants?.MCU ?? null,
    retransmits: num(st.last_stats?.bytes_retransmit),
  }
}

export function buildTools(status: Status): ToolInfo[] {
  const tc = status.toolchanger
  if (!tc?.tool_names) return []
  const settings = status.configfile?.settings ?? {}
  const probes = status.tool_probe_endstop?.last_tools_query ?? {}
  const th = status.toolhead ?? {}
  const min = th.axis_minimum ?? [0, 0, 0]
  const max = th.axis_maximum ?? [Infinity, Infinity, Infinity]

  return (tc.tool_names as string[]).map((name) => {
    const t = status[name] ?? {}
    const number = t.tool_number ?? -1
    const extruder: string | null = t.extruder ?? null
    const ex = extruder ? status[extruder] ?? {} : {}
    const exCfg = extruder ? settings[extruder] ?? {} : {}
    const probeName = `tool_probe T${number}`
    const probeCfg = settings[probeName.toLowerCase()]
    const mcuName = pinMcu(exCfg.heater_pin) ?? pinMcu(probeCfg?.pin) ?? pinMcu(exCfg.step_pin)
    const park = { x: t.params_park_x ?? NaN, y: t.params_park_y ?? NaN, z: t.params_park_z ?? NaN }
    const q = probes[String(number)]
    const warnings: string[] = []

    ;(['x', 'y', 'z'] as const).forEach((axis, i) => {
      const v = park[axis]
      if (isNaN(v)) warnings.push(`params_park_${axis} is not set`)
      else if (v < min[i] || v > max[i]) warnings.push(`Park ${axis.toUpperCase()} ${v} is outside the axis range ${min[i]}..${max[i]}`)
    })
    if (!isNaN(park.y) && typeof t.params_safe_y === 'number') {
      const approach = Math.max(0, ...((t.params_pickup_path as any[] | undefined) ?? []).map((p) => p.y ?? 0))
      if (t.params_safe_y < park.y + approach + 10) warnings.push(`Safe Y ${t.params_safe_y} is too close to the dock (park Y ${park.y}); the carriage would move sideways next to the docks`)
    }
    const path = t.params_pickup_path as any[] | undefined
    if (!path?.length) warnings.push('No pickup path configured')
    else if (!path.some((p) => 'verify' in p)) warnings.push('Pickup path has no verify point, so a failed pickup is not detected')

    return {
      number,
      name,
      label: `T${number}`,
      active: !!t.active,
      extruder,
      temp: num(ex.temperature),
      target: num(ex.target),
      power: num(ex.power),
      nozzle: num(exCfg.nozzle_diameter),
      pressureAdvance: num(ex.pressure_advance),
      park,
      safeY: t.params_safe_y,
      closeY: t.params_close_y,
      offset: { x: t.gcode_x_offset ?? 0, y: t.gcode_y_offset ?? 0, z: t.gcode_z_offset ?? 0 },
      probeName: probeCfg ? probeName : null,
      probeZOffset: num(probeCfg?.z_offset),
      probeState: q === undefined ? 'unknown' : q ? 'docked' : 'open',
      fan: t.fan ?? null,
      shaper: {
        x: t.params_input_shaper_type_x ?? '',
        fx: t.params_input_shaper_freq_x ?? 0,
        y: t.params_input_shaper_type_y ?? '',
        fy: t.params_input_shaper_freq_y ?? 0,
      },
      mcu: mcuName ? mcuInfo(status, mcuName) : null,
      color: normalizeColor(status[`gcode_macro T${number}`]?.color),
      warnings,
    }
  })
}

function normalizeColor(c: any): string | null {
  if (typeof c !== 'string' || !c) return null
  const hex = c.replace(/^#/, '')
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex) ? '#' + hex : null
}

/** All MCUs Klipper knows about, including ones not tied to a tool. */
export function allMcus(status: Status): McuInfo[] {
  return Object.keys(status)
    .filter((k) => k === 'mcu' || k.startsWith('mcu '))
    .map((k) => (k === 'mcu' ? { ...mcuInfo(status, 'mcu'), ...mainMcu(status) } : mcuInfo(status, k.slice(4))))
}

function mainMcu(status: Status): Partial<McuInfo> {
  const sec = status.configfile?.settings?.mcu ?? {}
  const st = status.mcu ?? {}
  return {
    name: 'mcu',
    canbusUuid: sec.canbus_uuid ?? null,
    serial: sec.serial ?? null,
    version: st.mcu_version ?? null,
    connected: !!st.mcu_version && status.webhooks?.state === 'ready',
    mcuType: st.mcu_constants?.MCU ?? null,
  }
}
