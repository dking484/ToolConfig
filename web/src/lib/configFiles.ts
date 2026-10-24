// Follow printer.cfg includes the way Klipper does, so we know which file
// actually provides each [section] key, and edit that file safely.
import { normalizeSection, parseAutosave, parseCfg, setOption, type CfgSection } from './cfgEdit'
import type { Moonraker } from './moonraker'

export interface LoadedFile {
  path: string // relative to the config root
  text: string
  sections: CfgSection[]
  editable: boolean
}

export interface Location {
  file: LoadedFile
  section: CfgSection
  defined: boolean // key is present (false = would be added)
}

// Files that are symlinks into other repos / generated: never edit these.
const READONLY = [/readonly-configs\//, /^mainsail\.cfg$/, /^timelapse\.cfg$/, /^KAMP\//, /^tapchanger\//, /toolchanger-safety\.cfg$/]

export class ConfigIndex {
  files: LoadedFile[] = [] // in Klipper include order
  autosave = new Map<string, Map<string, string>>()
  private allPaths: string[] = []

  constructor(private mr: Moonraker) {}

  async load() {
    const list: { path: string }[] = await this.mr.call('server.files.list', { root: 'config' })
    this.allPaths = list.map((f) => f.path).filter((p) => p.endsWith('.cfg'))
    this.files = []
    const seen = new Set<string>()
    await this.visit('printer.cfg', seen)
    const printer = this.files.find((f) => f.path === 'printer.cfg')
    this.autosave = printer ? parseAutosave(printer.text) : new Map()
  }

  private async visit(path: string, seen: Set<string>) {
    if (seen.has(path)) return
    seen.add(path)
    const text = await this.mr.getText('config', path)
    const sections = parseCfg(text)
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    // Klipper processes includes in place: sections before the include come
    // first, then the included file, then the rest. Model that by splitting.
    const lines = text.split(/\r?\n/)
    let chunkStart = 0
    const flushChunk = (endLine: number) => {
      const chunk = lines.slice(chunkStart, endLine).join('\n')
      if (chunk.trim()) {
        const secs = sections.filter((s) => s.line >= chunkStart && s.line < endLine && !s.name.startsWith('include '))
        if (secs.length) this.files.push({ path, text, sections: secs, editable: !READONLY.some((r) => r.test(path)) })
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\[include\s+([^\]]+)\]/)
      if (!m) continue
      flushChunk(i)
      chunkStart = i + 1
      for (const target of this.resolve(dir, m[1].trim())) await this.visit(target, seen)
    }
    flushChunk(lines.length)
  }

  private resolve(dir: string, pattern: string): string[] {
    const joined = normalizePath(dir + pattern)
    if (!/[*?[]/.test(joined)) return [joined]
    const re = new RegExp('^' + joined.split('*').map(escapeRe).join('[^/]*') + '$')
    return this.allPaths.filter((p) => re.test(p)).sort()
  }

  /** Where Klipper takes [section] key from (last definition wins). */
  locate(section: string, key: string): Location | null {
    const want = normalizeSection(section)
    const k = key.toLowerCase()
    let lastSection: Location | null = null
    let lastDefined: Location | null = null
    for (const file of this.files) {
      for (const s of file.sections) {
        if (normalizeSection(s.name) !== want) continue
        lastSection = { file, section: s, defined: s.options.has(k) }
        if (s.options.has(k)) lastDefined = lastSection
      }
    }
    return lastDefined ?? lastSection
  }

  /** All files defining [section] key, in include order (for "overridden by" hints). */
  definitions(section: string, key: string): LoadedFile[] {
    const want = normalizeSection(section)
    return this.files.filter((f) => f.sections.some((s) => normalizeSection(s.name) === want && s.options.has(key.toLowerCase())))
  }

  autosaveValue(section: string, key: string): string | undefined {
    return this.autosave.get(normalizeSection(section))?.get(key.toLowerCase())
  }

  /**
   * Apply several edits. Each is written to the file Klipper reads it from;
   * a missing key is added to the section's last definition. Every touched
   * file is backed up first. Returns the paths written.
   */
  async write(edits: { section: string; key: string; value: string }[]): Promise<string[]> {
    const byFile = new Map<string, { file: LoadedFile; text: string }>()
    for (const e of edits) {
      const loc = this.locate(e.section, e.key)
      if (!loc) throw new Error(`[${e.section}] is not defined in any config file`)
      if (!loc.file.editable) throw new Error(`[${e.section}] ${e.key} comes from ${loc.file.path}, which is read-only. Override it in toolchanger/toolchanger-config.cfg instead.`)
      const entry = byFile.get(loc.file.path) ?? { file: loc.file, text: loc.file.text }
      entry.text = setOption(entry.text, loc.section.name, e.key, e.value)
      byFile.set(loc.file.path, entry)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    for (const { file, text } of byFile.values()) {
      if (text === file.text) continue
      await this.mr.upload('config', `toolconfig-backups/${file.path.replace(/\//g, '__')}.${stamp}.bak`, file.text)
      await this.mr.upload('config', file.path, text)
    }
    await this.load()
    return [...byFile.keys()]
  }
}

function normalizePath(p: string) {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

function escapeRe(s: string) {
  return s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
}
