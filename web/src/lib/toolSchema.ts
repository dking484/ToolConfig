// What the visual editor knows about each section of a tool's config file.
// Keys not listed here are still shown (as plain text fields), so nothing in
// the file is ever hidden from the visual view.
import { normalizeSection, parseCfg, type CfgSection } from './cfgEdit'

export type FieldType = 'text' | 'number' | 'select' | 'bool' | 'code' | 'pin'
export type Apply = 'live' | 'restart'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  help?: string
  options?: string[]
  quoted?: boolean // Python literal in the file: 'mzv'
  apply?: Apply // default: restart
}

export interface SectionKind {
  id: string
  title: (name: string) => string
  icon: string // short label for the card
  match: (name: string) => boolean
  fields: FieldDef[]
}

const SENSORS = [
  'ATC Semitec 104NT-4-R025H42G', 'ATC Semitec 104GT-2', 'Generic 3950', 'EPCOS 100K B57560G104F',
  'NTC 100K MGB18-104F39050L32', 'SliceEngineering 450', 'PT1000', 'MAX31865', 'MAX31856',
]

export const SECTION_KINDS: SectionKind[] = [
  {
    id: 'mcu', icon: 'Board', title: (n) => `Board (${n.slice(4)})`, match: (n) => /^mcu\s/.test(n),
    fields: [
      { key: 'canbus_uuid', label: 'CAN bus UUID', type: 'text', help: '12 hex digits; find unassigned boards in Boards & IDs' },
      { key: 'serial', label: 'USB serial path', type: 'text', help: '/dev/serial/by-id/usb-Klipper_... (instead of a CAN UUID)' },
      { key: 'canbus_interface', label: 'CAN interface', type: 'text', help: 'Usually can0 (default)' },
    ],
  },
  {
    id: 'extruder', icon: 'Extruder', title: (n) => `Extruder & hotend (${n})`, match: (n) => /^extruder\d*$/.test(n),
    fields: [
      { key: 'nozzle_diameter', label: 'Nozzle diameter', type: 'number' },
      { key: 'filament_diameter', label: 'Filament diameter', type: 'number' },
      { key: 'rotation_distance', label: 'Rotation distance', type: 'number', apply: 'live', help: 'E-steps calibration' },
      { key: 'gear_ratio', label: 'Gear ratio', type: 'text', help: 'e.g. 50:10' },
      { key: 'microsteps', label: 'Microsteps', type: 'number' },
      { key: 'full_steps_per_rotation', label: 'Full steps / rotation', type: 'number', help: '200 = 1.8°, 400 = 0.9°' },
      { key: 'pressure_advance', label: 'Pressure advance', type: 'number', apply: 'live' },
      { key: 'pressure_advance_smooth_time', label: 'PA smooth time', type: 'number', apply: 'live' },
      { key: 'sensor_type', label: 'Thermistor', type: 'select', options: SENSORS },
      { key: 'pullup_resistor', label: 'Thermistor pull-up (Ω)', type: 'number' },
      { key: 'min_temp', label: 'Min temp', type: 'number' },
      { key: 'max_temp', label: 'Max temp', type: 'number' },
      { key: 'min_extrude_temp', label: 'Min extrude temp', type: 'number' },
      { key: 'max_power', label: 'Heater max power', type: 'number', help: '0–1' },
      { key: 'control', label: 'Heater control', type: 'select', options: ['pid', 'watermark'] },
      { key: 'pid_kp', label: 'PID Kp', type: 'number' },
      { key: 'pid_ki', label: 'PID Ki', type: 'number' },
      { key: 'pid_kd', label: 'PID Kd', type: 'number' },
      { key: 'max_extrude_only_distance', label: 'Max extrude-only distance', type: 'number' },
      { key: 'max_extrude_only_velocity', label: 'Max extrude-only velocity', type: 'number' },
      { key: 'max_extrude_only_accel', label: 'Max extrude-only accel', type: 'number' },
      { key: 'max_extrude_cross_section', label: 'Max extrude cross-section', type: 'number' },
      { key: 'step_pin', label: 'Step pin', type: 'pin' },
      { key: 'dir_pin', label: 'Dir pin', type: 'pin' },
      { key: 'enable_pin', label: 'Enable pin', type: 'pin' },
      { key: 'heater_pin', label: 'Heater pin', type: 'pin' },
      { key: 'sensor_pin', label: 'Thermistor pin', type: 'pin' },
    ],
  },
  {
    id: 'tmc', icon: 'Driver', title: (n) => `Stepper driver (${n.split(' ')[0]})`, match: (n) => /^tmc\d+\s/.test(n),
    fields: [
      { key: 'run_current', label: 'Run current (A)', type: 'number' },
      { key: 'hold_current', label: 'Hold current (A)', type: 'number' },
      { key: 'sense_resistor', label: 'Sense resistor (Ω)', type: 'number' },
      { key: 'interpolate', label: 'Interpolate', type: 'bool' },
      { key: 'stealthchop_threshold', label: 'StealthChop threshold', type: 'number', help: '0 = always SpreadCycle' },
      { key: 'uart_pin', label: 'UART pin', type: 'pin' },
    ],
  },
  {
    id: 'partfan', icon: 'Fan', title: (n) => `Part cooling fan (${n.split(' ')[1]})`, match: (n) => /^fan_generic\s/.test(n),
    fields: [
      { key: 'pin', label: 'Pin', type: 'pin' },
      { key: 'max_power', label: 'Max power', type: 'number' },
      { key: 'kick_start_time', label: 'Kick-start time (s)', type: 'number' },
      { key: 'off_below', label: 'Off below', type: 'number' },
      { key: 'cycle_time', label: 'PWM cycle time (s)', type: 'number' },
      { key: 'tachometer_pin', label: 'Tachometer pin', type: 'pin' },
    ],
  },
  {
    id: 'hotendfan', icon: 'Fan', title: (n) => `Hotend fan (${n.split(' ')[1]})`, match: (n) => /^heater_fan\s/.test(n),
    fields: [
      { key: 'pin', label: 'Pin', type: 'pin' },
      { key: 'heater', label: 'Heater', type: 'text' },
      { key: 'heater_temp', label: 'Turns on above (°C)', type: 'number' },
      { key: 'fan_speed', label: 'Fan speed', type: 'number' },
      { key: 'kick_start_time', label: 'Kick-start time (s)', type: 'number' },
      { key: 'max_power', label: 'Max power', type: 'number' },
      { key: 'tachometer_pin', label: 'Tachometer pin', type: 'pin' },
    ],
  },
  {
    id: 'leds', icon: 'LEDs', title: (n) => `LEDs (${n.split(' ')[1]})`, match: (n) => /^neopixel\s/.test(n),
    fields: [
      { key: 'pin', label: 'Pin', type: 'pin' },
      { key: 'chain_count', label: 'Number of LEDs', type: 'number' },
      { key: 'color_order', label: 'Color order', type: 'select', options: ['GRB', 'RGB', 'GRBW', 'RGBW'] },
      { key: 'initial_red', label: 'Initial red', type: 'number' },
      { key: 'initial_green', label: 'Initial green', type: 'number' },
      { key: 'initial_blue', label: 'Initial blue', type: 'number' },
      { key: 'initial_white', label: 'Initial white', type: 'number' },
    ],
  },
  {
    id: 'tool', icon: 'Tool', title: (n) => `Tool (${n.split(' ')[1]})`, match: (n) => /^tool\s/.test(n),
    fields: [
      { key: 'tool_number', label: 'Tool number', type: 'number' },
      { key: 'extruder', label: 'Extruder', type: 'text' },
      { key: 'fan', label: 'Part fan', type: 'text' },
      { key: 'params_park_x', label: 'Dock X', type: 'number', apply: 'live' },
      { key: 'params_park_y', label: 'Dock Y', type: 'number', apply: 'live' },
      { key: 'params_park_z', label: 'Dock Z', type: 'number', apply: 'live' },
      { key: 'params_safe_y', label: 'Safe Y', type: 'number', apply: 'live', help: 'Y the gantry retreats to before moving sideways near the docks' },
      { key: 'gcode_x_offset', label: 'X offset', type: 'number', apply: 'live' },
      { key: 'gcode_y_offset', label: 'Y offset', type: 'number', apply: 'live' },
      { key: 'gcode_z_offset', label: 'Z offset', type: 'number', apply: 'live' },
      { key: 'params_input_shaper_type_x', label: 'Shaper X type', type: 'select', options: ['zv', 'mzv', 'zvd', 'ei', '2hump_ei', '3hump_ei'], quoted: true, apply: 'live' },
      { key: 'params_input_shaper_freq_x', label: 'Shaper X freq (Hz)', type: 'number', apply: 'live' },
      { key: 'params_input_shaper_damping_ratio_x', label: 'Shaper X damping', type: 'number', apply: 'live' },
      { key: 'params_input_shaper_type_y', label: 'Shaper Y type', type: 'select', options: ['zv', 'mzv', 'zvd', 'ei', '2hump_ei', '3hump_ei'], quoted: true, apply: 'live' },
      { key: 'params_input_shaper_freq_y', label: 'Shaper Y freq (Hz)', type: 'number', apply: 'live' },
      { key: 'params_input_shaper_damping_ratio_y', label: 'Shaper Y damping', type: 'number', apply: 'live' },
    ],
  },
  {
    id: 'probe', icon: 'Probe', title: (n) => `Tap probe (${n.split(' ')[1]})`, match: (n) => /^tool_probe\s/.test(n),
    fields: [
      { key: 'pin', label: 'Sensor pin', type: 'pin', help: '^ = pull-up, ! = inverted' },
      { key: 'tool', label: 'Tool number', type: 'number' },
      { key: 'z_offset', label: 'Z offset', type: 'number' },
      { key: 'x_offset', label: 'X offset', type: 'number' },
      { key: 'y_offset', label: 'Y offset', type: 'number' },
      { key: 'speed', label: 'Probe speed', type: 'number' },
      { key: 'lift_speed', label: 'Lift speed', type: 'number' },
      { key: 'samples', label: 'Samples', type: 'number' },
      { key: 'samples_result', label: 'Combine samples', type: 'select', options: ['median', 'average'] },
      { key: 'sample_retract_dist', label: 'Retract between samples', type: 'number' },
      { key: 'samples_tolerance', label: 'Sample tolerance', type: 'number' },
      { key: 'samples_tolerance_retries', label: 'Tolerance retries', type: 'number' },
      { key: 'activate_gcode', label: 'Before probing (G-code)', type: 'code' },
    ],
  },
  {
    id: 'accel', icon: 'Accel', title: (n) => `Accelerometer (${n})`, match: (n) => /^(adxl345|lis2dw|lis3dh|mpu9250|icm20948)\b/.test(n),
    fields: [
      { key: 'axes_map', label: 'Axes map', type: 'text', help: 'e.g. x,z,y' },
      { key: 'rate', label: 'Rate', type: 'number' },
      { key: 'cs_pin', label: 'CS pin', type: 'pin' },
      { key: 'spi_bus', label: 'SPI bus', type: 'text' },
      { key: 'spi_software_sclk_pin', label: 'SCLK pin', type: 'pin' },
      { key: 'spi_software_mosi_pin', label: 'MOSI pin', type: 'pin' },
      { key: 'spi_software_miso_pin', label: 'MISO pin', type: 'pin' },
    ],
  },
  {
    id: 'macro', icon: 'Macro', title: (n) => `Select macro (${n.split(' ')[1]})`, match: (n) => /^gcode_macro\s/.test(n),
    fields: [
      { key: 'gcode', label: 'G-code', type: 'code' },
      { key: 'variable_color', label: 'Color variable', type: 'text' },
    ],
  },
]

