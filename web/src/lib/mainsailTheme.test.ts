import { describe, expect, it } from 'vitest'
import { readableOn, resolveTheme } from './mainsailTheme'

describe('resolveTheme', () => {
  it('uses Mainsail defaults when nothing is stored (this printer)', () => {
    expect(resolveTheme({ displayCancelPrint: true }, null, [])).toEqual({
      mode: 'dark', primary: '#2196f3', onPrimary: '#ffffff', logoColor: '#D41216', logoUrl: null, theme: 'mainsail',
    })
  })
  it('follows mode and custom colors', () => {
    const t = resolveTheme({ mode: 'light', primary: '#4CAF50', logo: '#123456' }, null, [])
    expect([t.mode, t.primary, t.logoColor]).toEqual(['light', '#4CAF50', '#123456'])
  })
  it('a preset brings its colors and logo', () => {
    const t = resolveTheme({ theme: 'ldo' }, null, [])
    expect([t.primary, t.logoColor, t.logoUrl]).toEqual(['#326799', '#326799', '/img/themes/sidebarLogo-ldo.svg'])
  })
  it('an uploaded .theme/sidebar-logo wins over the preset logo', () => {
    expect(resolveTheme({ theme: 'voron' }, null, ['navi.json', 'sidebar-logo.png']).logoUrl).toBe('/server/files/config/.theme/sidebar-logo.png')
  })
  it("falls back to Mainsail's config.json defaults, and ignores junk", () => {
    const t = resolveTheme({ primary: 'not-a-color', theme: 42 }, { defaultMode: 'light', defaultTheme: 'prusa' }, [])
    expect([t.mode, t.theme, t.primary]).toEqual(['light', 'prusa', '#fa6831'])
  })
  it('unknown theme names behave like the Mainsail theme', () => {
    expect(resolveTheme({ theme: 'future-theme' }, null, []).theme).toBe('mainsail')
  })
})

describe('readableOn', () => {
  it('white on dark/saturated colors, dark on light ones', () => {
    expect(readableOn('#2196f3')).toBe('#ffffff')
    expect(readableOn('#326799')).toBe('#ffffff')
    expect(readableOn('#F6CF3D')).toBe('#111111') // YUMI yellow
    expect(readableOn('#fff')).toBe('#111111')
  })
})
