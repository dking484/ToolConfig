import T1 from './fixtures/T1.cfg?raw'
import { describe, expect, it } from 'vitest'
import { setOption } from './cfgEdit'
import { diffCfg, kindOf, liveCommand } from './toolSchema'


describe('kindOf', () => {
  it('recognises every section of a tool file', () => {
    expect(kindOf('mcu EBBT1').id).toBe('mcu')
    expect(kindOf('extruder1').id).toBe('extruder')
    expect(kindOf('extruder').id).toBe('extruder')
    expect(kindOf('tmc2209 extruder1').id).toBe('tmc')
    expect(kindOf('fan_generic T1_partfan').id).toBe('partfan')
    expect(kindOf('heater_fan T1_hotend_fan').id).toBe('hotendfan')
    expect(kindOf('neopixel TOOL1_RGB').id).toBe('leds')
    expect(kindOf('tool T1').id).toBe('tool')
    expect(kindOf('tool_probe T1').id).toBe('probe')
    expect(kindOf('adxl345 T1').id).toBe('accel')
    expect(kindOf('gcode_macro T1').id).toBe('macro')
    expect(kindOf('filament_switch_sensor FS1').id).toBe('other')
  })
})

describe('diffCfg + liveCommand', () => {
  it('a dock position change is live', () => {
    const after = setOption(T1, 'tool T1', 'params_park_y', '11.2')
    const { changes, structural } = diffCfg(T1, after)
    expect(structural).toBe(false)
    expect(changes).toEqual([{ section: 'tool t1', key: 'params_park_y', before: '10.2', after: '11.2', apply: 'live' }])
    expect(liveCommand(changes[0], 1, 'extruder1')).toBe('SET_TOOL_PARAMETER T=1 PARAMETER=params_park_y VALUE="11.2"')
  })
  it('quoted shaper types are applied as Python strings', () => {
    const after = setOption(T1, 'tool T1', 'params_input_shaper_type_x', "'ei'")
    const c = diffCfg(T1, after).changes[0]
    expect(liveCommand(c, 1, 'extruder1')).toBe(`SET_TOOL_PARAMETER T=1 PARAMETER=params_input_shaper_type_x VALUE="'ei'"`)
  })
  it('pressure advance is live on the right extruder', () => {
    const c = diffCfg(T1, setOption(T1, 'extruder1', 'pressure_advance', '0.035')).changes[0]
    expect(liveCommand(c, 1, 'extruder1')).toBe('SET_PRESSURE_ADVANCE EXTRUDER=extruder1 ADVANCE=0.035')
  })
  it('a pin or nozzle change needs a restart', () => {
    const c = diffCfg(T1, setOption(T1, 'extruder1', 'nozzle_diameter', '0.6')).changes[0]
    expect(c.apply).toBe('restart')
    expect(liveCommand(c, 1, 'extruder1')).toBeNull()
  })
  it('a new key needs a restart even on a live field', () => {
    const c = diffCfg(T1, setOption(T1, 'tool T1', 'params_close_y', '30')).changes[0]
    expect(c.apply).toBe('restart')
  })
  it('a new section is structural', () => {
    expect(diffCfg(T1, T1 + '\n[temperature_sensor T1_board]\nsensor_type: temperature_mcu\nsensor_mcu: EBBT1\n').structural).toBe(true)
  })
})
