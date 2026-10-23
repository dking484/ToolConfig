<script setup lang="ts">
import { computed } from 'vue'
import { homed, printState, realign, safety, state, status, tc, tools, tryRun } from '../store'

// klipper-toolchanger never clears its own error_message, so only show it
// while the changer is actually in the error state.
const lastError = computed(
  () => (safety.value?.last_error as string) || (tc.value.status === 'error' ? (status.value.toolchanger_ui?.error_message as string) : '') || '',
)
const failedTool = computed<number>(() => safety.value?.last_error_tool ?? -1)
const show = computed(
  () => state.klippy === 'ready' && (tc.value.status === 'error' || !!lastError.value || (tc.value.status === 'uninitialized' && homed.value === 'xyz')),
)
const missingSafety = computed(() => state.klippy === 'ready' && state.objects.length > 0 && !state.objects.includes('gcode_macro _TC_SAFETY'))
const paused = computed(() => printState.value === 'paused')
const canMove = computed(() => homed.value === 'xyz' && !state.busy)

async function retry() {
  const n = failedTool.value
  if (n < 0) return
  if (!confirm(`Retry picking up T${n}?\n\nMake sure T${n} is seated in its dock and nothing is hanging off the carriage.`)) return
  await tryRun(`TC_RETRY_PICKUP T=${n}`, `Retry pickup T${n}`)
}
async function cancelPrint() {
  if (confirm('Cancel the print?')) await tryRun('CANCEL_PRINT', 'Cancel print')
}
async function dismiss() {
  await tryRun(`SET_GCODE_VARIABLE MACRO=_TC_SAFETY VARIABLE=last_error VALUE='""'`, 'Dismiss')
}
</script>

<template>
  <div v-if="missingSafety" class="callout warn">
    <strong>toolchanger-safety.cfg is not loaded.</strong>
    Failed pickups will still trigger M112 (emergency stop). Add
    <code>[include toolchanger/toolchanger-safety.cfg]</code> after the toolchanger include in printer.cfg.
  </div>

  <div v-if="show" class="callout" :class="tc.status === 'error' || lastError ? 'err' : 'warn'">
    <div class="row head">
      <strong class="grow">
        <template v-if="tc.status === 'error' || lastError">Tool change failed{{ failedTool >= 0 ? ` (T${failedTool})` : '' }}. The printer is still homed.</template>
        <template v-else>Toolchanger is not initialized.</template>
      </strong>
      <span v-if="paused" class="pill warn"><span class="dot" />Print paused</span>
    </div>
    <p v-if="lastError" class="msg mono">{{ lastError }}</p>

    <div class="row probes">
      <span class="muted">Probe states (last check):</span>
      <span v-for="t in tools" :key="t.number" class="pill" :class="t.probeState === 'open' ? 'ok' : t.probeState === 'docked' ? '' : 'warn'">
        <span class="dot" />{{ t.label }} {{ t.probeState === 'open' ? 'on carriage' : t.probeState }}
      </span>
    </div>

    <div class="row actions">
      <button :disabled="!!state.busy" @click="tryRun('DETECT_ACTIVE_TOOL_PROBE', 'Detect tool')">Detect tool</button>
      <button class="blue" :disabled="!!state.busy" @click="tryRun('TC_RECOVER', 'Recover')">Re-detect &amp; clear error</button>
      <button v-if="failedTool >= 0" :disabled="!canMove" @click="tryRun(`TC_BACK_OUT T=${failedTool}`, 'Back out')">Back out of T{{ failedTool }} dock</button>
      <button v-if="failedTool >= 0" class="primary" :disabled="!canMove" @click="retry">Retry pickup T{{ failedTool }}</button>
      <button v-if="failedTool >= 0" class="blue" title="Open the alignment wizard for this tool, starting with what happened during the pickup" @click="realign(failedTool)">Realign T{{ failedTool }}</button>
      <template v-if="paused">
        <button class="primary" :disabled="!!state.busy" @click="tryRun('RESUME', 'Resume')">Resume print</button>
        <button class="danger" :disabled="!!state.busy" @click="cancelPrint">Cancel print</button>
      </template>
      <span class="grow" />
      <button v-if="lastError" class="ghost small" @click="dismiss">Dismiss</button>
    </div>
    <p class="muted hint">
      Retry checks the probes first, forgets a tool that isn't really mounted, then picks up the tool again.
      <template v-if="paused">After a successful pickup, press Resume.</template>
    </p>
  </div>
</template>

<style scoped>
.head { margin-bottom: 4px; }
.msg { margin: 4px 0 8px; white-space: pre-wrap; }
.probes { margin: 6px 0 10px; }
.actions { margin-top: 4px; }
.hint { margin: 8px 0 0; font-size: 12.5px; }
</style>
