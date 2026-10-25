// Create a new tool's config by copying an existing tool's file and
// renumbering everything that is tied to the tool number (framework-agnostic).
import { normalizeSection, parseCfg, removeOption, setOption } from './cfgEdit'

export interface CloneOptions {
  srcNumber: number
  dstNumber: number
  srcMcu: string | null // e.g. "EBBT1" (null if the tool lives on the main mcu)
  dstMcu: string // e.g. "EBBT5"
  board: { kind: 'can'; uuid: string } | { kind: 'usb'; serial: string } | { kind: 'later' }
  nozzle?: string
  sensorType?: string
  maxTemp?: string
  date?: string
}

export const extruderName = (n: number) => (n === 0 ? 'extruder' : `extruder${n}`)

/** Rename tool-number-bound names in a piece of text (section header, value or comment). */
function renumber(s: string, o: CloneOptions): string {
  const src = String(o.srcNumber)
  const dst = String(o.dstNumber)
  let out = s
  if (o.srcMcu) out = out.replace(new RegExp(`\\b${escapeRe(o.srcMcu)}\\b`, 'g'), o.dstMcu)
  out = out.replace(new RegExp(`\\b${extruderName(o.srcNumber)}\\b`, 'g'), extruderName(o.dstNumber))
  out = out.replace(new RegExp(`\\bTOOL${src}_`, 'g'), `TOOL${dst}_`) // neopixel TOOL1_RGB
  out = out.replace(new RegExp(`\\bT${src}_`, 'g'), `T${dst}_`) // T1_partfan, T1_hotend_fan
  out = out.replace(new RegExp(`\\bT=${src}\\b`, 'g'), `T=${dst}`) // SELECT_TOOL T=1
  out = out.replace(new RegExp(`\\bT${src}\\b`, 'g'), `T${dst}`) // [tool T1], [gcode_macro T1] ...
  return out
}

/**
 * Copy `text` (an existing tool's file) into a new tool's file. Option keys are
 * never renamed, only section names, values and comments, so "extruder: extruder"
 * in [tool T0] becomes "extruder: extruder5" and not "extruder5: extruder5".
 * The dock position is set to an invalid value on purpose so nothing can move
 * the new tool into another tool's dock before it has been taught.
 */
export function cloneToolConfig(text: string, o: CloneOptions): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/).map((line) => {
    if (/^\[/.test(line)) return renumber(line, o)
    const opt = line.match(/^([A-Za-z0-9_.\-]+)(\s*[:=].*)$/)
    if (opt) return opt[1] + renumber(opt[2], o)
    return renumber(line, o)
  })
  let out = lines.join(eol)
  const T = `T${o.dstNumber}`
  const sections = parseCfg(out).map((s) => normalizeSection(s.name))
  const has = (name: string) => sections.includes(normalizeSection(name))

  const tool = `tool ${T}`
  if (has(tool)) {
    out = setOption(out, tool, 'tool_number', String(o.dstNumber))
    for (const a of ['x', 'y', 'z']) out = setOption(out, tool, `params_park_${a}`, '-1')
    for (const a of ['x', 'y', 'z']) out = setOption(out, tool, `gcode_${a}_offset`, '0')
  }
  if (has(`tool_probe ${T}`)) out = setOption(out, `tool_probe ${T}`, 'tool', String(o.dstNumber))

  const mcu = `mcu ${o.dstMcu}`
  if (has(mcu)) {
    const sec = parseCfg(out).find((s) => normalizeSection(s.name) === normalizeSection(mcu))!
    if (o.board.kind === 'can') {
      if (sec.options.has('serial')) out = removeOption(out, mcu, 'serial')
      out = setOption(out, mcu, 'canbus_uuid', o.board.uuid)
    } else if (o.board.kind === 'usb') {
      if (sec.options.has('canbus_uuid')) out = removeOption(out, mcu, 'canbus_uuid')
      out = setOption(out, mcu, 'serial', o.board.serial)
    } else {
      // keep the copied value's key, but make it obviously unset
      const key = sec.options.has('serial') ? 'serial' : 'canbus_uuid'
      out = setOption(out, mcu, key, 'SET_ME')
    }
  }

  const ex = extruderName(o.dstNumber)
  if (has(ex)) {
    if (o.nozzle) out = setOption(out, ex, 'nozzle_diameter', o.nozzle)
    if (o.sensorType) out = setOption(out, ex, 'sensor_type', o.sensorType)
    if (o.maxTemp) out = setOption(out, ex, 'max_temp', o.maxTemp)
  }

  const header = [
    `# ${T}: created by ToolConfig from T${o.srcNumber}${o.date ? ' on ' + o.date : ''}.`,
    `# Its dock position (params_park_x/y/z) is not set yet: teach it in ToolConfig`,
    `# (Dock test & align -> teach by dropping it off) before using ${T}.`,
    '',
  ]
  return header.join(eol) + out
}

/** Next unused tool number. */
export function nextToolNumber(used: number[]): number {
  let n = 0
  while (used.includes(n)) n++
  return n
}

/** "EBBT1" -> "EBBT5" when the name ends in the tool number, else NAME + "_T5". */
export function suggestMcuName(srcMcu: string | null, srcNumber: number, dstNumber: number): string {
  if (!srcMcu) return `EBBT${dstNumber}`
  const m = srcMcu.match(new RegExp(`^(.*?)${srcNumber}$`))
  return m ? `${m[1]}${dstNumber}` : `${srcMcu}_T${dstNumber}`
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
