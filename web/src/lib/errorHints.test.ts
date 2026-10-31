import { describe, expect, it } from 'vitest'
import { errorHint } from './errorHints'

describe('errorHint', () => {
  it('explains a probe that never triggered (QGL on a badly racked gantry)', () => {
    expect(errorHint('No trigger on probe after full movement')).toMatch(/out of level/)
  })
  it('explains homing errors', () => {
    expect(errorHint('Must home axis first: 50.000 25.000 -5.000 [0.000]')).toMatch(/Home/)
  })
  it('has nothing for unknown errors', () => {
    expect(errorHint('Unknown command:"FOO"')).toBe('')
  })
})
