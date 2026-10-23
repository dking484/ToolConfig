// Comment-preserving reader/editor for Klipper .cfg files.
//
// Klipper rules this follows:
//  - "[section name]" headers start at column 0
//  - options start at column 0: "key: value" or "key = value"
//  - indented lines continue the previous option's value
//  - "#" or ";" start a comment; inline comments are kept on edit
//  - "#*#" lines are the SAVE_CONFIG block (read separately, never edited)

export interface CfgOption {
  key: string
  value: string
  line: number // 0-based index of the "key:" line
  endLine: number // last line of the value (continuations), inclusive
}

export interface CfgSection {
  name: string // as written, e.g. "tool T0"
  line: number
  endLine: number // last line belonging to this section, inclusive
  options: Map<string, CfgOption> // key lower-cased
}

const SECTION_RE = /^\[([^\]]+)\]/
const OPTION_RE = /^([A-Za-z0-9_.\-]+)\s*[:=]\s?(.*)$/
const SAVE_RE = /^#\*#/

export function stripInlineComment(value: string): { value: string; comment: string } {
  // Klipper treats '#' or ';' preceded by whitespace (or at start) as a comment.
  const m = value.match(/(^|\s)[#;]/)
  if (!m || m.index === undefined) return { value: value.trimEnd(), comment: '' }
  const idx = m.index + m[1].length
  return { value: value.slice(0, idx).trimEnd(), comment: value.slice(idx - m[1].length) }
}

export function parseCfg(text: string): CfgSection[] {
  const lines = text.split(/\r?\n/)
  const sections: CfgSection[] = []
  let cur: CfgSection | null = null
  let lastOpt: CfgOption | null = null
  lines.forEach((raw, i) => {
    if (SAVE_RE.test(raw)) {
      lastOpt = null
      return
    }
    const sec = raw.match(SECTION_RE)
    if (sec) {
      if (cur) cur.endLine = i - 1
      cur = { name: sec[1].trim(), line: i, endLine: i, options: new Map() }
      sections.push(cur)
      lastOpt = null
      return
    }
    if (!cur) return
    const trimmed = raw.trim()
    if (/^\s/.test(raw) && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith(';') && lastOpt) {
      lastOpt.endLine = i
      lastOpt.value += '\n' + trimmed
      return
    }
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return
    const opt = raw.match(OPTION_RE)
    if (opt) {
      lastOpt = {
        key: opt[1],
        value: stripInlineComment(opt[2]).value,
        line: i,
        endLine: i,
      }
      cur.options.set(opt[1].toLowerCase(), lastOpt)
    }
  })
  if (cur) (cur as CfgSection).endLine = lines.length - 1
  return sections
}

export function findSection(sections: CfgSection[], name: string): CfgSection | undefined {
  const want = normalizeSection(name)
  // Klipper merges duplicate sections; the last definition of a key wins.
  return [...sections].reverse().find((s) => normalizeSection(s.name) === want)
}

export function normalizeSection(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Set `key` in `[section]` to `value`. Keeps the inline comment and the
 * separator style of the existing line. If the key is missing it is added
 * after the section's last option. Returns the new file text.
 */
export function setOption(text: string, section: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const sections = parseCfg(text)
  const want = normalizeSection(section)
  const matches = sections.filter((s) => normalizeSection(s.name) === want)
  if (!matches.length) throw new Error(`Section [${section}] not found`)

  // Prefer the last section that already defines the key (that is the one Klipper uses).
  const withKey = [...matches].reverse().find((s) => s.options.has(key.toLowerCase()))
  const valueLines = value.split('\n')

  if (withKey) {
    const opt = withKey.options.get(key.toLowerCase())!
    const raw = lines[opt.line]
    const m = raw.match(/^([A-Za-z0-9_.\-]+)(\s*[:=]\s?)(.*)$/)!
    const { comment } = stripInlineComment(m[3])
    const first = `${m[1]}${m[2]}${valueLines[0]}${comment ? ' ' + comment.trimStart() : ''}`
    const rest = valueLines.slice(1).map((l) => '  ' + l)
    lines.splice(opt.line, opt.endLine - opt.line + 1, first, ...rest)
    return lines.join(eol)
  }

  const target = matches[matches.length - 1]
  let insertAt = target.line + 1
  for (const opt of target.options.values()) insertAt = Math.max(insertAt, opt.endLine + 1)
  const newLines = [`${key}: ${valueLines[0]}`, ...valueLines.slice(1).map((l) => '  ' + l)]
  lines.splice(insertAt, 0, ...newLines)
  return lines.join(eol)
}

/** Read the SAVE_CONFIG ("#*#") block: section -> key -> value. */
export function parseAutosave(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let cur: Map<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (!SAVE_RE.test(raw)) continue
    const body = raw.replace(/^#\*#\s?/, '')
    const sec = body.match(SECTION_RE)
    if (sec) {
      cur = new Map()
      out.set(normalizeSection(sec[1]), cur)
      continue
    }
    const opt = body.match(OPTION_RE)
    if (opt && cur) cur.set(opt[1].toLowerCase(), opt[2].trim())
  }
  return out
}

/** "[include x]" targets in file order (globs kept as written). */
export function parseIncludes(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\[include\s+([^\]]+)\]/)
    if (m) out.push(m[1].trim())
  }
  return out
}
