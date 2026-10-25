<script setup lang="ts">
// Add a tool: copy an existing tool's file, renumber it, set the board and the
// basics, then review the result in the visual/code editor before creating it.
import { computed, onMounted, ref, watch } from 'vue'
import { findSection, parseCfg } from '../lib/cfgEdit'
import { cloneToolConfig, extruderName, nextToolNumber, suggestMcuName } from '../lib/toolTemplate'
import { configIndex, DISABLED_DIR, listConfigDir, mr, status, tools } from '../store'
import ToolConfigEditor from './ToolConfigEditor.vue'

const emit = defineEmits<{ close: []; created: [] }>()

const disabledNums = ref<number[]>([])
const number = ref(0)
const source = ref<number>(tools.value[0]?.number ?? 0)
const mcuName = ref('')
const board = ref<'can' | 'usb' | 'later'>('can')
const uuid = ref('')
const serial = ref('')
const nozzle = ref('')
const sensor = ref('')
const maxTemp = ref('')
const canIds = ref<string[] | null>(null)
const serials = ref<string[]>([])
const scanning = ref(false)
const error = ref('')
const generated = ref<{ text: string; path: string } | null>(null)

const used = computed(() => [...tools.value.map((t) => t.number), ...disabledNums.value])
const src = computed(() => tools.value.find((t) => t.number === source.value))

onMounted(async () => {
  const files = await listConfigDir(DISABLED_DIR)
  disabledNums.value = files.map((f) => f.match(/^T(\d+)\.cfg$/)?.[1]).filter(Boolean).map(Number)
  number.value = nextToolNumber(used.value)
  fillFromSource()
  scan()
})

function fillFromSource() {
  const t = src.value
  if (!t) return
  mcuName.value = suggestMcuName(t.mcu?.name ?? null, t.number, number.value)
  nozzle.value = t.nozzle !== null ? String(t.nozzle) : ''
  const ex = status.value.configfile?.settings?.[t.extruder ?? ''] ?? {}
  sensor.value = ex.sensor_type ?? ''
  maxTemp.value = ex.max_temp !== undefined ? String(ex.max_temp) : ''
  if (t.mcu?.serial && !t.mcu.canbusUuid) board.value = 'usb'
}
watch([source, number], fillFromSource)

async function scan() {
  scanning.value = true
  try {
    const [c, s] = await Promise.allSettled([
      mr.call('machine.peripherals.canbus', { interface: 'can0' }, 15000),
      mr.call('machine.peripherals.serial'),
    ])
    canIds.value = c.status === 'fulfilled' ? (c.value.can_uuids ?? []).map((x: any) => x.uuid) : []
    const used = new Set(Object.values(status.value.configfile?.settings ?? {}).map((v: any) => v?.serial).filter(Boolean))
    serials.value = s.status === 'fulfilled' ? (s.value.serial_devices ?? []).map((d: any) => d.path_by_id).filter((p: string) => p && !used.has(p)) : []
    if (!uuid.value && canIds.value?.length) uuid.value = canIds.value[0]
  } finally {
    scanning.value = false
  }
}

const problems = computed(() => {
  const out: string[] = []
  if (!Number.isInteger(number.value) || number.value < 0) out.push('Pick a tool number')
  else if (used.value.includes(number.value)) out.push(`T${number.value} already exists${disabledNums.value.includes(number.value) ? ' (disabled)' : ''}`)
  if (!src.value) out.push('Pick a tool to copy')
  if (!/^[A-Za-z0-9_]+$/.test(mcuName.value)) out.push('Board name: letters, numbers and _ only')
  else if (status.value[`mcu ${mcuName.value}`] || mcuName.value === 'mcu') out.push(`A board named ${mcuName.value} already exists`)
  if (board.value === 'can' && !/^[0-9a-f]{12}$/i.test(uuid.value.trim())) out.push('CAN UUID must be 12 hex digits')
  if (board.value === 'usb' && !serial.value.trim()) out.push('Enter or pick the USB serial path')
  return out
})

