<script setup lang="ts">
// Live per-tool sensor states (pushed by Klipper on every change, no polling),
// shown as where each tool is rather than raw probe states.
import { computed, ref, watch } from 'vue'
import { probing, status, tools } from '../store'

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
      where: v === undefined ? 'unknown' : v ? 'dock' : 'gantry',
      raw: v === undefined ? 'no reading yet' : v ? 'probe pressed (triggered)' : 'probe released (open)',
      // Pressed by the bed during a probe, not docked
      probing: t.active && v === true && probing.value,
      // The toolchanger says this tool is mounted, but its sensor says it's in a dock
      mismatch: t.active && v === true && !probing.value,
    }
  }),
)
const onGantry = computed(() => rows.value.filter((r) => r.where === 'gantry'))
</script>

<template>
  <div class="probelive panel">
    <div class="row head">
      <strong>Where each tool is (live)</strong>
      <span
        v-for="r in rows"
        :key="r.key"
        class="pill"
        :class="[r.where === 'gantry' || r.probing ? 'ok' : r.where === 'dock' ? '' : 'warn', { flash: flash[r.key] && !r.probing, bad: r.mismatch }]"
        :title="r.probing ? `${r.label} is probing: the nozzle touching the bed presses its sensor` : `${r.label} sensor: ${r.raw}`"
      >
        <span class="dot" />{{ r.label }} {{ r.probing ? 'probing' : r.where === 'gantry' ? 'on gantry' : r.where === 'dock' ? 'in dock' : 'unknown' }}
      </span>
      <span class="grow" />
      <span v-if="!live" class="muted small">Needs the updated toolchanger_ui.py (Klipper restart).</span>
    </div>
    <p class="muted small">
      Read from each tool's Tap sensor, updated the instant it changes. A tool resting in its dock has its sensor pressed; on the gantry it's released.
      <b>To test a sensor:</b> with the tool on the gantry, push its nozzle up. It should briefly show <i>in dock</i> while pressed, then <i>on gantry</i> when you let go.
      If it never changes, the sensor signal isn't reaching the board (connector, wrong pin, wiring).
    </p>
    <p v-if="onGantry.length > 1" class="small warn-text">
      More than one tool shows "on gantry" ({{ onGantry.map((r) => r.label).join(', ') }}): one of them is probably sitting crooked in its dock, so its sensor isn't pressed.
    </p>
    <p v-for="r in rows.filter((x) => x.mismatch)" :key="'m' + r.key" class="small warn-text">
      {{ r.label }} is supposed to be on the gantry, but its sensor says it's in a dock: it's being pressed, isn't fully seated, or the sensor isn't connected.
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
