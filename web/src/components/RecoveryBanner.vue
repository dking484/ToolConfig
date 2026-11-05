<script setup lang="ts">
import { computed, ref } from 'vue'
import { homed, printState, realign, runWithTool, safety, state, status, tc, tools, tryRun } from '../store'
import { errorHint } from '../lib/errorHints'

const tcui = computed(() => status.value.toolchanger_ui ?? {})
// klipper-toolchanger never clears its own error_message, so only show it
// while the changer is actually in the error state.
const lastError = computed(
  () => (safety.value?.last_error as string) || (tc.value.status === 'error' ? (tcui.value.error_message as string) : '') || '',
)
const failedTool = computed<number>(() => safety.value?.last_error_tool ?? -1)
const changeFailed = computed(() => tc.value.status === 'error' || !!lastError.value)
const show = computed(
  () => state.klippy === 'ready' && (changeFailed.value || (tc.value.status === 'uninitialized' && homed.value === 'xyz')),
)
const missingSafety = computed(() => state.klippy === 'ready' && state.objects.length > 0 && !state.objects.includes('gcode_macro _TC_SAFETY'))
const paused = computed(() => printState.value === 'paused')
const canMove = computed(() => homed.value === 'xyz' && !state.busy)

// After a failed tool change or a crash Z can be off (a stalled gantry loses
// steps) while the printer still counts as homed. RESUME refuses until Z is
// re-set.
const zSuspect = computed<string>(() => (state.klippy === 'ready' && homed.value === 'xyz' && (tcui.value.z_suspect as string)) || '')
const toolOn = computed<number>(() => tcui.value.detected_tool ?? -1)

// The last G-code error. klipper-toolchanger forgets its tool on any error,
// which otherwise only shows up as "not initialized".
const DISMISS_KEY = 'toolconfig.errorDismissed'
function readDismissed() {
  try {
    return Number(localStorage.getItem(DISMISS_KEY) ?? 0)
  } catch {
    return 0
  }
}
const dismissedAt = ref(readDismissed())
const cmdError = computed(() => {
  const e = tcui.value.last_error as { message: string; time: number; reselected: number } | null | undefined
  if (state.klippy !== 'ready' || !e?.message || e.time <= dismissedAt.value || changeFailed.value) return null
  return { ...e, hint: errorHint(e.message) }
})
function dismissCmdError() {
  dismissedAt.value = cmdError.value?.time ?? Date.now() / 1000
  try {
    localStorage.setItem(DISMISS_KEY, String(dismissedAt.value))
  } catch {
    /* private window: it just comes back after a reload */
  }
}