async function generate() {
  error.value = ''
  try {
    const t = src.value!
    await configIndex.load()
    const loc = configIndex.locate(t.name, 'tool_number')
    if (!loc) throw new Error(`Can't find the file that defines [${t.name}]`)
    const text = await mr.getText('config', loc.file.path)
    if (!findSection(parseCfg(text), t.name)) throw new Error(`[${t.name}] isn't in ${loc.file.path}`)
    const out = cloneToolConfig(text, {
      srcNumber: t.number,
      dstNumber: number.value,
      srcMcu: t.mcu?.name ?? null,
      dstMcu: mcuName.value,
      board: board.value === 'can' ? { kind: 'can', uuid: uuid.value.trim().toLowerCase() } : board.value === 'usb' ? { kind: 'usb', serial: serial.value.trim() } : { kind: 'later' },
      nozzle: nozzle.value.trim() || undefined,
      sensorType: sensor.value.trim() || undefined,
      maxTemp: maxTemp.value.trim() || undefined,
      date: new Date().toISOString().slice(0, 10),
    })
    const dir = loc.file.path.includes('/') ? loc.file.path.slice(0, loc.file.path.lastIndexOf('/')) : 'toolchanger/tools'
    generated.value = { text: out, path: `${dir}/T${number.value}.cfg` }
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <ToolConfigEditor
    v-if="generated"
    mode="create"
    :path="generated.path"
    :title="`T${number}`"
    :initial-text="generated.text"
    :tool-number="number"
    :extruder="extruderName(number)"
    @close="generated = null"
    @saved="emit('created'); emit('close')"
  />
  <div v-else class="modal-back" @click.self="emit('close')">
    <div class="panel modal">
      <header class="panel-head"><h2 class="grow">Add a tool</h2><button class="ghost" @click="emit('close')">Close</button></header>
      <div class="panel-body stack">
        <p class="muted">The new tool is a copy of an existing tool with the same hardware. Its board, extruder, fans, LEDs, macro, probe and accelerometer are all renamed for the new number.
          Its dock position starts unset, so nothing will move it until you teach the dock.</p>

        <fieldset>
          <legend>Tool</legend>
          <div class="grid2">
            <label class="field">New tool number <input v-model.number="number" type="number" min="0" /></label>
            <label class="field">Copy settings from
              <select v-model.number="source"><option v-for="t in tools" :key="t.number" :value="t.number">{{ t.label }} ({{ t.mcu?.name ?? 'main board' }}, {{ t.nozzle ?? '?' }} mm)</option></select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Board</legend>
          <div class="grid2">
            <label class="field">Board name in Klipper <input v-model="mcuName" class="mono" /></label>
            <label class="field">Connected by
              <select v-model="board">
                <option value="can">CAN bus (UUID)</option>
                <option value="usb">USB (serial path)</option>
                <option value="later">Decide later (create it disabled)</option>
              </select>
            </label>
          </div>
          <div v-if="board === 'can'" class="stack tight">
            <label class="field">CAN UUID <input v-model="uuid" class="mono" placeholder="12 hex digits" /></label>
            <div class="row small">
              <button class="small" :disabled="scanning" @click="scan">{{ scanning ? 'Scanning…' : 'Scan CAN bus' }}</button>
              <span v-if="canIds && !canIds.length" class="muted">No unassigned CAN boards found. A board only shows up here while Klipper isn't using it (new, or in Katapult).</span>
              <button v-for="u in canIds" :key="u" class="small mono" :class="{ blue: uuid === u }" @click="uuid = u">{{ u }}</button>
            </div>
          </div>
          <div v-if="board === 'usb'" class="stack tight">
            <label class="field">USB serial path <input v-model="serial" class="mono" placeholder="/dev/serial/by-id/usb-Klipper_…" /></label>
            <div class="row small">
              <span v-if="!serials.length" class="muted">No unused Klipper USB devices found.</span>
              <button v-for="p in serials" :key="p" class="small mono" :class="{ blue: serial === p }" @click="serial = p">{{ p.replace('/dev/serial/by-id/', '') }}</button>
            </div>
          </div>
          <p v-if="board === 'later'" class="muted small">The file is created in {{ DISABLED_DIR }}/ with the board set to SET_ME, so Klipper keeps starting. Set the board and enable it from the Tools tab later.</p>
        </fieldset>

        <fieldset>
          <legend>Basics (copied from {{ src?.label }}, change if this tool is different)</legend>
          <div class="grid3">
            <label class="field">Nozzle diameter <input v-model="nozzle" inputmode="decimal" /></label>
            <label class="field">Thermistor <input v-model="sensor" /></label>
            <label class="field">Max temp <input v-model="maxTemp" inputmode="decimal" /></label>
          </div>
        </fieldset>

        <ul v-if="problems.length" class="problems"><li v-for="p in problems" :key="p">{{ p }}</li></ul>
        <div v-if="error" class="callout err">{{ error }}</div>
        <div class="row">
          <span class="muted small grow">Next you review the whole file (visual or code) before it's created.</span>
          <button @click="emit('close')">Cancel</button>
          <button class="primary" :disabled="problems.length > 0" @click="generate">Next: review T{{ number }}.cfg</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px 12px; margin: 0; display: grid; gap: 10px; }
legend { padding: 0 6px; color: var(--muted); font-size: 12.5px; }
.grid2 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.grid3 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
.tight { gap: 6px; }
.small { font-size: 12.5px; }
.problems { margin: 0; padding-left: 20px; color: var(--warn); font-size: 13px; }
p { margin: 0; }
</style>
