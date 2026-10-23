<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { ToolInfo } from '../lib/tools'
import { configIndex, isPrinting, mr, state, tryRun } from '../store'

const props = defineProps<{ tool: ToolInfo }>()
const emit = defineEmits<{ close: [] }>()

type Apply = 'tool' | 'pa' | 'rd' | 'restart'
interface Field {
  group: string
  label: string
  section: string
  key: string
  kind: 'number' | 'text' | 'shaper'
  apply: Apply
  help?: string
  quoted?: boolean // tool params are Python literals: strings need quotes
}

const t = props.tool
const ex = t.extruder ?? 'extruder'
const fields: Field[] = [
  { group: 'Dock position', label: 'Park X', section: t.name, key: 'params_park_x', kind: 'number', apply: 'tool', help: 'Toolhead X when the tool sits in its dock' },
  { group: 'Dock position', label: 'Park Y', section: t.name, key: 'params_park_y', kind: 'number', apply: 'tool' },
  { group: 'Dock position', label: 'Park Z', section: t.name, key: 'params_park_z', kind: 'number', apply: 'tool' },
  { group: 'Dock position', label: 'Safe Y', section: t.name, key: 'params_safe_y', kind: 'number', apply: 'tool', help: 'Y the carriage retreats to before moving sideways' },
  { group: 'Tool offsets', label: 'X offset', section: t.name, key: 'gcode_x_offset', kind: 'number', apply: 'tool' },
  { group: 'Tool offsets', label: 'Y offset', section: t.name, key: 'gcode_y_offset', kind: 'number', apply: 'tool' },
  { group: 'Tool offsets', label: 'Z offset', section: t.name, key: 'gcode_z_offset', kind: 'number', apply: 'tool' },
  { group: 'Nozzle & extruder', label: 'Nozzle diameter', section: ex, key: 'nozzle_diameter', kind: 'number', apply: 'restart' },
  { group: 'Nozzle & extruder', label: 'Pressure advance', section: ex, key: 'pressure_advance', kind: 'number', apply: 'pa' },
  { group: 'Nozzle & extruder', label: 'Rotation distance', section: ex, key: 'rotation_distance', kind: 'number', apply: 'rd' },
  { group: 'Nozzle & extruder', label: 'Max temp', section: ex, key: 'max_temp', kind: 'number', apply: 'restart' },
  { group: 'Probe (OptoTap)', label: 'Probe z_offset', section: `tool_probe T${t.number}`, key: 'z_offset', kind: 'number', apply: 'restart' },
  { group: 'Probe (OptoTap)', label: 'Samples', section: `tool_probe T${t.number}`, key: 'samples', kind: 'number', apply: 'restart' },
  { group: 'Probe (OptoTap)', label: 'Tolerance', section: `tool_probe T${t.number}`, key: 'samples_tolerance', kind: 'number', apply: 'restart' },
  { group: 'Input shaper', label: 'X type', section: t.name, key: 'params_input_shaper_type_x', kind: 'shaper', apply: 'tool', quoted: true },
  { group: 'Input shaper', label: 'X freq (Hz)', section: t.name, key: 'params_input_shaper_freq_x', kind: 'number', apply: 'tool' },
  { group: 'Input shaper', label: 'Y type', section: t.name, key: 'params_input_shaper_type_y', kind: 'shaper', apply: 'tool', quoted: true },
  { group: 'Input shaper', label: 'Y freq (Hz)', section: t.name, key: 'params_input_shaper_freq_y', kind: 'number', apply: 'tool' },
]
if (t.mcu) {
  fields.push({ group: 'Board', label: t.mcu.serial ? 'USB serial' : 'CAN bus UUID', section: `mcu ${t.mcu.name}`, key: t.mcu.serial ? 'serial' : 'canbus_uuid', kind: 'text', apply: 'restart' })
}
const groups = [...new Set(fields.map((f) => f.group))]
const SHAPERS = ['zv', 'mzv', 'zvd', 'ei', '2hump_ei', '3hump_ei']

const loading = ref(true)
const error = ref('')
const saving = ref(false)
const original = reactive<Record<string, string>>({})
const values = reactive<Record<string, string>>({})
const info = reactive<Record<string, { file: string; editable: boolean; defined: boolean; autosave?: string; also: string[] }>>({})
const canIds = ref<string[] | null>(null)

