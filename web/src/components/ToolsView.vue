<script setup lang="ts">
import { computed, ref } from 'vue'
import { homed, isPrinting, state, tc, tools, tryRun } from '../store'
import type { ToolInfo } from '../lib/tools'
import ToolCard from './ToolCard.vue'
import ToolEditor from './ToolEditor.vue'
import ProbeLive from './ProbeLive.vue'

const emit = defineEmits<{ go: [tab: 'dock'] }>()
const editing = ref<ToolInfo | null>(null)
const active = computed(() => tools.value.find((t) => t.active))

function select(t: ToolInfo) {
  tryRun(`T${t.number}`, `Select T${t.number}`)
}
function park(t: ToolInfo) {
  // Drop the tool in its own dock without picking another one up
  tryRun('UNSELECT_TOOL RESTORE_AXIS=', `Dock T${t.number}`)
}
function dock(t: ToolInfo) {
  state.dockTool = t.number
  emit('go', 'dock')
}
</script>

<template>
  <section class="stack">
    <div class="row">
      <h2 class="grow">{{ tools.length }} tools <span class="muted">· active: {{ tc.tool ? String(tc.tool).replace('tool ', '') : 'none' }}</span></h2>
      <button v-if="active" class="blue" :disabled="homed !== 'xyz' || isPrinting || !!state.busy || active.warnings.length > 0" @click="park(active)">Dock {{ active.label }} (empty the gantry)</button>
      <button :disabled="!!state.busy" title="Read every tool probe to see which tool is on the gantry" @click="tryRun('DETECT_ACTIVE_TOOL_PROBE', 'Detect tool')">Detect tool</button>
      <button :disabled="!!state.busy || isPrinting" @click="tryRun('INITIALIZE_TOOLCHANGER', 'Initialize')">Initialize changer</button>
    </div>
    <ProbeLive />
    <div class="cards">
      <ToolCard v-for="t in tools" :key="t.name" :tool="t" @select="select(t)" @park="park(t)" @edit="editing = t" @dock="dock(t)" />
    </div>
    <ToolEditor v-if="editing" :tool="editing" @close="editing = null" />
  </section>
</template>

<style scoped>
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
</style>
