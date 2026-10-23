<script setup lang="ts">
// Free jogging of the gantry to locate a tool's dock (new tools, or ones whose
// saved dock position is wrong). The result is a rough dock position that the
// wizard's pickup check then refines.
import { computed, ref, watch } from 'vue'
import { configIndex, homed, isPrinting, run, state, status, tc, tools, tryRun } from '../store'

const props = defineProps<{ toolNumber: number }>()

const steps = [0.1, 0.5, 1, 5, 10, 50]
const step = ref(5)
const go = ref({ x: '', y: '', z: '' })
const msg = ref('')
const error = ref('')

const tool = computed(() => tools.value.find((t) => t.number === props.toolNumber))
const label = computed(() => tool.value?.label ?? `T${props.toolNumber}`)
const onCarriage = computed(() => tools.value.find((t) => t.active))
const safeY = computed(() => Number(tc.value.params_safe_y ?? 120))
const pos = computed(() => {
  const p = status.value.toolhead?.position ?? [0, 0, 0]
  const o = status.value.gcode_move?.homing_origin ?? [0, 0, 0]
  return { x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] }
})
const limits = computed(() => ({ min: status.value.toolhead?.axis_minimum ?? [0, 0, 0], max: status.value.toolhead?.axis_maximum ?? [0, 0, 0] }))
const canMove = computed(() => homed.value === 'xyz' && !isPrinting.value && !state.busy)
const f = (v: number, d = 2) => (isNaN(v) ? '-' : v.toFixed(d))

watch(
  () => props.toolNumber,
  () => {
    msg.value = ''
    error.value = ''
  },
)

function jog(axis: 'X' | 'Y' | 'Z', dir: 1 | -1) {
  const d = +(step.value * dir).toFixed(3)
  const feed = axis === 'Z' ? (step.value >= 5 ? 600 : 300) : step.value >= 5 ? 3000 : 1200
  tryRun(`G91\nG0 ${axis}${d} F${feed}\nG90`, `Jog ${axis}${d > 0 ? '+' : ''}${d}`)
}

function fillGo() {
  go.value = { x: f(pos.value.x), y: f(pos.value.y), z: f(pos.value.z) }
}

async function goTo() {
  error.value = ''
  const t = { x: parseFloat(go.value.x), y: parseFloat(go.value.y), z: parseFloat(go.value.z) }
  if ([t.x, t.y, t.z].some((v) => isNaN(v))) {
    error.value = 'Enter X, Y and Z'
    return
  }
  const xy = `G0 X${t.x} Y${t.y} F6000`
  const z = `G0 Z${t.z} F900`
  // Going up: lift first, then travel. Going down: travel first, then lower.
  const script = t.z > pos.value.z ? `G90\n${z}\n${xy}` : `G90\n${xy}\n${z}`
  await tryRun(script, `Go to X${t.x} Y${t.y} Z${t.z}`)
}

async function backOff() {
  // Same way a dropoff leaves a dock: straight down 10 mm, then out in Y.
  const zDown = Math.max(pos.value.z - 10, limits.value.min[2] + 1)
  await tryRun(`G90\nG0 Z${zDown.toFixed(2)} F600\nG0 Y${safeY.value} F3000`, 'Back off: down 10 mm, out to safe Y')
}

