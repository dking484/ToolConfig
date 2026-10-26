<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { configIndex, detectTool, DISABLED_DIR, dockTool, homed, isPrinting, listConfigDir, moveConfigFile, recordChange, state, tc, tools, TOOLS_DIR, tryRun, unadoptedTool } from '../store'
import type { ToolInfo } from '../lib/tools'
import { extruderName } from '../lib/toolTemplate'
import ToolCard from './ToolCard.vue'
import ToolConfigEditor from './ToolConfigEditor.vue'
import AddToolDialog from './AddToolDialog.vue'
import ProbeLive from './ProbeLive.vue'

const emit = defineEmits<{ go: [tab: 'dock'] }>()
const editing = ref<{ path: string; title: string; toolNumber: number; extruder: string | null } | null>(null)
const adding = ref(false)
const disabled = ref<string[]>([])
const error = ref('')
// The tool on the gantry: selected by the toolchanger, or put there by hand
const active = computed(() => tools.value.find((t) => t.active) ?? tools.value.find((t) => t.number === unadoptedTool.value))

async function refreshDisabled() {
  disabled.value = (await listConfigDir(DISABLED_DIR)).filter((f) => f.endsWith('.cfg')).sort()
}
onMounted(refreshDisabled)

function select(t: ToolInfo) {
  tryRun(`T${t.number}`, `Select T${t.number}`)
}
function park(t: ToolInfo) {
  // Drop the tool in its own dock without picking another one up
  dockTool(t.number)
}
function dock(t: ToolInfo) {
  state.dockTool = t.number
  emit('go', 'dock')
}
async function edit(t: ToolInfo) {
  error.value = ''
  try {
    await configIndex.load()
    const loc = configIndex.locate(t.name, 'tool_number')
    if (!loc) throw new Error(`Can't find the file that defines [${t.name}]`)
    editing.value = { path: loc.file.path, title: t.label, toolNumber: t.number, extruder: t.extruder }
  } catch (e: any) {
    error.value = e.message
  }
}
function editDisabled(file: string) {
  const n = Number(file.match(/^T(\d+)/)?.[1] ?? -1)
  editing.value = { path: `${DISABLED_DIR}/${file}`, title: file.replace(/\.cfg$/, '') + ' (disabled)', toolNumber: n, extruder: n >= 0 ? extruderName(n) : null }
}
async function enable(file: string) {
  if (!confirm(`Enable ${file}?\n\nIt moves back to ${TOOLS_DIR}/ and Klipper loads it after a restart. Its board must be connected, or Klipper won't start (you can undo).`)) return
  error.value = ''
  try {
    const from = `${DISABLED_DIR}/${file}`
    const to = `${TOOLS_DIR}/${file}`
    await moveConfigFile(from, to)
    recordChange({ kind: 'enable', from, to, label: `Enable ${file}`, time: Date.now() })
    if (!state.pendingRestart.includes(`enable ${file}`)) state.pendingRestart.push(`enable ${file}`)
    await refreshDisabled()
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <section class="stack">
    <div class="row">
      <h2 class="grow">{{ tools.length }} tools <span class="muted">· active: {{ tc.tool ? String(tc.tool).replace('tool ', '') : 'none' }}</span></h2>
      <button v-if="active" class="blue" :disabled="homed !== 'xyz' || isPrinting || !!state.busy || active.warnings.length > 0" @click="park(active)">Dock {{ active.label }} (empty the gantry)</button>
      <button :disabled="!!state.busy" title="Read every tool sensor and select the tool that is on the gantry (no motion)" @click="detectTool()">Detect tool</button>
      <button :disabled="!!state.busy || isPrinting" @click="tryRun('INITIALIZE_TOOLCHANGER', 'Initialize')">Initialize changer</button>
      <button class="primary" :disabled="isPrinting" @click="adding = true">+ Add tool</button>
    </div>
    <div v-if="error" class="callout err">{{ error }}</div>
    <ProbeLive />
    <div class="cards">
      <ToolCard v-for="t in tools" :key="t.name" :tool="t" @select="select(t)" @park="park(t)" @edit="edit(t)" @dock="dock(t)" />
    </div>

    <div v-if="disabled.length" class="panel">
      <header class="panel-head"><h2 class="grow">Disabled tools</h2><span class="muted small">config/{{ DISABLED_DIR }}/ · not loaded by Klipper</span></header>
      <div class="panel-body">
        <div v-for="f in disabled" :key="f" class="row dis">
          <span class="mono grow">{{ f }}</span>
          <button class="small" @click="editDisabled(f)">Edit file</button>
          <button v-if="/^T\d+\.cfg$/.test(f)" class="small blue" :disabled="isPrinting" @click="enable(f)">Enable</button>
        </div>
      </div>
    </div>

    <ToolConfigEditor
      v-if="editing"
      mode="edit"
      :path="editing.path"
      :title="editing.title"
      :tool-number="editing.toolNumber"
      :extruder="editing.extruder"
      @close="editing = null"
      @saved="refreshDisabled"
    />
    <AddToolDialog v-if="adding" @close="adding = false" @created="refreshDisabled" />
  </section>
</template>

<style scoped>
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
.dis { padding: 6px 0; border-bottom: 1px solid var(--border); }
.dis:last-child { border-bottom: none; }
.small { font-size: 12.5px; }
</style>
