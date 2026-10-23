<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { state, tryRun } from '../store'

const props = defineProps<{ tall?: boolean }>()
const box = ref<HTMLElement | null>(null)
const cmd = ref('')
const filterTc = ref(true)

const TC = /tool|dock|T\d|probe|TC_|changer|pick|park|align|verify|detect|error|!!/i

async function toBottom() {
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight })
}
watch(() => state.log.length, toBottom)
onMounted(toBottom)

function send() {
  const c = cmd.value.trim()
  if (!c) return
  cmd.value = ''
  tryRun(c)
}
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false })
</script>

<template>
  <div class="panel">
    <header class="panel-head">
      <h2 class="grow">Console</h2>
      <label class="row muted small"><input v-model="filterTc" type="checkbox" /> tool-changer lines only</label>
    </header>
    <div ref="box" class="lines mono" :class="{ tall: props.tall }">
      <div v-for="(l, i) in state.log.filter((x) => !filterTc || x.kind === 'cmd' || TC.test(x.text))" :key="i" :class="l.kind">
        <span class="t">{{ time(l.time) }}</span> <span>{{ l.kind === 'cmd' ? '> ' : '' }}{{ l.text }}</span>
      </div>
    </div>
    <form class="row send" @submit.prevent="send">
      <input v-model="cmd" class="grow mono" placeholder="Send G-code, e.g. DETECT_ACTIVE_TOOL_PROBE" />
      <button class="blue" type="submit">Send</button>
    </form>
  </div>
</template>

<style scoped>
.lines { height: 420px; overflow-y: auto; padding: 8px 12px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.lines.tall { height: calc(100vh - 260px); min-height: 300px; }
.lines .cmd { color: var(--accent-2); }
.lines .error { color: var(--err); }
.lines .t { color: var(--muted); }
.send { padding: 10px 12px; border-top: 1px solid var(--border); }
.small { font-size: 12.5px; }
</style>