const GENERIC: SectionKind = { id: 'other', icon: 'Other', title: (n) => n, match: () => true, fields: [] }

export function kindOf(sectionName: string): SectionKind {
  const n = normalizeSection(sectionName)
  return SECTION_KINDS.find((k) => k.match(n)) ?? GENERIC
}

export interface Change {
  section: string
  key: string
  before: string | undefined
  after: string | undefined
  apply: Apply
}

/** Option-level differences between two versions of a file (by section name + key). */
export function diffCfg(before: string, after: string): { changes: Change[]; structural: boolean } {
  const map = (secs: CfgSection[]) => {
    const m = new Map<string, Map<string, string>>()
    for (const s of secs) {
      const k = normalizeSection(s.name)
      const inner = m.get(k) ?? new Map<string, string>()
      for (const [key, o] of s.options) inner.set(key, o.value)
      m.set(k, inner)
    }
    return m
  }
  const a = map(parseCfg(before))
  const b = map(parseCfg(after))
  const changes: Change[] = []
  const sections = new Set([...a.keys(), ...b.keys()])
  let structural = false
  for (const sec of sections) {
    if (!a.has(sec) || !b.has(sec)) structural = true
    const ka = a.get(sec) ?? new Map()
    const kb = b.get(sec) ?? new Map()
    for (const key of new Set([...ka.keys(), ...kb.keys()])) {
      const x = ka.get(key)
      const y = kb.get(key)
      if (x === y) continue
      const field = kindOf(sec).fields.find((f) => f.key === key)
      // added/removed keys and sections always need a restart
      const apply: Apply = x !== undefined && y !== undefined && field?.apply === 'live' ? 'live' : 'restart'
      changes.push({ section: sec, key, before: x, after: y, apply })
    }
  }
  return { changes, structural }
}

/** Klipper command that applies a change without a restart, if there is one. */
export function liveCommand(c: Change, toolNumber: number, extruder: string | null): string | null {
  if (c.apply !== 'live' || c.after === undefined) return null
  const field = kindOf(c.section).fields.find((f) => f.key === c.key)
  if (/^tool\s/.test(c.section)) {
    const v = field?.quoted ? `'${c.after.replace(/^['"]|['"]$/g, '')}'` : c.after
    return `SET_TOOL_PARAMETER T=${toolNumber} PARAMETER=${c.key} VALUE="${v}"`
  }
  if (extruder && normalizeSection(c.section) === normalizeSection(extruder)) {
    if (c.key === 'rotation_distance') return `SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=${extruder} DISTANCE=${c.after}`
    if (c.key === 'pressure_advance') return `SET_PRESSURE_ADVANCE EXTRUDER=${extruder} ADVANCE=${c.after}`
    if (c.key === 'pressure_advance_smooth_time') return `SET_PRESSURE_ADVANCE EXTRUDER=${extruder} SMOOTH_TIME=${c.after}`
  }
  return null
}
