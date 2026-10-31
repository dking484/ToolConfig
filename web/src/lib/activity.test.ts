import { describe, expect, it } from 'vitest'
import { elapsed, heating, latestMessage, type ConsoleLine } from './activity'

const log: ConsoleLine[] = [
  { time: 1000, text: 'G28', kind: 'cmd' },
  { time: 2000, text: '// Extruder temperature target 0.0C is below probe temp 150.0C, heating and waiting', kind: 'resp' },
  { time: 3000, text: 'B:24.4 /0.0 T0:23.6 /0.0 T4:148.0 /150.0', kind: 'resp' },
  { time: 4000, text: 'B:24.4 /0.0 T0:23.6 /0.0 T4:149.0 /150.0', kind: 'resp' },
]

describe('latestMessage', () => {
  it('skips temperature reports and strips the prefix', () => {
    expect(latestMessage(log, 0)).toBe('Extruder temperature target 0.0C is below probe temp 150.0C, heating and waiting')
  })
  it('ignores lines from before the command started', () => {
    expect(latestMessage(log, 2500)).toBe('')
  })
  it('keeps echo lines', () => {
    expect(latestMessage([{ time: 1, text: 'echo: Picking up tool T4', kind: 'resp' }], 0)).toBe('Picking up tool T4')
  })
})

describe('heating', () => {
  it('lists heaters still away from their target', () => {
    const hs = [
      { label: 'T4', temp: 120, target: 150 },
      { label: 'T0', temp: 149.5, target: 150 },
      { label: 'Bed', temp: 24, target: 0 },
    ]
    expect(heating(hs).map((h) => h.label)).toEqual(['T4'])
  })
})

describe('elapsed', () => {
  it('formats seconds and minutes', () => {
    expect(elapsed(23400)).toBe('23 s')
    expect(elapsed(125000)).toBe('2 min 05 s')
  })
})
