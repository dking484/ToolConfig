// Follow the look the user picked in Mainsail (framework-agnostic).
//
// Mainsail keeps its UI settings in Moonraker's database (namespace "mainsail",
// key "uiSettings") and only stores values that differ from its defaults. The
// field names and presets below match Mainsail 2.x; they are not a public API,
// so anything missing or unknown falls back to Mainsail's defaults.

export interface MainsailThemePreset {
  name: string
  colorLogo: string
  colorPrimary?: string
  logo?: { show: boolean; light: boolean }
}

// From Mainsail 2.19 (store/variables): defaults + theme presets
export const MAINSAIL_DEFAULTS = { mode: 'dark' as const, theme: 'mainsail', logo: '#D41216', primary: '#2196f3' }
export const MAINSAIL_PRESETS: MainsailThemePreset[] = [
  { name: 'mainsail', colorLogo: '#D41216' },
  { name: 'klipper', colorLogo: '#b12f35', logo: { show: true, light: false } },
  { name: 'voron', colorLogo: '#FF2300', logo: { show: true, light: false } },
  { name: 'ldo', colorLogo: '#326799', colorPrimary: '#326799', logo: { show: true, light: false } },
  { name: 'yumi', colorLogo: '#F6CF3D', colorPrimary: '#F6CF3D', logo: { show: true, light: false } },
  { name: 'vzbot', colorLogo: '#FF0000', logo: { show: true, light: false } },
  { name: 'prusa', colorLogo: '#fa6831', colorPrimary: '#fa6831', logo: { show: true, light: false } },
  { name: 'btt', colorLogo: '#ef0025', logo: { show: true, light: false } },
  { name: 'multec', colorLogo: '#234D7A', colorPrimary: '#234D7A', logo: { show: true, light: false } },
]

export interface ResolvedTheme {
  mode: 'dark' | 'light'
  primary: string
  onPrimary: string // readable text color on the primary color
  logoColor: string
  logoUrl: string | null // image to show instead of the built-in icon
  theme: string
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * @param ui        mainsail.uiSettings from Moonraker's database (may be partial or missing)
 * @param config    Mainsail's /config.json (defaultMode / defaultTheme), if readable
 * @param themeFiles file names in the config root's .theme folder
 */
export function resolveTheme(ui: Record<string, any> | null, config: Record<string, any> | null, themeFiles: string[]): ResolvedTheme {
  const mode = ui?.mode === 'light' || ui?.mode === 'dark' ? ui.mode : config?.defaultMode === 'light' ? 'light' : MAINSAIL_DEFAULTS.mode
  const theme = typeof ui?.theme === 'string' ? ui.theme : typeof config?.defaultTheme === 'string' ? config.defaultTheme : MAINSAIL_DEFAULTS.theme
  const preset = MAINSAIL_PRESETS.find((p) => p.name === theme) ?? MAINSAIL_PRESETS[0]
  const primary = HEX.test(ui?.primary ?? '') ? ui!.primary : preset.colorPrimary ?? MAINSAIL_DEFAULTS.primary
  const logoColor = HEX.test(ui?.logo ?? '') ? ui!.logo : preset.colorLogo
  // Mainsail's order: an uploaded .theme/sidebar-logo.* wins, then the preset's logo
  const custom = themeFiles.find((f) => /^sidebar-logo\.(svg|png|jpe?g|gif|webp)$/i.test(f))
  let logoUrl: string | null = null
  if (custom) logoUrl = `/server/files/config/.theme/${custom}`
  else if (preset.logo?.show) logoUrl = `/img/themes/sidebarLogo-${preset.name}${preset.logo.light && mode === 'light' ? '-light' : ''}.svg`
  return { mode, primary, onPrimary: readableOn(primary), logoColor, logoUrl, theme: preset.name }
}

/**
 * Text color for buttons in `hex`. Like Mainsail (Material), white unless it
 * would fall under the 3:1 contrast WCAG asks for UI components; then near-black.
 */
export function readableOn(hex: string): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const contrastWithWhite = 1.05 / (L + 0.05)
  return contrastWithWhite >= 3 ? '#ffffff' : '#111111'
}
