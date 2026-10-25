<script setup lang="ts">
import { computed } from 'vue'
import type { ToolInfo } from '../lib/tools'
import { homed, isPrinting, probing, realign, safety, state, tc } from '../store'

const props = defineProps<{ tool: ToolInfo }>()
defineEmits<{ select: []; edit: []; dock: []; park: [] }>()

const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined || isNaN(v) ? '-' : v.toFixed(d))
const t = computed(() => props.tool)
// A different tool the toolchanger currently has selected (a real conflict), if any
const otherSelected = computed(() => {
  const n = tc.value.tool_number
  return typeof n === 'number' && n >= 0 && n !== props.tool.number ? `T${n}` : ''
})
const hot = computed(() => (t.value.temp ?? 0) > 50)
const failed = computed(() => !!safety.value?.last_error && safety.value?.last_error_tool === props.tool.number)
const offsetsZero = computed(() => !t.value.offset.x && !t.value.offset.y && !t.value.offset.z)
</script>

<template>
  <article class="panel card" :class="{ active: t.active, failed }">
    <header class="panel-head">
      <span class="swatch" :style="{ background: t.color ?? 'var(--border)' }" />
      <h3>{{ t.label }}</h3>
      <span v-if="t.active && t.where !== 'dock'" class="pill ok"><span class="dot" />On gantry</span>
      <span v-else-if="t.active && probing" class="pill ok" title="The nozzle is touching the bed, which presses the Tap sensor"><span class="dot" />On gantry, probing</span>
      <span v-else-if="t.active" class="pill err" title="The toolchanger says this tool is mounted, but its sensor says it's in a dock (pressed, not seated, or not connected)"><span class="dot" />On gantry? sensor says dock</span>
      <span v-else-if="t.where === 'gantry' && otherSelected" class="pill warn" :title="`Its sensor says it's on the gantry, but the toolchanger has ${otherSelected} selected. It may be sitting crooked in its dock, or press Detect tool / Initialize changer.`"><span class="dot" />On gantry? {{ otherSelected }} is selected</span>
      <span v-else-if="t.where === 'gantry'" class="pill ok" title="Its sensor says it's on the gantry. The toolchanger selects it when you home or press Initialize changer."><span class="dot" />On gantry</span>
      <span v-else class="pill"><span class="dot" />{{ t.where === 'dock' ? 'In dock' : 'Unknown' }}</span>
      <span class="grow" />
      <span class="temp mono" :class="{ hot }">{{ f(t.temp) }}° <span class="muted">/ {{ f(t.target, 0) }}°</span></span>
    </header>
    <div class="panel-body">
      <table class="kv">
        <tbody>
          <tr><td>Nozzle</td><td>{{ t.nozzle !== null ? t.nozzle + ' mm' : '-' }} <span class="muted">· PA {{ f(t.pressureAdvance, 3) }}</span></td></tr>
          <tr><td>Dock (park)</td><td class="mono">X {{ f(t.park.x, 2) }} · Y {{ f(t.park.y, 2) }} · Z {{ f(t.park.z, 2) }}</td></tr>
          <tr><td>Safe Y</td><td class="mono">{{ f(t.safeY, 1) }}</td></tr>
          <tr>
            <td>Offsets</td>
            <td class="mono">
              <template v-if="offsetsZero && t.number !== 0"><span class="warn-text">0 / 0 / 0, not calibrated?</span></template>
              <template v-else>X {{ f(t.offset.x, 3) }} · Y {{ f(t.offset.y, 3) }} · Z {{ f(t.offset.z, 3) }}</template>
            </td>
          </tr>
          <tr><td>Probe z_offset</td><td class="mono">{{ f(t.probeZOffset, 3) }}</td></tr>
          <tr><td>Input shaper</td><td class="mono">X {{ t.shaper.x }} {{ f(t.shaper.fx, 1) }} Hz · Y {{ t.shaper.y }} {{ f(t.shaper.fy, 1) }} Hz</td></tr>
          <tr>
            <td>Board</td>
            <td>
              <template v-if="t.mcu">
                <span class="pill" :class="t.mcu.connected ? 'ok' : 'err'"><span class="dot" />{{ t.mcu.name }}</span>
                <span class="mono muted"> {{ t.mcu.canbusUuid ? 'CAN ' + t.mcu.canbusUuid : t.mcu.serial ? 'USB' : '' }}</span>
                <div class="muted small">{{ t.mcu.mcuType }} · {{ t.mcu.version ?? 'no firmware info' }}</div>
              </template>
              <span v-else class="muted">main board</span>
            </td>
          </tr>
          <tr><td>Extruder / fan</td><td class="mono muted">{{ t.extruder }} · {{ t.fan ?? 'no fan' }}</td></tr>
        </tbody>
      </table>
      <ul v-if="t.warnings.length" class="warnings">
        <li v-for="w in t.warnings" :key="w">{{ w }}</li>
      </ul>
    </div>
    <footer class="row foot">
      <button v-if="t.active" class="blue" :disabled="homed !== 'xyz' || isPrinting || !!state.busy || t.warnings.length > 0" :title="t.warnings.length ? 'Its dock position is not valid yet' : `Put ${t.label} back in its dock (gantry ends up empty at safe Y)`" @click="$emit('park')">Dock {{ t.label }}</button>
      <button v-else class="blue" :disabled="homed !== 'xyz' || isPrinting || !!state.busy || t.warnings.length > 0" @click="$emit('select')">Pick up {{ t.label }}</button>
      <button v-if="failed" class="primary" title="The last pickup of this tool failed: open the alignment wizard" @click="realign(t.number)">Realign {{ t.label }}</button>
      <button @click="$emit('edit')">Edit</button>
      <button @click="$emit('dock')">{{ t.warnings.length ? 'Find dock' : 'Calibrate' }}</button>
    </footer>
  </article>
</template>

<style scoped>
.card.active { border-color: color-mix(in srgb, var(--ok) 60%, var(--border)); }
.card.failed { border-color: color-mix(in srgb, var(--err) 70%, var(--border)); }
.swatch { width: 12px; height: 12px; border-radius: 3px; }
.temp.hot { color: var(--warn); }
.small { font-size: 12px; }
.warnings { margin: 10px 0 0; padding: 8px 10px 8px 26px; border-radius: 6px; background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--warn); font-size: 12.5px; }
.warn-text { color: var(--warn); }
.foot { padding: 0 14px 14px; }
</style>
