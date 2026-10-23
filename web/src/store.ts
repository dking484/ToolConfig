import { computed, reactive, shallowRef } from 'vue'
import { Moonraker, type Status } from './lib/moonraker'
import { allMcus, buildTools } from './lib/tools'
import { ConfigIndex } from './lib/configFiles'

export const mr = new Moonraker(import.meta.env.VITE_MOONRAKER ?? '')
export const configIndex = new ConfigIndex(mr)

export interface LogLine {
  time: number
  text: string
  kind: 'cmd' | 'resp' | 'error'
}

export const state = reactive({
  connection: 'connecting' as 'connecting' | 'open' | 'closed',
  klippy: 'startup' as string,
  klippyMessage: '',
  log: [] as LogLine[],
  busy: '' as string, // label of the command currently running from this UI
  pendingRestart: [] as string[], // config changes that need FIRMWARE_RESTART
  objects: [] as string[],
  dockTool: 0, // tool preselected on the Dock tab
  // Ask the alignment wizard to open at a given step for a tool (e.g. after a failed pickup)
  wizardEntry: null as null | { tool: number; step: 'failed' },
})

/** Jump to the Dock tab's wizard for `tool`, starting at the "what happened?" question. */
export function realign(tool: number) {
  state.dockTool = tool
  state.wizardEntry = { tool, step: 'failed' }
  location.hash = 'dock'
}

// Status is large and updates often: keep it shallow and swap the reference.
export const status = shallowRef<Status>({})

export const tools = computed(() => buildTools(status.value))
export const mcus = computed(() => allMcus(status.value))
export const tc = computed(() => status.value.toolchanger ?? {})
export const safety = computed(() => status.value['gcode_macro _TC_SAFETY'] ?? null)
export const homed = computed(() => status.value.toolhead?.homed_axes ?? '')
export const printState = computed(() => status.value.print_stats?.state ?? 'standby')
export const isPrinting = computed(() => ['printing', 'paused'].includes(printState.value))

function log(text: string, kind: LogLine['kind']) {
  state.log.push({ time: Date.now(), text, kind })
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400)
}

mr.on('connection', async (c) => {
  state.connection = c
  if (c === 'open') await init()
})
mr.on('status', ({ full }) => {
  status.value = { ...full }
})
mr.on('gcode', (text) => log(text, text.startsWith('!!') ? 'error' : 'resp'))
mr.on('klippy', async (k) => {
  state.klippy = k
  if (k === 'ready') await init()
})

async function init() {
  try {
    const info = await mr.call('printer.info')
    state.klippy = info.state
    state.klippyMessage = info.state_message
    if (info.state !== 'ready') return
    const { objects } = await mr.call('printer.objects.list')
    state.objects = objects
    const want: Record<string, string[] | null> = {}
    const exact = ['webhooks', 'toolchanger', 'toolchanger_ui', 'tool_probe_endstop', 'gcode_macro _TC_SAFETY', 'toolhead', 'gcode_move', 'print_stats', 'pause_resume', 'idle_timeout', 'quad_gantry_level', 'heater_bed', 'virtual_sdcard']
    for (const o of objects as string[]) {
      if (
        exact.includes(o) ||
        o.startsWith('tool ') ||
        o.startsWith('extruder') ||
        o === 'mcu' ||
        o.startsWith('mcu ') ||
        /^gcode_macro T\d+$/.test(o)
      )
        want[o] = null
    }
    want.configfile = ['settings', 'save_config_pending', 'warnings']
    await mr.subscribe(want)
    const hist = await mr.call('server.gcode_store', { count: 100 })
    state.log = hist.gcode_store.map((g: any) => ({
      time: g.time * 1000,
      text: g.message,
      kind: g.type === 'command' ? 'cmd' : g.message.startsWith('!!') ? 'error' : 'resp',
    }))
  } catch (e: any) {
    state.klippyMessage = e.message
  }
}

/** Run gcode from the UI; logs it and keeps one command at a time. */
export async function run(script: string, label = script) {
  log(script, 'cmd')
  state.busy = label
  try {
    await mr.gcode(script)
    return true
  } catch (e: any) {
    // Klipper already printed "!! ..." to the console; keep the message for callers
    throw e
  } finally {
    state.busy = ''
  }
}

/** Like run() but swallow the error (it is visible in the log/banner). */
export async function tryRun(script: string, label = script) {
  try {
    return await run(script, label)
  } catch {
    return false
  }
}

// ---- "needs a tool on the gantry" guard -----------------------------------
// Homing Z and QGL probe with the tool's own probe. Check the probes right
// before running, and ask the user instead of failing halfway.
export interface ToolPrompt {
  label: string // what we were about to do, e.g. "Home all"
  script: string
  reason: 'none' | 'multiple'
  open: number[] // tool numbers whose probe reads open
}
export const toolPrompt = shallowRef<ToolPrompt | null>(null)

/** Fresh probe read (not the cached status), returns open (= on gantry) tools. */
export async function detectTools(): Promise<number[]> {
  await mr.gcode('DETECT_ACTIVE_TOOL_PROBE')
  const res = await mr.call('printer.objects.query', { objects: { tool_probe_endstop: ['last_tools_query'] } })
  const q: Record<string, number> = res.status.tool_probe_endstop?.last_tools_query ?? {}
  return Object.entries(q)
    .filter(([, triggered]) => !triggered)
    .map(([n]) => Number(n))
}

/** Run `script` only if exactly one tool is on the gantry; otherwise ask. */
export async function runWithTool(script: string, label: string) {
  log('DETECT_ACTIVE_TOOL_PROBE', 'cmd')
  state.busy = 'Checking for a tool on the gantry'
  let open: number[]
  try {
    open = await detectTools()
  } catch (e: any) {
    state.busy = ''
    log('!! ' + e.message, 'error')
    return false
  }
  state.busy = ''
  if (open.length === 1) return tryRun(script, label)
  toolPrompt.value = { label, script, reason: open.length ? 'multiple' : 'none', open }
  return false
}

export async function firmwareRestart() {
  state.pendingRestart = []
  await mr.call('printer.firmware_restart')
}

export function connect() {
  mr.connect()
}
