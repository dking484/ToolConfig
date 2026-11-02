// The tools as the config files define them, for when Klipper isn't running
// (a config error, or a board it can't reach) and has no status to read.
import { normalizeSection, type CfgSection } from './cfgEdit'
import { dockWarnings, pinMcu, type McuInfo, type ToolInfo } from './tools'

type Options = Map<string, string>

/** section -> options as Klipper would end up with them: files in include order, later wins, SAVE_CONFIG last. */
export function mergeSections(files: { sections: CfgSection[] }[], autosave?: Map<string, Map<string, string>>): Map<string, Options> {
  const out = new Map<string, Options>()
  const at = (name: string) => {
    const k = normalizeSection(name)
    if (!out.has(k)) out.set(k, new Map())
    return out.get(k)!
  }
  for (const f of files) for (const s of f.sections) for (const [k, o] of s.options) at(s.name).set(k, o.value)
  for (const [sec, opts] of autosave ?? []) for (const [k, v] of opts) at(sec).set(k, v)
  return out
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

/** Display names of the [tool ...] sections, e.g. "tool T0", in config order. */
function toolNames(files: { sections: CfgSection[] }[]): string[] {
  const seen = new Map<string, string>()
  for (const f of files) for (const s of f.sections) if (/^tool\s+\S+$/i.test(s.name) && !seen.has(normalizeSection(s.name))) seen.set(normalizeSection(s.name), s.name.replace(/\s+/g, ' '))
  return [...seen.values()]
}

export function toolsFromConfig(files: { sections: CfgSection[] }[], autosave?: Map<string, Map<string, string>>, unreachable = ''): ToolInfo[] {
  const merged = mergeSections(files, autosave)
  const sec = (name: string): Options => merged.get(normalizeSection(name)) ?? new Map()
  const changer = sec('toolchanger')
  return toolNames(files)
    .map((name): ToolInfo => {
      const t = sec(name)
      // tool options fall back to the [toolchanger] defaults (params_*, paths)
      const opt = (k: string) => t.get(k) ?? changer.get(k)
      const number = num(t.get('tool_number')) ?? Number(name.match(/(\d+)$/)?.[1] ?? -1)
      const extruder = t.get('extruder') ?? null
      const ex = extruder ? sec(extruder) : new Map<string, string>()
      const probeName = `tool_probe T${number}`
      const probe = merged.get(normalizeSection(probeName))
      const mcuName = pinMcu(ex.get('heater_pin')) ?? pinMcu(probe?.get('pin')) ?? pinMcu(ex.get('step_pin'))
      const m = mcuName ? sec(`mcu ${mcuName}`) : null
      const mcu: McuInfo | null =
        mcuName && m
          ? { name: mcuName, canbusUuid: m.get('canbus_uuid') ?? null, serial: m.get('serial') ?? null, version: null, connected: false, mcuType: null, retransmits: null }
          : null
      const park = { x: num(opt('params_park_x')) ?? NaN, y: num(opt('params_park_y')) ?? NaN, z: num(opt('params_park_z')) ?? NaN }
      const warnings: string[] = []
      warnings.push(...dockWarnings(park))
      if (mcuName && mcuName === unreachable) warnings.push(`Klipper can't reach its board ${mcuName}`)
      return {
        number,
        name,
        label: `T${number}`,
        active: false,
        extruder,
        temp: null,
        target: null,
        power: null,
        nozzle: num(ex.get('nozzle_diameter')),
        pressureAdvance: num(ex.get('pressure_advance')),
        park,
        safeY: num(opt('params_safe_y')) ?? NaN,
        closeY: num(opt('params_close_y')) ?? NaN,
        offset: { x: num(t.get('gcode_x_offset')) ?? 0, y: num(t.get('gcode_y_offset')) ?? 0, z: num(t.get('gcode_z_offset')) ?? 0 },
        probeName: probe ? probeName : null,
        probeZOffset: num(probe?.get('z_offset')),
        probeState: 'unknown',
        where: 'unknown',
        fan: t.get('fan') ?? null,
        shaper: {
          x: opt('params_input_shaper_type_x') ?? '',
          fx: num(opt('params_input_shaper_freq_x')) ?? 0,
          y: opt('params_input_shaper_type_y') ?? '',
          fy: num(opt('params_input_shaper_freq_y')) ?? 0,
        },
        mcu,
        color: null,
        warnings,
        source: 'config',
      }
    })
    .sort((a, b) => a.number - b.number)
}
