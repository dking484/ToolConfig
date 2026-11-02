import { describe, expect, it } from 'vitest'
import { dockUnset, dockWarnings } from './tools'

describe('dockUnset', () => {
  it('treats blank, 0/0/0 and -1/-1/-1 as never taught', () => {
    expect(dockUnset({ x: NaN, y: 4.5, z: 298 })).toBe(true)
    expect(dockUnset({ x: 0, y: 0, z: 0 })).toBe(true)
    expect(dockUnset({ x: -1, y: -1, z: -1 })).toBe(true)
  })
  it('accepts a taught position, even with one axis at 0', () => {
    expect(dockUnset({ x: 334.8, y: 4.5, z: 298.35 })).toBe(false)
    expect(dockUnset({ x: 13.6, y: 0, z: 296.6 })).toBe(false)
  })
})

describe('dockWarnings', () => {
  it('names the blank axes', () => {
    expect(dockWarnings({ x: NaN, y: 1, z: NaN })).toEqual(['params_park_x is not set', 'params_park_z is not set'])
  })
  it('flags an all-zero dock', () => {
    expect(dockWarnings({ x: 0, y: 0, z: 0 })[0]).toMatch(/Dock position not set/)
  })
  it('is quiet for a taught dock', () => {
    expect(dockWarnings({ x: 94.65, y: 5.5, z: 297.25 })).toEqual([])
  })
})
