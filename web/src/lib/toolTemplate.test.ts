import T1 from './fixtures/T1.cfg?raw'
import { describe, expect, it } from 'vitest'
import { findSection, parseCfg, removeOption } from './cfgEdit'
import { cloneToolConfig, nextToolNumber, suggestMcuName } from './toolTemplate'


const opt = (text: string, section: string, key: string) => findSection(parseCfg(text), section)?.options.get(key)?.value

describe('cloneToolConfig T1 -> T5', () => {
  const out = cloneToolConfig(T1, {
    srcNumber: 1,
    dstNumber: 5,
    srcMcu: 'EBBT1',
    dstMcu: 'EBBT5',
    board: { kind: 'can', uuid: 'aabbccddeeff' },
    nozzle: '0.6',
  })
  const names = parseCfg(out).map((s) => s.name)

  it('renames every tool-bound section', () => {
    expect(names).toEqual([
      'mcu EBBT5', 'extruder5', 'tmc2209 extruder5', 'fan_generic T5_partfan', 'heater_fan T5_hotend_fan',
      'neopixel TOOL5_RGB', 'gcode_macro T5', 'tool T5', 'tool_probe T5', 'adxl345 T5',
    ])
  })
  it('leaves no reference to the source tool', () => {
    const body = out.split('\n').filter((l) => !l.startsWith('#')).join('\n')
    expect(body).not.toMatch(/EBBT1|extruder1\b|\bT1\b|T1_|TOOL1_|T=1\b/)
  })
  it('renames pins, fans, heater and macro references', () => {
    expect(opt(out, 'extruder5', 'step_pin')).toBe('EBBT5:PD0')
    expect(opt(out, 'tool T5', 'extruder')).toBe('extruder5')
    expect(opt(out, 'tool T5', 'fan')).toBe('T5_partfan')
    expect(opt(out, 'heater_fan T5_hotend_fan', 'heater')).toBe('extruder5')
    expect(opt(out, 'gcode_macro T5', 'gcode')).toBe('\nSELECT_TOOL T=5')
    expect(opt(out, 'tool_probe T5', 'activate_gcode')).toBe('\n_TAP_PROBE_ACTIVATE HEATER=extruder5')
    expect(opt(out, 'tool_probe T5', 'pin')).toBe('^EBBT5:PB6')
  })
  it('sets numbers, board and basics, and invalidates the dock', () => {
    expect(opt(out, 'tool T5', 'tool_number')).toBe('5')
    expect(opt(out, 'tool_probe T5', 'tool')).toBe('5')
    expect(opt(out, 'mcu EBBT5', 'canbus_uuid')).toBe('aabbccddeeff')
    expect(opt(out, 'extruder5', 'nozzle_diameter')).toBe('0.6')
    expect(opt(out, 'tool T5', 'params_park_x')).toBe('-1')
    expect(opt(out, 'tool T5', 'params_park_z')).toBe('-1')
    expect(opt(out, 'tool T5', 'gcode_x_offset')).toBe('0')
  })
  it('keeps everything else (PID, shaper, currents) and the comments', () => {
    expect(opt(out, 'extruder5', 'pid_kp')).toBe('21.527')
    expect(opt(out, 'tmc2209 extruder5', 'run_current')).toBe('0.6')
    expect(opt(out, 'tool T5', 'params_input_shaper_freq_x')).toBe('60.1')
    expect(out).toContain('# Driving pulley circumference mm')
    expect(out.startsWith('# T5: created by ToolConfig from T1')).toBe(true)
  })
})

describe('cloneToolConfig with tool 0 (extruder without a number)', () => {
  it('T1 -> T0 names the extruder "extruder"', () => {
    const out = cloneToolConfig(T1, { srcNumber: 1, dstNumber: 0, srcMcu: 'EBBT1', dstMcu: 'EBBT0', board: { kind: 'later' } })
    expect(parseCfg(out).map((s) => s.name)).toContain('extruder')
    expect(opt(out, 'tool T0', 'extruder')).toBe('extruder')
    expect(opt(out, 'mcu EBBT0', 'canbus_uuid')).toBe('SET_ME')
  })
  it('T0 -> T2 renames "extruder" values but never the "extruder:" key', () => {
    const t0 = cloneToolConfig(T1, { srcNumber: 1, dstNumber: 0, srcMcu: 'EBBT1', dstMcu: 'EBBT0', board: { kind: 'later' } })
    const out = cloneToolConfig(t0, { srcNumber: 0, dstNumber: 2, srcMcu: 'EBBT0', dstMcu: 'EBBT2', board: { kind: 'usb', serial: '/dev/serial/by-id/usb-Klipper_x' } })
    expect(opt(out, 'tool T2', 'extruder')).toBe('extruder2')
    expect(findSection(parseCfg(out), 'tool T2')!.options.has('extruder2')).toBe(false)
    expect(opt(out, 'heater_fan T2_hotend_fan', 'heater')).toBe('extruder2')
    expect(opt(out, 'mcu EBBT2', 'serial')).toBe('/dev/serial/by-id/usb-Klipper_x')
    expect(findSection(parseCfg(out), 'mcu EBBT2')!.options.has('canbus_uuid')).toBe(false)
  })
})

describe('helpers', () => {
  it('nextToolNumber fills the first gap', () => {
    expect(nextToolNumber([0, 1, 2, 3, 4])).toBe(5)
    expect(nextToolNumber([0, 2])).toBe(1)
  })
  it('suggestMcuName follows the source naming', () => {
    expect(suggestMcuName('EBBT1', 1, 5)).toBe('EBBT5')
    expect(suggestMcuName('toolhead', 1, 5)).toBe('toolhead_T5')
  })
  it('removeOption drops a key and its continuation lines', () => {
    const out = removeOption(T1, 'tool_probe T1', 'activate_gcode')
    expect(findSection(parseCfg(out), 'tool_probe T1')!.options.has('activate_gcode')).toBe(false)
    expect(out).not.toContain('_TAP_PROBE_ACTIVATE HEATER=extruder1')
    expect(findSection(parseCfg(out), 'adxl345 T1')!.options.get('cs_pin')!.value).toBe('EBBT1:PB12')
  })
})
