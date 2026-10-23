<script setup lang="ts">
// Direct, plainly-labelled moves for the wizard's adjust steps. Stays on screen
// and confirms every move, so small nudges are never invisible.
import { computed, ref } from 'vue'
import { run, state, status } from '../store'

// free: plain relative moves with coarse steps too (teaching a dock from scratch,
// where the saved dock position may be far off); otherwise TC_ALIGN_NUDGE, which
// stays within 15 mm of the saved dock and moves slowly.
const props = withDefaults(defineProps<{ toolNumber: number; axes?: string; initialStep?: number; free?: boolean }>(), {
  axes: 'XYZ',
  initialStep: 0.5,
  free: false,
})
const emit = defineEmits<{ moved: [axis: 'X' | 'Y' | 'Z', dist: number] }>()

const steps = props.free ? [0.1, 0.25, 0.5, 1, 5, 10, 25] : [0.1, 0.25, 0.5, 1, 2]

function freeMove(axis: 'X' | 'Y' | 'Z', d: number) {
  const s = Math.abs(d)
  const feed = axis === 'Z' ? (s >= 5 ? 600 : s >= 1 ? 300 : 120) : s >= 10 ? 3000 : s >= 1 ? 1200 : 300
  return `G91\nG0 ${axis}${d} F${feed}\nG90\nM400`
}
const step = ref(props.initialStep)
const busy = ref(false)
const last = ref<{ ok: boolean; text: string } | null>(null)

const pos = computed(() => {
  const p = status.value.toolhead?.position ?? [0, 0, 0]
  const o = status.value.gcode_move?.homing_origin ?? [0, 0, 0]
  return { X: p[0] - o[0], Y: p[1] - o[1], Z: p[2] - o[2] }
})

const WORDS: Record<string, [string, string]> = {
  X: ['to the left', 'to the right'],
  Y: ['toward the front', 'toward the back'],
  Z: ['down', 'up'],
}

async function move(axis: 'X' | 'Y' | 'Z', sign: 1 | -1) {
  const d = +(step.value * sign).toFixed(3)
  const before = pos.value[axis]
  busy.value = true
  last.value = null
  try {
    const script = props.free ? freeMove(axis, d) : `TC_ALIGN_NUDGE T=${props.toolNumber} AXIS=${axis} DIST=${d}`
    await run(script, `Move ${axis}${d > 0 ? '+' : ''}${d}`)
    // let the status catch up so the readout shows the new position
    await new Promise((r) => setTimeout(r, 400))
    last.value = {
      ok: true,
      text: `Moved ${step.value} mm ${WORDS[axis][sign > 0 ? 1 : 0]}: ${axis} ${before.toFixed(2)} → ${pos.value[axis].toFixed(2)}`,
    }
    emit('moved', axis, d)
  } catch (e: any) {
    last.value = { ok: false, text: e.message }
  } finally {
    busy.value = false
  }
}
const off = computed(() => busy.value || !!state.busy)
</script>

<template>
  <div class="nudge">
    <div class="row">
      <span class="muted">Move by</span>
      <button v-for="s in steps" :key="s" class="small" :class="{ blue: step === s }" @click="step = s">{{ s }} mm</button>
    </div>
    <div class="pad" :class="{ withz: axes.includes('Z') && axes !== 'Z', zonly: axes === 'Z' }">
      <template v-if="axes.includes('Y')">
        <span />
        <button :disabled="off" @click="move('Y', 1)">↑ Toward back<small>Y+</small></button>
        <span />
      </template>
      <template v-if="axes.includes('X')">
        <button :disabled="off" @click="move('X', -1)">← Left<small>X−</small></button>
        <span class="mono center">{{ step }} mm</span>
        <button :disabled="off" @click="move('X', 1)">Right →<small>X+</small></button>
      </template>
      <template v-if="axes.includes('Y')">
        <span />
        <button :disabled="off" @click="move('Y', -1)">↓ Toward front<small>Y−</small></button>
        <span />
      </template>
      <div v-if="axes.includes('Z')" class="zcol">
        <button :disabled="off" @click="move('Z', 1)">Up<small>Z+</small></button>
        <button :disabled="off" @click="move('Z', -1)">Down<small>Z−</small></button>
      </div>
    </div>
    <div class="mono readout">Now at X {{ pos.X.toFixed(2) }} · Y {{ pos.Y.toFixed(2) }} · Z {{ pos.Z.toFixed(2) }}</div>
    <div v-if="busy" class="muted">Moving…</div>
    <div v-else-if="last" class="feedback" :class="last.ok ? 'ok' : 'err'">{{ last.ok ? '✓ ' : '✗ ' }}{{ last.text }}</div>
  </div>
</template>

<style scoped>
.nudge { display: grid; gap: 10px; }
.pad { display: grid; grid-template-columns: repeat(3, 120px); gap: 6px; align-items: stretch; }
.pad.withz { grid-template-columns: repeat(3, 120px) 120px; }
.pad.zonly { grid-template-columns: 120px; }
.pad.zonly .zcol { grid-column: 1; grid-row: auto; }
.pad button { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 8px 6px; }
.pad small { color: var(--muted); font-size: 11px; }
.center { display: flex; align-items: center; justify-content: center; }
.zcol { grid-column: 4; grid-row: 1 / span 3; display: flex; flex-direction: column; gap: 6px; justify-content: center; }
.readout { font-size: 13.5px; }
.feedback { padding: 6px 10px; border-radius: 6px; font-size: 13px; }
.feedback.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.feedback.err { color: var(--err); background: color-mix(in srgb, var(--err) 10%, transparent); }
.small { font-size: 12.5px; }
@media (max-width: 560px) {
  .pad { grid-template-columns: repeat(3, 1fr); }
  .pad.withz { grid-template-columns: repeat(4, 1fr); }
  .pad.zonly { grid-template-columns: 1fr; }
}
</style>
