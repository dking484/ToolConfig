<script setup lang="ts">
// Guided dock calibration: the same questions and moves as a hands-on session.
//
// Pickup check (empty gantry under the docked tool):
//   pc-prep -> pc-short (2 mm below) -> [up / align / free] ... -> pc-latch (saved
//   height) -> [up / down / free] ... -> finish (use this position, pick up, verify, save)
// Dock fit (tool on the gantry):
//   check -> start (in front of dock) -> fit -> [dir -> amount -> move] ... -> test
//   -> passed: save | failed: what happened? -> verify fix / pickup check / mount
import { computed, ref, watch } from 'vue'
import NudgePad from './NudgePad.vue'
import { configIndex, detectTools, homed, isPrinting, run, safety, state, status, tc, tools, tryRun } from '../store'

const props = defineProps<{ toolNumber: number }>()

type Step =
  | 'check' | 'teach' | 'teach-recorded' | 'start' | 'fit' | 'adjust' | 'test' | 'failed' | 'mount' | 'verifyfix' | 'save' | 'done'
  | 'secure' | 'hold' | 'pc-prep' | 'pc-short' | 'pc-latch' | 'pc-free' | 'pc-freed' | 'pc-align' | 'pc-up' | 'pc-done' | 'pc-missed'
type Axis = 'X' | 'Y' | 'Z'
interface Option { label: string; desc: string; value: string }

const step = ref<Step>('check')
// Opened from "Realign" after a failed pickup: start at the "what happened?" question
function consumeEntry() {
  const e = state.wizardEntry
  if (e && e.tool === props.toolNumber) {
    step.value = e.step
    state.wizardEntry = null
  }
}
const axis = ref<Axis>('Y')
const busy = ref(false)
const note = ref('')
const error = ref('')
const moved = ref({ X: 0, Y: 0, Z: 0 })
const upFrom = ref<'pc-short' | 'pc-latch'>('pc-short')
const upHint = ref<'up' | 'down'>('up')

const n = computed(() => props.toolNumber)
const tool = computed(() => tools.value.find((t) => t.number === n.value))
const label = computed(() => tool.value?.label ?? `T${n.value}`)
const raw = computed(() => (tool.value ? status.value[tool.value.name] ?? {} : {}))
const onCarriage = computed(() => tools.value.find((t) => t.active))
// Which Y direction goes *into* the dock (the dropoff path approaches from the other side)
const inSign = computed<1 | -1>(() => {
  const first = (raw.value.params_dropoff_path ?? [])[0]
  return first && first.y < 0 ? 1 : -1
})
const pickupPath = computed<any[]>(() => raw.value.params_pickup_path ?? [])
const verifyAtEnd = computed(() => {
  const p = pickupPath.value
  return p.length > 0 && 'verify' in p[p.length - 1] && !p.slice(0, -1).some((x) => 'verify' in x)
})
const pos = computed(() => {
  const p = status.value.toolhead?.position ?? [0, 0, 0]
  const o = status.value.gcode_move?.homing_origin ?? [0, 0, 0]
  return { x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] }
})
const aligning = computed(() => tc.value.status === 'changing' && !!tool.value?.active)
const parkZ = computed(() => Number(raw.value.params_park_z))
const zRel = computed(() => pos.value.z - parkZ.value)
const f = (v: number, d = 2) => (isNaN(v) ? '-' : v.toFixed(d))

const baseBlockers = computed(() => {
  const out: string[] = []
  if (!safety.value) out.push('toolchanger-safety.cfg is not loaded')
  if (homed.value !== 'xyz') out.push('Home the printer first')
  if (isPrinting.value) out.push('A print is running')
  return out
})
// Flows that move to the saved dock position also need that position to be valid
const blockers = computed(() => [...baseBlockers.value, ...(tool.value?.warnings ?? [])])
const parkValid = computed(() => !!tool.value && tool.value.warnings.length === 0)
const onGantryHere = computed(() => !!tool.value?.active && tool.value.where !== 'dock')
const canTeach = computed(() => baseBlockers.value.length === 0 && onGantryHere.value)
const safeY = computed(() => Number(tc.value.params_safe_y ?? 120))

// Moonraker pushes status ~4x a second; let it catch up after a command.
const settle = () => new Promise((r) => setTimeout(r, 600))

