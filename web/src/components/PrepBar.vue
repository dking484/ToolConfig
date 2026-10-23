<script setup lang="ts">
// Big, obvious "get the printer ready" controls: shown until the printer is
// homed and the gantry is levelled.
import { computed } from 'vue'
import { homed, isPrinting, runWithTool, state, status, tools, tryRun } from '../store'

const qgl = computed(() => !!status.value.quad_gantry_level?.applied)
const hasQgl = computed(() => 'quad_gantry_level' in status.value)
const onCarriage = computed(() => tools.value.find((t) => t.probeState === 'open'))
const show = computed(() => state.klippy === 'ready' && (homed.value !== 'xyz' || (hasQgl.value && !qgl.value)))
const disabled = computed(() => !!state.busy || isPrinting.value)
</script>

<template>
  <div v-if="show" class="callout warn prep">
    <div class="text">
      <strong>Get the printer ready</strong>
      <span>
        {{ homed === 'xyz' ? 'Homed.' : 'Not homed.' }}
        {{ hasQgl ? (qgl ? 'Gantry levelled.' : 'Gantry not levelled (QGL).') : '' }}
        Tool changes and dock tests need both.
      </span>
      <span v-if="homed !== 'xyz' && !onCarriage" class="err-text">
        No tool detected on the carriage. Z homing uses the tool's probe, so put a tool on the carriage first, then press <b>Detect tool</b>.
      </span>
      <span v-else-if="homed !== 'xyz'" class="muted">Homing heats {{ onCarriage?.label }}'s nozzle to the probing temperature (150 °C) before probing Z.</span>
    </div>
    <div class="buttons">
      <button v-if="homed !== 'xyz' && !onCarriage" :disabled="disabled" @click="tryRun('DETECT_ACTIVE_TOOL_PROBE', 'Detect tool')">Detect tool</button>
      <button class="big" :class="homed === 'xyz' ? '' : 'primary'" :disabled="disabled" @click="runWithTool('G28', 'Home all')">Home all</button>
      <button v-if="hasQgl" class="big" :class="homed === 'xyz' && !qgl ? 'primary' : ''" :disabled="disabled || homed !== 'xyz'" :title="homed !== 'xyz' ? 'Home first' : ''" @click="runWithTool('QUAD_GANTRY_LEVEL\nG28 Z', 'Quad gantry level')">Quad gantry level</button>
      <button v-if="hasQgl && homed !== 'xyz'" class="big blue" :disabled="disabled" @click="runWithTool('G28\nQUAD_GANTRY_LEVEL\nG28 Z', 'Home + level')">Home + level (all 3 steps)</button>
    </div>
  </div>
</template>

<style scoped>
.prep { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.text { flex: 1 1 320px; display: flex; flex-direction: column; gap: 3px; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.big { padding: 9px 16px; font-weight: 600; }
.err-text { color: var(--err); }
</style>
