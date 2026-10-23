<script setup lang="ts">
// Live per-tool probe states (pushed by Klipper on every change, no polling).
import { computed, ref, watch } from 'vue'
import { status, tools } from '../store'

const live = computed<Record<string, boolean> | null>(() => status.value.toolchanger_ui?.probes ?? null)
const flash = ref<Record<string, number>>({})

watch(
  () => ({ ...(live.value ?? {}) }),
  (now, before) => {
    for (const k of Object.keys(now)) {
      if (before && k in before && before[k] !== now[k]) {
        flash.value = { ...flash.value, [k]: Date.now() }
        setTimeout(() => {
          const { [k]: _gone, ...rest } = flash.value
          flash.value = rest
        }, 900)
      }
    }
  },
)

const rows = computed(() =>
  tools.value.map((t) => {
    const v = live.value?.[String(t.number)]
    return {
      label: t.label,
      key: String(t.number),
      state: v === undefined ? 'unknown' : v ? 'triggered' : 'open',
      // On the carriage the probe should read open; triggered there means pressed or not connected
      mismatch: t.active && v === true,
    }
  }),
)
const openCount = computed(() => rows.value.filter((r) => r.state === 'open').length)
</script>

<template>
  <div class="probelive panel">
    <div class="row head">
      <strong>Live probe monitor</strong>
      <span v-for="r in rows" :key="r.key" class="pill" :class="[r.state === 'open' ? 'ok' : r.state === 'triggered' ? '' : 'warn', { flash: flash[r.key], bad: r.mismatch }]">
        <span class="dot" />{{ r.label }} {{ r.state }}
      </span>
      <span class="grow" />
      <span v-if="!live" class="muted small">Needs the updated toolchanger_ui.py (Klipper restart).</span>
    </div>
    <p class="muted small">
      Updates the instant a probe changes. A tool in its dock reads <b>triggered</b>; the tool on the carriage reads <b>open</b>.
      Push a tool's nozzle up and it should flip to triggered, then back to open when you let go. If it never changes, the probe signal isn't reaching the board (connector, wrong pin, wiring).
      <template v-if="openCount > 1"> <b class="warn-text">More than one probe reads open: a tool may be crooked in its dock.</b></template>
    </p>
    <p v-for="r in rows.filter((x) => x.mismatch)" :key="'m' + r.key" class="small warn-text">
      {{ r.label }} is the active tool but its probe reads triggered: it's pressed, not fully seated, or its signal isn't connected.
    </p>
  </div>
</template>

<style scoped>
.probelive { padding: 10px 14px; display: grid; gap: 6px; }
.head { gap: 6px; }
.small { font-size: 12.5px; margin: 0; }
.pill.flash { outline: 2px solid var(--accent-2); outline-offset: 1px; }
.pill.bad { border-color: var(--err); color: var(--err); }
.warn-text { color: var(--warn); }
</style>