async function act(fn: () => Promise<unknown>, next?: Step) {
  busy.value = true
  error.value = ''
  try {
    await fn()
    if (next) step.value = next
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function savePark(x: number, y: number, z: number) {
  await configIndex.load()
  const files = await configIndex.write(
    ([['x', x], ['y', y], ['z', z]] as const).map(([a, v]) => ({ section: tool.value!.name, key: `params_park_${a}`, value: String(v) })),
  )
  return `Saved ${label.value}'s dock position X${x} Y${y} Z${z} to ${files.join(', ')}. No restart needed.`
}

// ============ Teach by drop-off (tool on the gantry, free jog) ============
async function teachStart() {
  await act(async () => {
    if (!['ready', 'changing'].includes(tc.value.status)) {
      await run('TC_RECOVER', 'Re-detect')
      await settle()
    }
    if (!tools.value.find((t) => t.number === n.value)?.active) {
      throw new Error(`${label.value} is not on the gantry. Put it on by hand and press Detect tool.`)
    }
    // Docking mode: raw toolhead coordinates (no tool offsets) and no T commands
    if (tc.value.status !== 'changing') await run('ENTER_DOCKING_MODE', 'Docking mode (no motion)')
    // Dock moves during the first test run slowly
    await run(`SET_TOOL_PARAMETER T=${n.value} PARAMETER=params_path_speed VALUE=300`, 'Slow dock moves')
    await settle()
    moved.value = { X: 0, Y: 0, Z: 0 }
  }, 'teach')
}
async function teachSafeY() {
  await act(() => run(`G90\nG0 Y${safeY.value} F3000\nM400`, 'Go to safe Y'))
}
async function teachNearSaved() {
  const t = tool.value!
  const entryZ = t.park.z + 4
  await act(() =>
    run(`G90\nG0 Y${safeY.value} F3000\nG0 X${t.park.x} Z${entryZ} F3000\nG0 Y${Math.min(t.park.y + 30, safeY.value)} F3000\nM400`, 'In front of the saved dock'),
  )
}
async function teachRecord() {
  const x = +pos.value.x.toFixed(2)
  const y = +pos.value.y.toFixed(2)
  const z = +pos.value.z.toFixed(2)
  if (!confirm(`Record X${x} Y${y} Z${z} as ${label.value}'s dock position?\n\nIt's applied now. It is written to the config file only after the test passes.`)) return
  await act(async () => {
    for (const [a, v] of [['x', x], ['y', y], ['z', z]] as const) {
      await run(`SET_TOOL_PARAMETER T=${n.value} PARAMETER=params_park_${a} VALUE=${v}`, `Set ${label.value} dock ${a.toUpperCase()}`)
    }
    await settle()
  }, 'teach-recorded')
}
async function teachLeave() {
  await act(async () => {
    await run(`RESET_TOOL_PARAMETER T=${n.value} PARAMETER=params_path_speed`, 'Normal dock speed')
    await run('_TC_REAPPLY_TEST_SPEED', 'Keep test mode speed')
    if (tc.value.status === 'changing') await run('EXIT_DOCKING_MODE', 'Leave docking mode (no motion)')
  }, 'check')
}
async function quickDrop() {
  await act(() => run('UNSELECT_TOOL RESTORE_AXIS=', `Drop off ${onCarriage.value?.label ?? label.value}`))
}
async function quickPick() {
  await act(async () => {
    await run(`T${n.value}`, `Pick up ${label.value}`)
    await settle()
  })
}

// ======================= Dock fit (tool on the gantry) =======================
async function begin() {
  await act(async () => {
    if (!tool.value?.active) {
      await run(`T${n.value}`, `Pick up ${label.value}`)
      await settle()
    }
    if (tc.value.status === 'error') throw new Error('The pickup failed; see the banner above')
    if (!aligning.value) await run('TOOL_ALIGN_START', 'Move in front of dock')
    moved.value = { X: 0, Y: 0, Z: 0 }
  }, 'start')
}
async function enter() {
  await act(() => run('TC_ALIGN_ENTER', 'Slide into dock'), 'fit')
}
function answerFit(v: string) {
  if (v === 'ok') step.value = 'test'
  else {
    axis.value = v as Axis
    step.value = 'adjust'
  }
}
function onMoved(ax: Axis, d: number) {
  moved.value[ax] = +(moved.value[ax] + d).toFixed(3)
}
async function test() {
  busy.value = true
  error.value = ''
  note.value = ''
  try {
    await run('TOOL_ALIGN_TEST', `Test ${label.value} dock position`)
    step.value = 'save'
  } catch {
    step.value = 'failed'
  } finally {
    busy.value = false
  }
}
async function answerFailed(v: string) {
  note.value = ''
  if (v === 'clean') {
    // A clean pickup that reads as "no tool": the check ran too early.
    if (verifyAtEnd.value) note.value = 'probe'
    step.value = verifyAtEnd.value ? 'failed' : 'verifyfix'
  } else if (v === 'unseen') {
    await act(() => run(`TC_RETRY_PICKUP T=${n.value}`, `Retry pickup ${label.value}`), 'save')
  } else if (v === 'hanging') {
    step.value = 'hold'
  } else {
    // fell back / jammed / never came out / crooked: the pickup itself is off
    step.value = 'secure'
  }
}
async function mounted() {
  await act(async () => {
    await run('TC_RECOVER', 'Re-detect')
    await settle()
    const t = tools.value.find((x) => x.number === n.value)
    if (!t?.active) throw new Error(`${label.value} is still not detected on the gantry. Check it is fully seated.`)
  }, 'check')
}
async function fixVerify() {
  await act(async () => {
    const path = pickupPath.value.map((p) => {
      const { verify: _v, ...rest } = p
      return rest
    })
    path[path.length - 1] = { ...path[path.length - 1], verify: 1 }
    const literal = '[' + path.map((p) => '{' + Object.entries(p).map(([k, v]) => `'${k}':${v}`).join(', ') + '}').join(', ') + ']'
    await configIndex.load()
    await configIndex.write([{ section: 'toolchanger', key: 'params_pickup_path', value: literal }])
    for (const t of tools.value) await run(`SET_TOOL_PARAMETER T=${t.number} PARAMETER=params_pickup_path VALUE="${literal}"`, 'Apply pickup path')
    // The tool is in its dock and the gantry backed out: pick it up again with the corrected check
    await run(`TC_RETRY_PICKUP T=${n.value}`, `Retry pickup ${label.value}`)
  }, 'save')
}
async function save() {
  await act(async () => {
    const live = { ...raw.value }
    await run('TOOL_ALIGN_DONE', 'Finish alignment')
    note.value = await savePark(live.params_park_x, live.params_park_y, live.params_park_z)
  }, 'done')
}
async function cancel() {
  await act(async () => {
    if (tc.value.status === 'changing') await run('TOOL_ALIGN_CANCEL', 'Cancel alignment')
  }, 'check')
}

// ===================== Pickup check (empty gantry) =====================
async function secured() {
  // The tool should now be in its dock and the gantry empty
  await act(async () => {
    await run('TC_RECOVER', 'Re-detect')
    const open = await detectTools()
    if (open.length) throw new Error(`The sensors still show ${open.map((x) => 'T' + x).join(', ')} as not in a dock. Seat it properly in its dock.`)
  }, 'pc-prep')
}
async function dropOff() {
  await act(async () => {
    await run('UNSELECT_TOOL RESTORE_AXIS=', `Drop off ${onCarriage.value?.label ?? 'tool'}`)
    await settle()
    if (tc.value.status === 'error') throw new Error('The dropoff failed; see the banner above')
  })
}
async function pcStart() {
  moved.value = { X: 0, Y: 0, Z: 0 }
  await act(async () => {
    await run(`TC_PICKUP_CHECK_START T=${n.value}`, `Empty gantry under ${label.value}`)
    await settle() // let the 'changing' status arrive before showing the question
  }, 'pc-short')
}
async function pcGoto(z: number, next: Step) {
  await act(() => run(`TC_ALIGN_GOTO T=${n.value} Z=${z.toFixed(3)}`, `Z to ${z.toFixed(2)}`), next)
}
function answerShort(v: string) {
  if (v === 'gap') {
    upFrom.value = 'pc-short'
    upHint.value = 'up'
    step.value = 'pc-up'
  } else if (v === 'engage') pcGoto(parkZ.value, 'pc-latch')
  else if (v === 'latched') pcFinish()
  else if (v === 'misaligned') step.value = 'pc-align'
  else step.value = 'pc-free'
}
function answerLatch(v: string) {
  if (v === 'ok') pcFinish()
  else if (v === 'gap' || v === 'high') {
    upFrom.value = 'pc-latch'
    upHint.value = v === 'gap' ? 'up' : 'down'
    step.value = 'pc-up'
  } else step.value = 'pc-free'
}
function answerFreed(v: string) {
  if (v === 'centered') pcGoto(parkZ.value - 2, 'pc-short')
  else if (v === 'off') step.value = 'pc-align'
  else step.value = 'pc-free'
}
async function pcFinish() {
  busy.value = true
  error.value = ''
  try {
    await run(`TC_PICKUP_CHECK_FINISH T=${n.value}`, `Finish pickup of ${label.value}`)
    const open = await detectTools()
    if (!(open.length === 1 && open[0] === n.value)) {
      // Left the dock without the tool: ask where it is instead of leaving a dead end
      step.value = 'pc-missed'
      return
    }
    const live = { ...status.value[tool.value!.name] }
    note.value = await savePark(live.params_park_x, live.params_park_y, live.params_park_z)
    step.value = 'pc-done'
  } catch (e: any) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
async function answerMissed(v: string) {
  if (v === 'seated') {
    // Start over from the position just found (it is live on the tool)
    await act(async () => {
      await run('TC_RECOVER', 'Re-detect')
    }, 'pc-prep')
  } else if (v === 'hanging') step.value = 'hold'
  else step.value = 'secure'
}
// Pickup-check steps only work while Klipper is still in docking mode
const pcActive = computed(() => tc.value.status === 'changing' && !tool.value?.active)
const PC_STEPS: Step[] = ['pc-short', 'pc-latch', 'pc-align', 'pc-up', 'pc-free', 'pc-freed']
const pcLost = computed(() => PC_STEPS.includes(step.value) && !pcActive.value && !busy.value && !state.busy)
// The dock the gantry is actually at (the in-progress check may be for another tool)
const nearTool = computed(() =>
  tools.value.find((t) => Math.abs(pos.value.x - t.park.x) < 16 && Math.abs(pos.value.y - t.park.y) < 20 && Math.abs(pos.value.z - t.park.z) < 16),
)
async function pcAbort() {
  const t = nearTool.value?.number ?? n.value
  await act(() => run(`TC_PICKUP_CHECK_ABORT T=${t}`, 'Leave the dock'), 'check')
}

// ---- question content (same wording as the hands-on session) ----
const fitOptions: Option[] = [
  { value: 'ok', label: 'Seated perfectly', desc: 'Fully in the dock with no strain, as if it had been dropped off cleanly.' },
  { value: 'X', label: 'Off left / right (X)', desc: 'Pushed to one side, or the dock is not centered on the tool.' },
  { value: 'Z', label: 'Too high / too low (Z)', desc: 'Not resting down in the dock, or the gantry is pushing it down into it.' },
  { value: 'Y', label: 'Off front / back (Y)', desc: 'Not pushed far enough into the dock, or pressed too far into it.' },
]
// Which pad button moves the tool further into its dock (docks are approached from +Y on a Voron)
const intoDock = computed(() => (inSign.value > 0 ? '↑ Toward back' : '↓ Toward front'))
const outOfDock = computed(() => (inSign.value > 0 ? '↓ Toward front' : '↑ Toward back'))
const failedOptions: Option[] = [
  { value: 'clean', label: 'Latched clean, left in dock', desc: 'The pickup looked right (fully seated on the gantry), then the back-out left it properly in its dock.' },
  { value: 'fellback', label: 'Started out, fell back', desc: 'It began to come out with the gantry, then slipped back or got left behind.' },
  { value: 'never', label: 'Never came out', desc: 'The gantry went in and came back out empty; the tool stayed in its dock.' },
  { value: 'jammed', label: 'Jammed / bumped it', desc: 'The gantry hit or jammed against the tool on the way up.' },
  { value: 'hanging', label: 'Hanging on the gantry', desc: 'It came along but is only barely hooked on one pin.' },
  { value: 'crooked', label: 'Crooked on the dock', desc: 'It is sitting crooked or on top of the dock pins.' },
  { value: 'unseen', label: "Didn't see it", desc: 'I missed the moment. Try picking it up again while I watch.' },
]
const shortOptions: Option[] = [
  { value: 'gap', label: 'Not touching yet', desc: "There's still a gap between the gantry and the tool's mount." },
  { value: 'engage', label: 'Starting to engage', desc: 'The pins or magnets are just starting to meet, cleanly and centered.' },
  { value: 'latched', label: 'Already latched', desc: "It's already fully latched onto the tool at this height." },
  { value: 'misaligned', label: 'Misaligned in X/Y', desc: "The gantry is not lined up under the tool's mount (off to a side, or front/back)." },
  { value: 'jammed', label: 'Jammed against it', desc: "It's pressing or binding on the tool; the tool can't move." },
]
const latchOptions: Option[] = [
  { value: 'ok', label: 'Fully latched', desc: 'Pins fully in, magnets fully seated, no gap, and the tool is not lifted off its dock seat.' },
  { value: 'gap', label: 'Partly, small gap', desc: 'Engaged, but not fully seated yet.' },
  { value: 'high', label: 'Pushing the tool up', desc: 'The gantry has lifted the tool up off its dock seat (too high).' },
  { value: 'binding', label: 'Binding sideways', desc: 'Engaging off-center or jammed.' },
]
const missedOptions: Option[] = [
  { value: 'seated', label: 'Seated in its dock', desc: 'The tool stayed in its dock and sits properly; the gantry came out empty.' },
  { value: 'crooked', label: 'Crooked on the dock', desc: 'It is sitting crooked or on top of the dock pins.' },
  { value: 'hanging', label: 'Hanging on the gantry', desc: 'It came along but is only barely hooked on.' },
]
const freedOptions: Option[] = [
  { value: 'centered', label: 'Free, gantry centered', desc: "The tool dropped into place and the gantry looks centered under the tool's mount." },
  { value: 'off', label: 'Free, still off-center', desc: "The tool is free, but the gantry is not centered under the mount." },
  { value: 'jammed', label: 'Still jammed', desc: 'Lower it more.' },
]
const totalMoved = computed(() => (['X', 'Y', 'Z'] as const).filter((a) => moved.value[a]).map((a) => `${a} ${moved.value[a] > 0 ? '+' : ''}${moved.value[a]}`).join(', '))
const isPickup = computed(() => step.value.startsWith('pc-') || step.value === 'secure' || step.value === 'hold')
consumeEntry()
watch(() => state.wizardEntry, consumeEntry)
</script>

<template>
  <div class="wizard stack">
    <div class="row crumbs muted">
      <template v-if="isPickup">
        <span class="on">Pickup check</span>›
        <span :class="{ on: step === 'pc-short' || step === 'pc-align' || step === 'pc-free' || step === 'pc-freed' }">Line up</span>›
        <span :class="{ on: step === 'pc-latch' || step === 'pc-up' }">Latch</span>›
        <span :class="{ on: step === 'pc-done' }">Save</span>
      </template>
      <template v-else>
        <span :class="{ on: step === 'check' }">Check</span>›
        <span :class="{ on: step === 'start' }">Approach</span>›
        <span :class="{ on: ['fit', 'adjust'].includes(step) }">Dock fit</span>›
        <span :class="{ on: ['test', 'failed', 'mount', 'verifyfix'].includes(step) }">Test</span>›
        <span :class="{ on: ['save', 'done'].includes(step) }">Save</span>
      </template>
      <span class="grow" />
      <span v-if="totalMoved" class="mono">moved {{ totalMoved }}</span>
      <span class="mono">at X {{ f(pos.x) }} Y {{ f(pos.y) }} Z {{ f(pos.z) }}<template v-if="isPickup && !isNaN(zRel)"> ({{ zRel >= 0 ? '+' : '' }}{{ f(zRel) }} vs dock)</template></span>
    </div>

    <!-- ===================== CHECK / START ===================== -->
    <template v-if="step === 'check' && tc.status === 'changing'">
      <div class="callout info">
        <template v-if="tool?.active"><b>An alignment of {{ label }} is in progress</b> (docking mode, {{ label }} on the gantry).</template>
        <template v-else><b>A pickup check is in progress</b>: the empty gantry is in docking mode{{ nearTool ? ` at ${nearTool.label}'s dock` : '' }}.</template>
        Pick up where you left off, or leave the dock safely.
      </div>
      <div class="row">
        <span class="grow" />
        <button v-if="tool?.active" :disabled="busy" @click="cancel">Cancel alignment</button>
        <button v-if="tool?.active" :disabled="busy" @click="step = 'teach'">Resume teaching (move pad)</button>
        <button v-else :disabled="busy" @click="pcAbort">Leave the dock</button>
        <button class="primary" :disabled="busy || (!tool?.active && nearTool?.number !== n)" :title="!tool?.active && nearTool && nearTool.number !== n ? `The gantry is at ${nearTool.label}'s dock: select ${nearTool.label} above to resume` : ''" @click="step = tool?.active ? 'fit' : zRel < -0.5 ? 'pc-short' : 'pc-latch'">Resume</button>
      </div>
    </template>

    <template v-else-if="step === 'check'">
      <h3>Where do you want to start?</h3>
      <div class="options three">
        <button class="option" :disabled="busy || !!state.busy || !canTeach" @click="teachStart">
          <b>{{ label }} is on the gantry: teach by dropping it off</b>
          <span>Drive {{ label }} into its dock with the move pad until it sits down on the pins, record that, then test a real drop-off and pick-up. Works even if the saved position is wrong.</span>
        </button>
        <button class="option" :disabled="busy || !!state.busy || baseBlockers.length > 0" @click="step = 'pc-prep'">
          <b>{{ label }} is in its dock: pickup check</b>
          <span>The empty gantry comes up under {{ label }} slowly and you tell me how it lines up and latches. Finds where it really grabs the tool.</span>
        </button>
        <button class="option" :disabled="busy || !!state.busy || blockers.length > 0" @click="begin">
          <b>Check the saved position</b>
          <span>{{ tool?.active ? 'Slides' : `Picks up ${label}, then slides` }} it into its saved dock position so you can see how it sits, then tests a real drop-off and pick-up.</span>
        </button>
      </div>
      <div class="row">
        <span class="muted">Right now: {{ onGantryHere ? `${label} is on the gantry.` : onCarriage ? `${onCarriage.label} is on the gantry.` : 'the gantry is empty.' }}</span>
        <span class="grow" />
        <button v-if="onCarriage && !onCarriage.warnings.length" :disabled="busy || !!state.busy || baseBlockers.length > 0" @click="quickDrop">Drop off {{ onCarriage.label }}</button>
        <button v-if="!onGantryHere && parkValid" class="blue" :disabled="busy || !!state.busy || baseBlockers.length > 0" @click="quickPick">Pick up {{ label }}</button>
        <button :disabled="busy || !!state.busy" @click="tryRun('TC_DETECT', 'Detect tool')">Detect tool</button>
      </div>
      <p v-if="!onGantryHere && !parkValid" class="hint">
        {{ label }}'s saved dock position isn't valid yet, so it can't be picked up automatically. To teach by drop-off, put {{ label }} on the gantry by hand and press <b>Detect tool</b>.
      </p>
      <ul v-if="baseBlockers.length" class="blockers"><li v-for="b in baseBlockers" :key="b">{{ b }}</li></ul>
      <div v-if="!verifyAtEnd" class="callout warn">
        The pickup check runs while the tool is still resting in its dock. With per-tool Tap/OptoTap sensors, the dock keeps the sensor pressed there, so it still says "in dock",
        so good pickups get reported as failures. If a test fails but the tool latched cleanly, I'll offer to move the check to the end of the pickup path.
      </div>
    </template>

    <!-- ===================== TEACH BY DROP-OFF ===================== -->
    <template v-else-if="step === 'teach'">
      <h3>Bring {{ label }} into its dock with the pad until it sits fully down on the dock pins, the way it should rest after a drop-off.</h3>
      <ol class="muted list">
        <li>Go to safe Y, then move X until {{ label }} is in line with its dock.</li>
        <li>Set Z so the tool is a little above the dock (big steps), then move toward the dock in small steps.</li>
        <li>Lower it until it drops onto the pins and sits flat. Stop there; don't press it down.</li>
      </ol>
      <div class="row">
        <button :disabled="busy || !!state.busy" @click="teachSafeY">Go to safe Y ({{ safeY }})</button>
        <button v-if="parkValid" :disabled="busy || !!state.busy" @click="teachNearSaved">Go in front of the saved dock</button>
        <span v-if="parkValid && tool" class="muted mono small">saved: X{{ f(tool.park.x) }} Y{{ f(tool.park.y) }} Z{{ f(tool.park.z) }}</span>
      </div>
      <NudgePad free :tool-number="n" :initial-step="5" @moved="onMoved" />
      <div class="row">
        <button class="ghost" :disabled="busy || !!state.busy" title="Leaves docking mode without moving. Move the tool out of the dock first if it's in it." @click="teachLeave">Stop (no motion)</button>
        <span class="grow" />
        <button class="primary" :disabled="busy || !!state.busy" @click="teachRecord">It's seated: record this position</button>
      </div>
    </template>

    <template v-else-if="step === 'teach-recorded'">
      <div class="callout ok"><b>Recorded {{ label }}'s dock at X{{ raw.params_park_x }} Y{{ raw.params_park_y }} Z{{ raw.params_park_z }}</b> (active now, saved to the file after the test passes).</div>
      <div v-if="tool?.warnings.length" class="callout warn">
        Fix these before testing: <span v-for="w in tool.warnings" :key="w">{{ w }}. </span>
        <span v-if="tool.warnings.some((w) => w.startsWith('Safe Y'))">Set Safe Y with the tool's <b>Edit</b> button on the Tools tab (applies immediately).</span>
      </div>
      <p>Next, a real test from this position: {{ label }} leaves the dock along the pickup path, does a full drop-off, picks itself up again, and the sensors are checked. Dock moves run slowly.</p>
      <div class="row">
        <button :disabled="busy" @click="step = 'teach'">Keep adjusting</button>
        <span class="grow" />
        <button class="primary" :disabled="busy || !!state.busy || !!tool?.warnings.length" @click="test">Test from here</button>
      </div>
    </template>

    <template v-else-if="step === 'start'">
      <p>{{ label }} is in front of its dock. Next it slides slowly (5 mm/s, last bit 2.5 mm/s) along the dock path to the saved position
        <span class="mono">X{{ f(tool?.park.x ?? NaN) }} Y{{ f(tool?.park.y ?? NaN) }} Z{{ f(tool?.park.z ?? NaN) }}</span> and stops there with the tool still on the gantry.</p>
      <p class="muted">Keep a hand near the e-stop.</p>
      <div class="row"><span class="grow" /><button @click="cancel">Cancel</button><button class="primary" :disabled="busy" @click="enter">Slide into dock</button></div>
    </template>

    <!-- ===================== DOCK FIT ===================== -->
    <template v-else-if="step === 'fit'">
      <h3>{{ label }} is at {{ totalMoved ? 'the adjusted' : 'its saved' }} dock position with the tool still on the gantry. How does it sit in the dock?</h3>
      <div class="options">
        <button v-for="o in fitOptions" :key="o.value" class="option" :disabled="busy" @click="answerFit(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
      <div class="row"><span class="grow" /><button class="ghost small" :disabled="busy" @click="cancel">Cancel alignment</button></div>
    </template>

    <template v-else-if="step === 'adjust'">
      <h3>Move {{ label }} until it sits right in the dock. Small steps; each move is confirmed below.</h3>
      <p class="hint">
        <template v-if="axis === 'Y'">Sticking out → press <b>{{ intoDock }}</b> (further into the dock). Pushed in too far → press <b>{{ outOfDock }}</b>.</template>
        <template v-else-if="axis === 'X'">Press <b>← Left</b> or <b>Right →</b> until the tool is centered in the dock.</template>
        <template v-else>Tool held above its seat → press <b>Down</b>. Carriage pushing it down into the dock → press <b>Up</b>.</template>
      </p>
      <NudgePad :tool-number="n" @moved="onMoved" />
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="step = 'fit'">Check again</button></div>
    </template>

    <template v-else-if="step === 'test'">
      <p>Now a real test at this position: {{ label }} leaves the dock along the pickup path, does a full dropoff, picks itself up again, and the probes are checked.</p>
      <div class="row"><span class="grow" /><button @click="step = 'fit'">Adjust more</button><button class="primary" :disabled="busy" @click="test">Test this position</button></div>
    </template>

    <template v-else-if="step === 'failed' && note !== 'probe'">
      <div class="callout err">The pickup check failed: {{ safety?.last_error || 'no tool detected' }}. The printer is still homed.</div>
      <h3>What did {{ label }} do during that pickup, and where is it now?</h3>
      <div class="options">
        <button v-for="o in failedOptions" :key="o.value" class="option" :disabled="busy" @click="answerFailed(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
    </template>

    <template v-else-if="step === 'failed' && note === 'probe'">
      <div class="callout warn">
        The tool latched cleanly, and the check already runs at the end of the pickup path where the tool hangs free, yet its sensor still says "in dock".
        That points at the probe itself: a sticking Tap/OptoTap, a dirty or misaligned optical flag, or wiring. Check the live "Where each tool is" strip on the Tools tab with {{ label }} on the gantry: it should say on gantry.
      </div>
      <div class="row"><span class="grow" /><button @click="step = 'mount'">Mount it by hand and re-detect</button></div>
    </template>

    <template v-else-if="step === 'verifyfix'">
      <div class="callout info">
        <b>The pickup worked; the check ran too early.</b> It runs at the moment the gantry latches, while {{ label }} is still resting in its dock,
        and the dock keeps its Tap sensor pressed, so it still says "in dock". Moving the check to the end of the pickup path (tool lifted out and hanging free) fixes the false failures.
      </div>
      <p class="muted">This changes <code>params_pickup_path</code> in your toolchanger config (backed up first) and applies it to all tools now, with no restart.
        Then {{ label }} is picked up again with the corrected check.</p>
      <div class="row"><span class="grow" /><button @click="step = 'mount'">Not now</button><button class="primary" :disabled="busy" @click="fixVerify">Move the check and retry pickup</button></div>
    </template>

    <template v-else-if="step === 'mount'">
      <p><b>Put {{ label }} on the gantry by hand</b>, fully seated, so the toolchanger can see it again. Careful if it was hot.</p>
      <p class="muted">Then press the button. It re-reads all probes, with no motion and no restart.</p>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy" @click="mounted">It's on the gantry: re-detect</button></div>
    </template>

    <template v-else-if="step === 'save'">
      <div class="callout ok"><b>{{ label }} picked up and verified at X{{ raw.params_park_x }} Y{{ raw.params_park_y }} Z{{ raw.params_park_z }}.</b></div>
      <p>Save this as {{ label }}'s dock position? It's written to the tool's config file (backed up first) and is already active, so no restart is needed.</p>
      <div class="row"><span class="grow" /><button :disabled="!aligning" @click="step = 'fit'">Keep adjusting</button><button class="primary" :disabled="busy" @click="save">Save dock position</button></div>
    </template>

    <template v-else-if="step === 'done'">
      <div class="callout ok">{{ note }}</div>
      <p>Next: run a few dock cycles to confirm it's repeatable.</p>
      <div class="row">
        <span class="grow" />
        <button @click="step = 'check'; note = ''">Back to start</button>
        <button class="primary" :disabled="!!state.busy" @click="tryRun(`TC_TEST_DOCK T=${n} CYCLES=3`, `Dock test ${label} ×3`)">Run 3 dock cycles</button>
      </div>
    </template>

    <!-- ===================== PICKUP CHECK ===================== -->
    <template v-else-if="step === 'hold'">
      <div class="callout err"><b>Hold {{ label }} so it can't fall.</b> Nothing will move until you continue.</div>
      <p>Take {{ label }} off the gantry and seat it properly back in its dock (pins fully down). Then we'll check the pickup with an empty gantry.</p>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy" @click="secured">{{ label }} is back in its dock</button></div>
    </template>

    <template v-else-if="step === 'secure'">
      <p>The pickup itself needs adjusting. First make sure <b>{{ label }} is sitting properly in its dock</b> (not crooked or perched on the pins) and the gantry is empty.</p>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy" @click="secured">{{ label }} is seated in its dock</button></div>
    </template>

    <template v-else-if="step === 'pc-prep'">
      <p>The empty gantry will move under {{ label }} the way a pickup does, come up slowly and <b>stop 2 mm below</b> the saved dock height
        (<span class="mono">Z{{ f(parkZ - 2) }}</span>) so you can look before anything touches.</p>
      <div v-if="onCarriage" class="callout warn row">
        <span class="grow">{{ onCarriage.label }} is on the gantry. It has to go back in its dock first.</span>
        <button class="blue" :disabled="busy || !!state.busy" @click="dropOff">Drop off {{ onCarriage.label }}</button>
      </div>
      <p class="muted">Keep a hand near the e-stop.</p>
      <div class="row"><span class="grow" /><button class="ghost" @click="step = 'check'">Back</button><button class="primary" :disabled="busy || !!onCarriage" @click="pcStart">Move under {{ label }}</button></div>
    </template>

    <template v-else-if="pcLost">
      <div class="callout warn">
        <b>The pickup check is no longer active</b> (Klipper left docking mode, usually after an error, a restart or a command from elsewhere).
        Nothing will move from here. Start it again; it begins from {{ label }}'s current dock position X{{ raw.params_park_x }} Y{{ raw.params_park_y }} Z{{ raw.params_park_z }}.
      </div>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="step = 'pc-prep'">Start the pickup check again</button></div>
    </template>

    <template v-else-if="step === 'pc-missed'">
      <div class="callout warn">
        <b>{{ label }} didn't come out with the gantry.</b> The gantry left the dock along the pickup path, but no tool was detected on it,
        so it wasn't fully latched at that position. The position you found is kept (live, not saved yet).
      </div>
      <h3>Where is {{ label }} now?</h3>
      <div class="options">
        <button v-for="o in missedOptions" :key="o.value" class="option" :disabled="busy" @click="answerMissed(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
      <p class="hint">Seated in its dock → you'll start the pickup check again from the position you just found. Tip: when you press "Fully latched", the pins should be all the way in with no gap.</p>
    </template>

    <template v-else-if="step === 'pc-short'">
      <h3>The empty gantry is under {{ label }} at Z {{ f(pos.z) }} ({{ f(zRel) }} mm vs. its saved pickup height). What do you see?</h3>
      <div class="options">
        <button v-for="o in shortOptions" :key="o.value" class="option" :disabled="busy" @click="answerShort(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
      <div class="row"><span class="grow" /><button class="ghost small" :disabled="busy" @click="pcAbort">Stop and leave the dock</button></div>
    </template>

    <template v-else-if="step === 'pc-up'">
      <h3 v-if="upHint === 'up'">Press <b>Up</b> in small steps until the gantry fully latches onto {{ label }}.</h3>
      <h3 v-else>Press <b>Down</b> in small steps until {{ label }} rests on its dock seat again (the gantry is lifting it).</h3>
      <NudgePad :tool-number="n" axes="Z" :initial-step="0.25" @moved="onMoved" />
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="step = upFrom">Check again</button></div>
    </template>

    <template v-else-if="step === 'pc-latch'">
      <h3>Now at Z {{ f(pos.z) }} ({{ zRel >= 0 ? '+' : '' }}{{ f(zRel) }} mm vs. saved). Is the gantry fully latched onto {{ label }}?</h3>
      <div class="options">
        <button v-for="o in latchOptions" :key="o.value" class="option" :disabled="busy" @click="answerLatch(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
      <div class="row"><span class="grow" /><button class="ghost small" :disabled="busy" @click="pcAbort">Stop and leave the dock</button></div>
    </template>

    <template v-else-if="step === 'pc-free'">
      <h3>Press <b>Down</b> until {{ label }} drops back into place and is free. Straight down only, no sideways moves while it's jammed.</h3>
      <NudgePad :tool-number="n" axes="Z" :initial-step="0.5" @moved="onMoved" />
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="step = 'pc-freed'">It's free now</button></div>
    </template>

    <template v-else-if="step === 'pc-freed'">
      <h3>Lowered to Z {{ f(pos.z) }}. Is {{ label }} free and sitting properly in its dock?</h3>
      <div class="options">
        <button v-for="o in freedOptions" :key="o.value" class="option" :disabled="busy" @click="answerFreed(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
    </template>

    <template v-else-if="step === 'pc-align'">
      <h3>Line the gantry up under {{ label }}'s mount: move it the way it needs to go, as seen standing at the front of the printer.</h3>
      <p class="hint">Nothing is touching at this height, so sideways moves are safe. Each move is confirmed below.</p>
      <NudgePad :tool-number="n" axes="XY" :initial-step="0.25" @moved="onMoved" />
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="step = 'pc-short'">Check again</button></div>
    </template>

    <template v-else-if="step === 'pc-done'">
      <div class="callout ok"><b>{{ label }} picked up and verified.</b> {{ note }}</div>
      <p>Next: check how {{ label }} sits in its dock with the tool on the gantry, then test a real dropoff and pickup.</p>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy || !!state.busy" @click="begin">Continue: dock fit</button></div>
    </template>

    <div v-if="error" class="callout err">{{ error }}</div>
    <div v-if="busy || state.busy" class="muted">Running: {{ state.busy }}…</div>
  </div>
</template>

<style scoped>
p, h3 { margin: 0; }
h3 { font-size: 14.5px; line-height: 1.4; }
.crumbs { font-size: 12.5px; gap: 6px; }
.crumbs .on { color: var(--text); font-weight: 600; }
.options { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.option { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; white-space: normal; padding: 10px 12px; }
.option span { color: var(--muted); font-size: 12.5px; }
.option:hover:not(:disabled) { border-color: var(--accent-2); }
.hint { color: var(--muted); font-size: 13px; }
.hint b { color: var(--text); }
.blockers { margin: 0; padding-left: 20px; color: var(--warn); }
.list { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.options.three { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.small { font-size: 12.5px; }
</style>
