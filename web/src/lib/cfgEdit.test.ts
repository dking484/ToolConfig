import { describe, expect, it } from 'vitest'
import { findSection, parseAutosave, parseCfg, parseIncludes, setOption } from './cfgEdit'

const T0 = `# If you are using CAN, define the board info
[mcu EBBT0]
canbus_uuid: f57a106c454c

[extruder]
nozzle_diameter: 0.400 # Nozzle diameter
heater_pin: EBBT0: PB13 #PA2
control=pid

[tool T0]
tool_number: 0
params_sc_path: [{'y':9.5 ,'z':4}, {'y':9.5, 'z':2}]
params_park_x: 13.8
params_park_y: 15.6
params_park_z: 297.3

[tool_probe T0]
pin: ^EBBT0:PB6
z_offset: -1.0 #05 # Z axis-sensor relative nozzle offset
activate_gcode:
    _TAP_PROBE_ACTIVATE HEATER=extruder
`

describe('parseCfg', () => {
  it('finds sections and options', () => {
    const s = parseCfg(T0)
    expect(s.map((x) => x.name)).toEqual(['mcu EBBT0', 'extruder', 'tool T0', 'tool_probe T0'])
    expect(findSection(s, 'tool t0')!.options.get('params_park_y')!.value).toBe('15.6')
    expect(findSection(s, 'extruder')!.options.get('nozzle_diameter')!.value).toBe('0.400')
    expect(findSection(s, 'extruder')!.options.get('control')!.value).toBe('pid')
  })
  it('keeps multi-line values', () => {
    const s = parseCfg(T0)
    expect(findSection(s, 'tool_probe T0')!.options.get('activate_gcode')!.value).toBe(
      '\n_TAP_PROBE_ACTIVATE HEATER=extruder',
    )
  })
  it('strips inline comments but not pin colons', () => {
    const s = parseCfg(T0)
    expect(findSection(s, 'extruder')!.options.get('heater_pin')!.value).toBe('EBBT0: PB13')
  })
})

describe('setOption', () => {
  it('replaces a value and keeps the comment', () => {
    const out = setOption(T0, 'tool_probe T0', 'z_offset', '-1.25')
    expect(out).toContain('z_offset: -1.25 #05 # Z axis-sensor relative nozzle offset')
    expect(out.split('\n').length).toBe(T0.split('\n').length)
  })
  it('only touches the requested line', () => {
    const out = setOption(T0, 'tool T0', 'params_park_y', '16.1')
    const a = T0.split('\n')
    const b = out.split('\n')
    const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((x) => x !== null)
    expect(changed).toHaveLength(1)
    expect(b[changed[0]!]).toBe('params_park_y: 16.1')
  })
  it('keeps "=" separators', () => {
    expect(setOption(T0, 'extruder', 'control', 'watermark')).toContain('control=watermark')
  })
  it('adds a missing key at the end of the section', () => {
    const out = setOption(T0, 'tool T0', 'gcode_z_offset', '0.05')
    const s = parseCfg(out)
    const sec = findSection(s, 'tool T0')!
    expect(sec.options.get('gcode_z_offset')!.value).toBe('0.05')
    expect(out).toMatch(/params_park_z: 297.3\ngcode_z_offset: 0.05\n/)
  })
  it('throws on a missing section', () => {
    expect(() => setOption(T0, 'tool T9', 'x', '1')).toThrow()
  })
  it('preserves CRLF line endings', () => {
    const crlf = T0.replace(/\n/g, '\r\n')
    const out = setOption(crlf, 'tool T0', 'params_park_x', '14')
    expect(out).toContain('params_park_x: 14\r\n')
    expect(out.includes('\n') && !/[^\r]\n/.test(out)).toBe(true)
  })
})

describe('autosave + includes', () => {
  const printer = `[include mainsail.cfg]
[include toolchanger/readonly-configs/toolchanger-include.cfg]
[include toolchanger/toolchanger-safety.cfg]  # comment

[printer]
kinematics: corexy

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [stepper_z]
#*# position_endstop = -0.500
#*#
#*# [tool_probe_endstop]
#*# z_offset = -1.350
`
  it('reads the SAVE_CONFIG block', () => {
    const a = parseAutosave(printer)
    expect(a.get('tool_probe_endstop')!.get('z_offset')).toBe('-1.350')
    expect(a.get('stepper_z')!.get('position_endstop')).toBe('-0.500')
  })
  it('does not treat the SAVE_CONFIG block as normal options', () => {
    const s = parseCfg(printer)
    expect(s.map((x) => x.name)).toEqual(['include mainsail.cfg', 'include toolchanger/readonly-configs/toolchanger-include.cfg', 'include toolchanger/toolchanger-safety.cfg', 'printer'])
  })
  it('lists includes in order', () => {
    expect(parseIncludes(printer)).toEqual([
      'mainsail.cfg',
      'toolchanger/readonly-configs/toolchanger-include.cfg',
      'toolchanger/toolchanger-safety.cfg',
    ])
  })
})
