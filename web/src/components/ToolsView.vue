<script setup lang="ts">
import { ref } from 'vue'
import { isPrinting, state, tc, tools, tryRun } from '../store'
import type { ToolInfo } from '../lib/tools'
import ToolCard from './ToolCard.vue'
import ToolEditor from './ToolEditor.vue'

const emit = defineEmits<{ go: [tab: 'dock'] }>()
const editing = ref<ToolInfo | null>(null)

function select(t: ToolInfo) {
  tryRun(`T${t.number}`, `Select T${t.number}`)
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
      <button :disabled="!!state.busy" title="Read every tool probe to see which tool is on the carriage" @click="tryRun('DETECT_ACTIVE_TOOL_PROBE', 'Detect tool')">Detect tool</button>
      <button :disabled="!!state.busy || isPrinting" @click="tryRun('INITIALIZE_TOOLCHANGER', 'Initialize')">Initialize changer</button>
    </div>
    <div class="cards">
      <ToolCard v-for="t in tools" :key="t.name" :tool="t" @select="select(t)" @edit="editing = t" @dock="dock(t)" />
    </div>
    <ToolEditor v-if="editing" :tool="editing" @close="editing = null" />
  </section>
</template>

<style scoped>
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
</style>