const id = (f: Field) => `${f.section}|${f.key}`
const unquote = (v: string) => v.replace(/^['"](.*)['"]$/, '$1')

onMounted(async () => {
  try {
    await configIndex.load()
    for (const f of fields) {
      const loc = configIndex.locate(f.section, f.key)
      const raw = loc?.defined ? loc.section.options.get(f.key.toLowerCase())!.value : ''
      const v = f.quoted ? unquote(raw) : raw
      original[id(f)] = v
      values[id(f)] = v
      info[id(f)] = {
        file: loc?.file.path ?? '(not found)',
        editable: !!loc?.file.editable,
        defined: !!loc?.defined,
        autosave: configIndex.autosaveValue(f.section, f.key),
        also: configIndex.definitions(f.section, f.key).map((x) => x.path).filter((p) => p !== loc?.file.path),
      }
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

const changed = computed(() => fields.filter((f) => (values[id(f)] ?? '').trim() !== (original[id(f)] ?? '').trim()))
const invalid = computed(() =>
  changed.value.filter((f) => f.kind === 'number' && (values[id(f)].trim() === '' || isNaN(Number(values[id(f)])))),
)
const needsRestart = computed(() => changed.value.filter((f) => f.apply === 'restart'))
const blocked = computed(() => changed.value.filter((f) => !info[id(f)]?.editable || info[id(f)]?.autosave !== undefined))

async function scanCan() {
  try {
    const r = await mr.call('machine.peripherals.canbus', { interface: 'can0' })
    canIds.value = (r.can_uuids ?? []).map((u: any) => u.uuid)
  } catch (e: any) {
    canIds.value = []
    error.value = 'CAN scan failed: ' + e.message
  }
}

function literal(f: Field, v: string) {
  return f.quoted ? `'${v.trim()}'` : v.trim()
}

async function save() {
  if (!changed.value.length || invalid.value.length || blocked.value.length) return
  const list = changed.value.map((f) => `${f.label}: ${original[id(f)] || '(unset)'} → ${values[id(f)]}   [${info[id(f)].file}]`).join('\n')
  const restartNote = needsRestart.value.length ? `\n\nNeeds a Klipper restart to take effect: ${needsRestart.value.map((f) => f.label).join(', ')}` : ''
  if (!confirm(`Save these changes to ${t.label}?\n\n${list}${restartNote}\n\nA backup of each file is written to config/toolchanger-ui-backups/.`)) return
  saving.value = true
  error.value = ''
  try {
    await configIndex.write(changed.value.map((f) => ({ section: f.section, key: f.key, value: literal(f, values[id(f)]) })))
    // Apply live where Klipper allows it, so homing/QGL are kept.
    for (const f of changed.value) {
      const v = values[id(f)].trim()
      if (f.apply === 'tool' && !(f.key.startsWith('gcode_') && isPrinting.value)) {
        await tryRun(`SET_TOOL_PARAMETER T=${t.number} PARAMETER=${f.key} VALUE="${literal(f, v)}"`, `Apply ${f.label}`)
      } else if (f.apply === 'pa') {
        await tryRun(`SET_PRESSURE_ADVANCE EXTRUDER=${ex} ADVANCE=${v}`, `Apply ${f.label}`)
      } else if (f.apply === 'rd') {
        await tryRun(`SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=${ex} DISTANCE=${v}`, `Apply ${f.label}`)
      }
    }
    for (const f of needsRestart.value) {
      const label = `${t.label} ${f.label}`
      if (!state.pendingRestart.includes(label)) state.pendingRestart.push(label)
    }
    emit('close')
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-back" @click.self="emit('close')">
    <div class="panel modal">
      <header class="panel-head">
        <h2 class="grow">Edit {{ t.label }}</h2>
        <button class="ghost" @click="emit('close')">Close</button>
      </header>
      <div class="panel-body stack">
        <p v-if="loading" class="muted">Reading config files…</p>
        <div v-if="error" class="callout err">{{ error }}</div>
        <template v-if="!loading">
          <fieldset v-for="g in groups" :key="g">
            <legend>{{ g }}</legend>
            <div class="fields">
              <template v-for="f in fields.filter((x) => x.group === g)" :key="id(f)">
                <label class="field" :class="{ changed: values[id(f)]?.trim() !== original[id(f)]?.trim() }">
                  <span>{{ f.label }} <span v-if="f.apply === 'restart'" class="tag" title="Needs a Klipper restart">restart</span><span v-else class="tag live" title="Applied immediately, no restart">live</span></span>
                  <select v-if="f.kind === 'shaper'" v-model="values[id(f)]">
                    <option value="">(default)</option>
                    <option v-for="s in SHAPERS" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <input v-else v-model="values[id(f)]" :inputmode="f.kind === 'number' ? 'decimal' : 'text'" :placeholder="info[id(f)]?.defined ? '' : 'not set'" :title="f.help" />
                  <small class="where" :class="{ bad: !info[id(f)]?.editable || info[id(f)]?.autosave !== undefined }">
                    <template v-if="info[id(f)]?.autosave !== undefined">overridden by SAVE_CONFIG ({{ info[id(f)].autosave }})</template>
                    <template v-else-if="!info[id(f)]?.editable">{{ info[id(f)]?.file }} (read-only)</template>
                    <template v-else>{{ info[id(f)]?.file }}{{ info[id(f)]?.defined ? '' : ' (will be added)' }}</template>
                    <template v-if="info[id(f)]?.also.length"> · also in {{ info[id(f)].also.join(', ') }}</template>
                  </small>
                </label>
              </template>
            </div>
            <div v-if="g === 'Board'" class="row can">
              <button class="small" @click="scanCan">Scan CAN bus for unassigned boards</button>
              <template v-if="canIds">
                <span v-if="!canIds.length" class="muted">No unassigned CAN boards found (boards already running Klipper don't show up here).</span>
                <button v-for="u in canIds" :key="u" class="small mono" @click="values[id(fields.find((x) => x.group === 'Board')!)] = u">{{ u }}</button>
              </template>
            </div>
          </fieldset>

          <div v-if="invalid.length" class="callout err">Not a number: {{ invalid.map((f) => f.label).join(', ') }}</div>
          <div v-if="blocked.length" class="callout warn">
            Can't save {{ blocked.map((f) => f.label).join(', ') }} here: the value comes from a read-only file or the SAVE_CONFIG block.
          </div>
          <div class="row">
            <span class="muted grow">{{ changed.length ? `${changed.length} change(s)` : 'No changes' }}{{ needsRestart.length ? ` · ${needsRestart.length} need a restart` : '' }}</span>
            <button @click="emit('close')">Cancel</button>
            <button class="primary" :disabled="!changed.length || !!invalid.length || !!blocked.length || saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px 12px; margin: 0; }
legend { padding: 0 6px; color: var(--muted); font-size: 12.5px; }
.fields { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
.field.changed input, .field.changed select { border-color: var(--accent-2); }
.where { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.where.bad { color: var(--warn); }
.tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--warn); margin-left: 4px; }
.tag.live { color: var(--ok); }
.can { margin-top: 10px; }
</style>
