import { describe, expect, it } from 'vitest'
import { parseCfg } from './cfgEdit'
import { toolsFromConfig } from './configTools'

const changer = parseCfg(`[toolchanger]
params_safe_y: 120
params_park_z: 290
`)
const t4 = parseCfg(`[mcu EBBT4]
canbus_uuid: 39eba9e3668d

[extruder4]
heater_pin: EBBT4: PB13
nozzle_diameter: 0.400

[tool T4]
tool_number: 4
extruder: extruder4
fan: multi_fan T4_partfan
gcode_z_offset: 0.050
params_park_x: 334.8
params_park_y: 4.5 # taught 10-30
params_park_z: 298.35

[tool_probe T4]
pin: ^EBBT4:PB6
z_offset: -0.969
`)
const t0 = parseCfg(`[tool T0]
tool_number: 0
`)
const files = [{ sections: changer }, { sections: t4 }, { sections: t0 }]

describe('toolsFromConfig', () => {
  const tools = toolsFromConfig(files, undefined, 'EBBT4')
  const t = tools.find((x) => x.number === 4)!

  it('lists every [tool] section, by number', () => {
    expect(tools.map((x) => x.label)).toEqual(['T0', 'T4'])
  })
  it('reads park, offsets, probe and board from the files', () => {
    expect(t.park).toEqual({ x: 334.8, y: 4.5, z: 298.35 })
    expect(t.offset.z).toBe(0.05)
    expect(t.probeZOffset).toBe(-0.969)
    expect(t.nozzle).toBe(0.4)
    expect(t.mcu?.name).toBe('EBBT4')
    expect(t.mcu?.canbusUuid).toBe('39eba9e3668d')
    expect(t.source).toBe('config')
  })
  it('falls back to the [toolchanger] defaults', () => {
    expect(t.safeY).toBe(120)
    expect(tools[0].park.z).toBe(290)
  })
  it('flags the board Klipper cannot reach', () => {
    expect(t.warnings).toContain("Klipper can't reach its board EBBT4")
  })
  it('lets SAVE_CONFIG override the files', () => {
    const auto = new Map([['tool_probe t4', new Map([['z_offset', '-1.1']])]])
    expect(toolsFromConfig(files, auto).find((x) => x.number === 4)!.probeZOffset).toBe(-1.1)
  })
})