async function retry() {
  const n = failedTool.value
  if (n < 0) return
  if (!confirm(`Retry picking up T${n}?\n\nMake sure T${n} is seated in its dock and nothing is hanging off the gantry.`)) return
  await tryRun(`TC_RETRY_PICKUP T=${n}`, `Retry pickup T${n}`)
}
async function rehomeZ() {
  const n = toolOn.value
  if (
    !confirm(
      `Re-set Z with T${n}?\n\nThe toolhead pulls straight back from the docks, moves to the centre of the bed at its current height, then probes there twice (heating T${n} to probe temperature) and corrects Z. Make sure T${n} is properly seated on the gantry.`,
    )
  )
    return
  await tryRun('TC_REHOME_Z', 'Re-set Z')
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

  <div v-if="zSuspect" class="callout err">
    <div class="row head">
      <strong class="grow">Z can't be trusted right now.</strong>
      <span v-if="paused" class="pill warn"><span class="dot" />Print paused</span>
    </div>
    <p class="msg">{{ zSuspect }}.</p>
    <p class="muted hint">
      A stalled gantry loses Z steps while the printer still counts as homed, so the nozzle can end up in the bed.
      <template v-if="paused">Resume is blocked until Z is re-set: with the tool on the gantry, ToolConfig probes the centre of the bed and corrects Z.</template>
      <template v-else>Home again before printing or teaching docks.</template>
    </p>
    <div class="row actions">
      <button class="primary" :disabled="!canMove || toolOn < 0" :title="toolOn < 0 ? 'Put a tool on the gantry first' : ''" @click="rehomeZ">
        Re-set Z{{ toolOn >= 0 ? ` with T${toolOn}` : '' }}
      </button>
      <button v-if="!paused && printState !== 'printing'" :disabled="!!state.busy" @click="runWithTool('G28', 'Home all')">Home all</button>
      <button v-if="paused" class="danger" :disabled="!!state.busy" @click="cancelPrint">Cancel print</button>
    </div>
  </div>

  <div v-if="show" class="callout" :class="changeFailed ? 'err' : 'warn'">
    <div class="row head">
      <strong class="grow">
        <template v-if="changeFailed">Tool change failed{{ failedTool >= 0 ? ` (T${failedTool})` : '' }}. The printer is still homed{{ zSuspect ? ', but Z may have shifted' : '' }}.</template>
        <template v-else>Toolchanger is not initialized.</template>
      </strong>
      <span v-if="paused && !zSuspect" class="pill warn"><span class="dot" />Print paused</span>
    </div>
    <p v-if="lastError" class="msg mono">{{ lastError }}</p>

    <div class="row probes">
      <span class="muted">Where the sensors say each tool is:</span>
      <span v-for="t in tools" :key="t.number" class="pill" :class="t.where === 'gantry' ? 'ok' : t.where === 'dock' ? '' : 'warn'">
        <span class="dot" />{{ t.label }} {{ t.where === 'gantry' ? 'on gantry' : t.where === 'dock' ? 'in dock' : 'unknown' }}
      </span>
    </div>

    <div class="row actions">
      <button :disabled="!!state.busy" @click="tryRun('TC_DETECT', 'Detect tool')">Detect tool</button>
      <button class="blue" :disabled="!!state.busy" @click="tryRun('TC_RECOVER', 'Recover')">Re-detect &amp; clear error</button>
      <button v-if="failedTool >= 0" :disabled="!canMove" @click="tryRun(`TC_BACK_OUT T=${failedTool}`, 'Back out')">Back out of T{{ failedTool }} dock</button>
      <button v-if="failedTool >= 0" class="primary" :disabled="!canMove" @click="retry">Retry pickup T{{ failedTool }}</button>
      <button v-if="failedTool >= 0" class="blue" title="Open the alignment wizard for this tool, starting with what happened during the pickup" @click="realign(failedTool)">Realign T{{ failedTool }}</button>
      <template v-if="paused">
        <button
          class="primary"
          :disabled="!!state.busy || !!zSuspect"
          :title="zSuspect ? 'Re-set Z first (above)' : ''"
          @click="tryRun('RESUME', 'Resume')"
        >
          Resume print
        </button>
        <button v-if="!zSuspect" class="danger" :disabled="!!state.busy" @click="cancelPrint">Cancel print</button>
      </template>
      <span class="grow" />
      <button v-if="lastError" class="ghost small" @click="dismiss">Dismiss</button>
    </div>
    <p class="muted hint">
      Retry checks the probes first, forgets a tool that isn't really mounted, then picks up the tool again.
      <template v-if="paused">After a successful pickup, re-set Z, then press Resume.</template>
    </p>
  </div>

  <div v-if="cmdError" class="callout warn">
    <div class="row head">
      <strong class="grow">Last command failed</strong>
      <button class="ghost small" @click="dismissCmdError">Dismiss</button>
    </div>
    <p class="msg mono">{{ cmdError.message }}</p>
    <p v-if="cmdError.hint" class="hint">{{ cmdError.hint }}</p>
    <p class="muted hint">
      Any error makes the toolchanger forget which tool is on.
      <template v-if="cmdError.reselected >= 0">ToolConfig selected T{{ cmdError.reselected }} again (no motion).</template>
      <template v-else-if="tc.status === 'uninitialized'">Press Detect tool to select the tool on the gantry again.</template>
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
