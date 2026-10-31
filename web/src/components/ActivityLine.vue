<script setup lang="ts">
// What the printer is doing right now (heating, probing, moving), so a long
// command doesn't look like nothing is happening.
import { computed, onUnmounted, ref, watch } from 'vue'
import { state, status, tools } from '../store'
import { elapsed, heating, latestMessage } from '../lib/activity'

// idle_timeout says "Printing" whenever Klipper is executing something,
// including commands sent from Mainsail's console
const klipperBusy = computed(() => status.value.idle_timeout?.state === 'Printing')
const active = computed(() => !!state.busy || klipperBusy.value)

const since = ref(0)
const now = ref(Date.now())
let timer = 0
watch(
  active,
  (on) => {
    window.clearInterval(timer)
    if (!on) return
    since.value = state.busy ? state.busySince : Date.now()
    now.value = Date.now()
    timer = window.setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true },
)
onUnmounted(() => window.clearInterval(timer))

// Moonraker doesn't pass on commands sent from Mainsail or other clients,
// only their responses
const label = computed(() => state.busy || 'a command from Mainsail or a macro')
const message = computed(() => latestMessage(state.log, since.value))
const heaters = computed(() =>
  heating([
    ...tools.value.map((t) => ({ label: t.label, temp: t.temp, target: t.target })),
    { label: 'Bed', temp: status.value.heater_bed?.temperature ?? null, target: status.value.heater_bed?.target ?? null },
  ]),
)
const pos = computed(() => {
  const p = status.value.toolhead?.position
  return Array.isArray(p) ? `X${p[0].toFixed(1)} Y${p[1].toFixed(1)} Z${p[2].toFixed(2)}` : ''
})
</script>

<template>
  <div v-if="active" class="activity" role="status" aria-live="polite">
    <div class="row">
      <span class="spinner" aria-hidden="true" />
      <strong class="grow">Running: {{ label }}</strong>
      <span class="muted">{{ elapsed(now - since) }}</span>
    </div>
    <div v-for="h in heaters" :key="h.label" class="row heat">
      <span class="what">{{ h.target! > h.temp! ? 'Heating' : 'Cooling' }} {{ h.label }}</span>
      <span class="bar"><span :style="{ width: Math.min(100, (100 * h.temp!) / h.target!) + '%' }" /></span>
      <span class="mono">{{ h.temp!.toFixed(0) }} / {{ h.target!.toFixed(0) }} °C</span>
    </div>
    <div v-if="message" class="mono line">{{ message }}</div>
    <div v-if="pos" class="mono line muted">Toolhead {{ pos }}</div>
  </div>
</template>

<style scoped>
.activity { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: var(--radius); background: var(--panel-2); border: 1px solid var(--border); font-size: 13px; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--info); border-right-color: transparent; animation: spin 0.9s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.heat { gap: 8px; }
.what { min-width: 92px; }
.bar { flex: 1 1 120px; max-width: 220px; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--warn); }
.line { font-size: 12px; overflow-wrap: anywhere; }
</style>