async function saveHere() {
  error.value = ''
  msg.value = ''
  const x = +pos.value.x.toFixed(2)
  const y = +pos.value.y.toFixed(2)
  const z = +pos.value.z.toFixed(2)
  if (!confirm(`Use X${x} Y${y} Z${z} as ${label.value}'s dock position?\n\nThis is applied now and written to ${label.value}'s config file (backed up first). Refine it afterwards with the wizard's pickup check.`)) return
  try {
    for (const [a, v] of [['x', x], ['y', y], ['z', z]] as const) {
      await run(`SET_TOOL_PARAMETER T=${props.toolNumber} PARAMETER=params_park_${a} VALUE=${v}`, `Set ${label.value} park ${a.toUpperCase()}`)
    }
    await configIndex.load()
    const files = await configIndex.write(([['x', x], ['y', y], ['z', z]] as const).map(([a, v]) => ({ section: tool.value!.name, key: `params_park_${a}`, value: String(v) })))
    msg.value = `Saved X${x} Y${y} Z${z} as ${label.value}'s dock position (${files.join(', ')}). Back off, then run "1 · Pickup check" below to refine it.`
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <div class="stack">
    <p class="muted">
      Move the gantry freely to find {{ label }}'s dock. Use it for a new tool, or one whose saved dock position is wrong.
      Nothing here checks for collisions, so use small steps near the docks.
    </p>
    <ol class="muted list">
      <li><b>Empty the gantry</b> (dock the current tool) and go to <b>safe Y</b>.</li>
      <li>Move X to roughly in line with {{ label }}, and Z to about <b>10 mm below</b> the tool's mount.</li>
      <li>Bring Y toward the dock until the carriage is right under {{ label }}'s mount.</li>
      <li>Raise Z in small steps (0.5, then 0.1) until the pins line up and just start to latch.</li>
      <li><b>Use this position</b> as {{ label }}'s dock, then <b>Back off</b>, then run the wizard's <b>Pickup check</b> to refine it.</li>
    </ol>

    <div v-if="onCarriage" class="callout warn row">
      <span class="grow">{{ onCarriage.label }} is on the gantry.</span>
      <button class="blue" :disabled="!canMove || onCarriage.warnings.length > 0" @click="tryRun('UNSELECT_TOOL RESTORE_AXIS=', `Dock ${onCarriage.label}`)">Dock {{ onCarriage.label }}</button>
    </div>

    <div class="row">
      <span class="mono pos">X {{ f(pos.x) }} · Y {{ f(pos.y) }} · Z {{ f(pos.z) }}</span>
      <span class="grow" />
      <button :disabled="!canMove" @click="tryRun(`G90\nG0 Y${safeY} F3000`, 'Safe Y')">Go to safe Y ({{ safeY }})</button>
    </div>

    <div class="row">
      <span class="muted">Step</span>
      <button v-for="s in steps" :key="s" class="small" :class="{ blue: step === s }" @click="step = s">{{ s }}</button>
      <span class="muted">mm</span>
    </div>
    <div class="pad">
      <span />
      <button :disabled="!canMove" title="Toward the back" @click="jog('Y', 1)">Y+ ↑</button>
      <span />
      <button :disabled="!canMove" @click="jog('Z', 1)">Z+ (up)</button>
      <button :disabled="!canMove" @click="jog('X', -1)">← X−</button>
      <span class="mono center">{{ step }}</span>
      <button :disabled="!canMove" @click="jog('X', 1)">X+ →</button>
      <span />
      <span />
      <button :disabled="!canMove" title="Toward the front / docks" @click="jog('Y', -1)">Y− ↓</button>
      <span />
      <button :disabled="!canMove" @click="jog('Z', -1)">Z− (down)</button>
    </div>

    <div class="row">
      <label class="field">X <input v-model="go.x" class="mono" inputmode="decimal" style="width: 90px" /></label>
      <label class="field">Y <input v-model="go.y" class="mono" inputmode="decimal" style="width: 90px" /></label>
      <label class="field">Z <input v-model="go.z" class="mono" inputmode="decimal" style="width: 90px" /></label>
      <button class="small ghost" @click="fillGo">Use current</button>
      <button :disabled="!canMove" @click="goTo">Go</button>
    </div>
    <p class="muted small">Go raises Z before travelling when the target is higher, and travels before lowering when it is lower.</p>

    <div class="row">
      <button :disabled="!canMove" @click="backOff">Back off (down 10 mm, out to safe Y)</button>
      <span class="grow" />
      <button class="primary" :disabled="!canMove || !!onCarriage" :title="onCarriage ? 'Empty the gantry first' : ''" @click="saveHere">Use this position as {{ label }}'s dock</button>
    </div>
    <div v-if="msg" class="callout ok">{{ msg }}</div>
    <div v-if="error" class="callout err">{{ error }}</div>
  </div>
</template>

<style scoped>
p { margin: 0; }
.list { margin: 0; padding-left: 20px; display: grid; gap: 3px; font-size: 13px; }
.pos { font-size: 14px; }
.small { font-size: 12.5px; }
.pad { display: grid; grid-template-columns: repeat(4, 84px); gap: 6px; }
.pad .center { display: flex; align-items: center; justify-content: center; }
</style>
