<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { configIndex, detectTool, DISABLED_DIR, dockTool, enableToolFile, firmwareRestart, homed, isPrinting, listConfigDir, mr, state, tc, tools, tryRun, unadoptedTool } from '../store'
import type { ToolInfo } from '../lib/tools'
import { normalizeSection, parseCfg } from '../lib/cfgEdit'
import { toolsFromConfig } from '../lib/configTools'
import ToolCard from './ToolCard.vue'
import ToolConfigEditor from './ToolConfigEditor.vue'
import AddToolDialog from './AddToolDialog.vue'
import ProbeLive from './ProbeLive.vue'

const emit = defineEmits<{ go: [tab: 'dock'] }>()
const editing = ref<{ path: string; title: string; toolNumber: number; extruder: string | null } | null>(null)
const adding = ref(false)
const error = ref('')
// The tool on the gantry: selected by the toolchanger, or put there by hand
const active = computed(() => tools.value.find((t) => t.active) ?? tools.value.find((t) => t.number === unadoptedTool.value))
const fromConfig = computed(() => tools.value.some((t) => t.source === 'config'))

// Tools Klipper doesn't have (or shouldn't) as it runs: disabled ones (their
// file is in the disabled folder), and enabled or new ones it loads at the
// next restart. Read from the files, shown as cards next to the live ones.
interface FileTool {
  tool: ToolInfo
  file: string // config-relative path
}
const disabledTools = shallowRef<FileTool[]>([])
const pendingTools = shallowRef<ToolInfo[]>([])
const key = (t: ToolInfo) => normalizeSection(t.name)

async function refreshFiles() {
  try {
    const files = (await listConfigDir(DISABLED_DIR)).filter((f) => f.endsWith('.cfg')).sort()
    await configIndex.load()
    const out: FileTool[] = []
    for (const f of files) {
      const path = `${DISABLED_DIR}/${f}`
      const sections = parseCfg(await mr.getText('config', path))
      const own = new Set(sections.filter((s) => /^tool\s/i.test(s.name)).map((s) => normalizeSection(s.name)))
      // [toolchanger] defaults etc. come from the enabled files
      for (const t of toolsFromConfig([...configIndex.files, { sections }], configIndex.autosave)) if (own.has(key(t))) out.push({ tool: t, file: path })
    }
    disabledTools.value = out
    const live = new Set(tools.value.map(key))
    pendingTools.value = state.klippy === 'ready' ? toolsFromConfig(configIndex.files, configIndex.autosave).filter((t) => !live.has(key(t))) : []
  } catch (e: any) {
    error.value = e.message
  }
}
// Not onMounted: on a page load this tab mounts before Moonraker's socket is
// open, and the listing would come back empty
watch(
  () => [state.connection, state.klippy] as const,
  ([c]) => {
    if (c === 'open') refreshFiles()
  },
  { immediate: true },
)

type Card = { tool: ToolInfo; mode: 'normal' | 'disabled' | 'pending'; file?: string }
const cards = computed<Card[]>(() => {
  const dis = new Map(disabledTools.value.map((d) => [key(d.tool), d]))
  // A tool disabled since Klipper started keeps its live card, marked disabled
  const out: Card[] = tools.value.map((t) => (dis.has(key(t)) ? { tool: t, mode: 'disabled', file: dis.get(key(t))!.file } : { tool: t, mode: 'normal' }))
  const shown = new Set(out.map((c) => key(c.tool)))
  for (const d of disabledTools.value) if (!shown.has(key(d.tool))) out.push({ tool: d.tool, mode: 'disabled', file: d.file })
  for (const t of pendingTools.value) if (!shown.has(key(t)) && !dis.has(key(t))) out.push({ tool: t, mode: 'pending' })
  return out.sort((a, b) => a.tool.number - b.tool.number)
})
const enabledCount = computed(() => cards.value.filter((c) => c.mode !== 'disabled').length)
const disabledCount = computed(() => cards.value.length - enabledCount.value)
// Disabled since Klipper last started: it still has them loaded
const disabledLoaded = computed(() => cards.value.filter((c) => c.mode === 'disabled' && c.tool.source === 'klipper').map((c) => c.tool.label))
async function restartNow() {
  if (!confirm('Restart Klipper now?\n\nIt unloads the disabled tools. Homing and QGL are lost.')) return
  await firmwareRestart()
}

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
async function edit(c: Card) {
  const t = c.tool
  error.value = ''
  if (c.file) {
    editing.value = { path: c.file, title: t.label, toolNumber: t.number, extruder: t.extruder }
    return
  }
  try {
    await configIndex.load()
    const loc = configIndex.locate(t.name, 'tool_number')
    if (!loc) throw new Error(`Can't find the file that defines [${t.name}]`)
    editing.value = { path: loc.file.path, title: t.label, toolNumber: t.number, extruder: t.extruder }
  } catch (e: any) {
    error.value = e.message
  }
}
async function enable(c: Card) {
  error.value = ''
  try {
    if (await enableToolFile(c.file!, c.tool.label)) await refreshFiles()
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <section class="stack">
    <div class="row">
      <h2 class="grow">
        {{ enabledCount }} tools<span v-if="disabledCount" class="muted"> + {{ disabledCount }} disabled</span>
        <span v-if="!fromConfig" class="muted"> · active: {{ tc.tool ? String(tc.tool).replace('tool ', '') : 'none' }}</span>
      </h2>
      <button v-if="active" class="blue" :disabled="homed !== 'xyz' || isPrinting || !!state.busy || active.warnings.length > 0" @click="park(active)">Dock {{ active.label }} (empty the gantry)</button>
      <button :disabled="!!state.busy || fromConfig" title="Read every tool sensor and select the tool that is on the gantry (no motion)" @click="detectTool()">Detect tool</button>
      <button :disabled="!!state.busy || isPrinting || fromConfig" @click="tryRun('INITIALIZE_TOOLCHANGER', 'Initialize')">Initialize changer</button>
      <button class="primary" :disabled="isPrinting" @click="adding = true">+ Add tool</button>
    </div>
    <div v-if="error" class="callout err">{{ error }}</div>
    <div v-if="fromConfig" class="callout info">
      Klipper isn't running, so these tools are read from the config files. Live values (temperatures, sensors, board status) come back once it
      runs. You can still edit a tool and save it; restart Klipper afterwards.
    </div>
    <div v-if="disabledLoaded.length" class="callout warn row">
      <span class="grow">
        {{ disabledLoaded.join(', ') }} {{ disabledLoaded.length > 1 ? 'are' : 'is' }} disabled but still loaded until Klipper restarts.
      </span>
      <button :disabled="isPrinting" @click="restartNow">Restart Klipper now</button>
    </div>
    <ProbeLive />
    <div class="cards">
      <ToolCard
        v-for="c in cards"
        :key="c.tool.name"
        :tool="c.tool"
        :mode="c.mode"
        @select="select(c.tool)"
        @park="park(c.tool)"
        @edit="edit(c)"
        @dock="dock(c.tool)"
        @enable="enable(c)"
      />
    </div>

    <ToolConfigEditor
      v-if="editing"
      mode="edit"
      :path="editing.path"
      :title="editing.title"
      :tool-number="editing.toolNumber"
      :extruder="editing.extruder"
      @close="editing = null"
      @saved="refreshFiles"
    />
    <AddToolDialog v-if="adding" @close="adding = false" @created="refreshFiles" />
  </section>
</template>

<style scoped>
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
</style>
