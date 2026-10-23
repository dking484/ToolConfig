<script setup lang="ts">
// Guided dock alignment: the same questions and moves as a hands-on session.
//   check -> start (in front of dock) -> enter (slide to saved dock position)
//   -> fit? -> [which way? -> how far? -> move -> fit?]... -> test
//   -> passed: save   |   failed: did it latch? -> explain + fix
import { computed, ref } from 'vue'
import { configIndex, homed, isPrinting, run, safety, state, status, tc, tools, tryRun } from '../store'

const props = defineProps<{ toolNumber: number }>()

type Step = 'check' | 'start' | 'fit' | 'dir' | 'amount' | 'test' | 'failed' | 'mount' | 'verifyfix' | 'save' | 'done'
type Axis = 'X' | 'Y' | 'Z'
interface Option { label: string; desc: string; value: string }

const step = ref<Step>('check')
const axis = ref<Axis>('Y')
const dirSign = ref<1 | -1>(1)
const custom = ref('')
const busy = ref(false)
const note = ref('')
const error = ref('')
const moved = ref({ X: 0, Y: 0, Z: 0 })

const tool = computed(() => tools.value.find((t) => t.number === props.toolNumber))
const label = computed(() => tool.value?.label ?? `T${props.toolNumber}`)
const raw = computed(() => (tool.value ? status.value[tool.value.name] ?? {} : {}))
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
const f = (v: number, d = 2) => (isNaN(v) ? '-' : v.toFixed(d))

const blockers = computed(() => {
  const out: string[] = []
  if (!safety.value) out.push('toolchanger-safety.cfg is not loaded')
  if (homed.value !== 'xyz') out.push('Home the printer first')
  if (isPrinting.value) out.push('A print is running')
  if (tool.value?.warnings.length) out.push(...tool.value.warnings)
  return out
})

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

// Moonraker pushes status ~4x a second; let it catch up after a command.
const settle = () => new Promise((r) => setTimeout(r, 600))

// ---- step actions ----
async function begin() {
  await act(async () => {
    if (!tool.value?.active) {
      await run(`T${props.toolNumber}`, `Pick up ${label.value}`)
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
    step.value = 'dir'
  }
}
function answerDir(v: string) {
  dirSign.value = v === '+' ? 1 : -1
  step.value = 'amount'
}
async function nudge(mm: number) {
  if (!(mm > 0 && mm <= 5)) {
    error.value = 'Pick an amount between 0 and 5 mm'
    return
  }
  const d = +(mm * dirSign.value).toFixed(3)
  await act(async () => {
    await run(`TC_ALIGN_NUDGE AXIS=${axis.value} DIST=${d}`, `Move ${axis.value}${d > 0 ? '+' : ''}${d}`)
    moved.value[axis.value] = +(moved.value[axis.value] + d).toFixed(3)
  }, 'fit')
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
async function answerLatched(v: string) {
  if (v === 'clean') {
    // A clean pickup that reads as "no tool": the check ran too early.
    step.value = verifyAtEnd.value ? 'failed' : 'verifyfix'
    if (verifyAtEnd.value) note.value = 'probe'
  } else if (v === 'unseen') {
    note.value = ''
    await act(() => run(`TC_RETRY_PICKUP T=${props.toolNumber}`, `Retry pickup ${label.value}`), 'save')
  } else {
    step.value = 'mount'
  }
}
async function mounted() {
  await act(async () => {
    await run('TC_RECOVER', 'Re-detect')
    await settle()
    const t = tools.value.find((x) => x.number === props.toolNumber)
    if (!t?.active) throw new Error(`${label.value} is still not detected on the carriage. Check it is fully seated.`)
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
    // The tool is in its dock and the carriage backed out: pick it up again with the corrected check
    await run(`TC_RETRY_PICKUP T=${props.toolNumber}`, `Retry pickup ${label.value}`)
  }, 'save')
}
async function save() {
  await act(async () => {
    const live = { ...raw.value }
    await run('TOOL_ALIGN_DONE', 'Finish alignment')
    await configIndex.load()
    const files = await configIndex.write(
      (['x', 'y', 'z'] as const).map((a) => ({ section: tool.value!.name, key: `params_park_${a}`, value: String(live[`params_park_${a}`]) })),
    )
    note.value = `Saved dock position X${live.params_park_x} Y${live.params_park_y} Z${live.params_park_z} to ${files.join(', ')}. No restart needed.`
  }, 'done')
}
async function cancel() {
  await act(async () => {
    if (tc.value.status === 'changing') await run('TOOL_ALIGN_CANCEL', 'Cancel alignment')
  }, 'check')
}

// ---- question content ----
const fitOptions = computed<Option[]>(() => [
  { value: 'ok', label: 'Seated perfectly', desc: 'Fully in the dock with no strain, as if it had been dropped off cleanly.' },
  { value: 'X', label: 'Off left / right (X)', desc: 'Pushed to one side, or the dock is not centered on the tool.' },
  { value: 'Z', label: 'Too high / too low (Z)', desc: 'Not resting down in the dock, or the carriage is pushing it down into it.' },
  { value: 'Y', label: 'Off front / back (Y)', desc: 'Not pushed far enough into the dock, or pressed too far into it.' },
])
const dirOptions = computed<Option[]>(() => {
  if (axis.value === 'Y') {
    return [
      { value: inSign.value > 0 ? '+' : '-', label: 'Sticking out', desc: 'The tool needs to go further into the dock.' },
      { value: inSign.value > 0 ? '-' : '+', label: 'Pushed in too far', desc: 'The carriage presses the tool into the dock; it needs to come out a bit.' },
    ]
  }
  if (axis.value === 'X') {
    return [
      { value: '-', label: 'Needs to move left', desc: 'Toward −X (left, facing the front of the printer).' },
      { value: '+', label: 'Needs to move right', desc: 'Toward +X (right, facing the front of the printer).' },
    ]
  }
  return [
    { value: '-', label: 'Too high: needs to go down', desc: 'The tool is held above its seat and not resting in the dock.' },
    { value: '+', label: 'Too low: needs to go up', desc: 'The carriage pushes the tool down into the dock.' },
  ]
})
const amounts = [0.25, 0.5, 1, 2, 3]
const latchedOptions: Option[] = [
  { value: 'clean', label: 'Latched clean, left in dock', desc: 'The pickup looked right (fully seated on the carriage), then the back-out left it properly in its dock.' },
  { value: 'crooked', label: "Didn't latch / crooked", desc: "It didn't seat properly and the tool is crooked or floating on the dock." },
  { value: 'latched-crooked', label: 'Latched, now crooked', desc: 'It seemed to latch, but the back-out left it sitting crooked.' },
  { value: 'unseen', label: "Didn't see it", desc: 'I missed the moment. Try picking it up again while I watch.' },
]
const totalMoved = computed(() => (['X', 'Y', 'Z'] as const).filter((a) => moved.value[a]).map((a) => `${a} ${moved.value[a] > 0 ? '+' : ''}${moved.value[a]}`).join(', '))
</script>

<template>
  <div class="wizard stack">
    <div class="row crumbs muted">
      <span :class="{ on: step === 'check' }">Check</span>›
      <span :class="{ on: ['start'].includes(step) }">Approach</span>›
      <span :class="{ on: ['fit', 'dir', 'amount'].includes(step) }">Fit</span>›
      <span :class="{ on: ['test', 'failed', 'mount', 'verifyfix'].includes(step) }">Test</span>›
      <span :class="{ on: ['save', 'done'].includes(step) }">Save</span>
      <span class="grow" />
      <span v-if="totalMoved" class="mono">moved {{ totalMoved }}</span>
      <span class="mono">at X {{ f(pos.x) }} Y {{ f(pos.y) }} Z {{ f(pos.z) }}</span>
    </div>

    <!-- CHECK -->
    <template v-if="step === 'check'">
      <p>
        We'll move {{ label }} in front of its dock, slide it slowly into the <b>saved</b> dock position, and you tell me how it sits.
        I'll adjust it until it's seated, then test a real dropoff and pickup, and save the position.
      </p>
      <div v-if="!verifyAtEnd" class="callout warn">
        The pickup check runs while the tool is still resting in its dock. With per-tool Tap/OptoTap probes, the dock can keep the probe
        reading "docked" there, so good pickups get reported as failures. If a test fails but the tool latched cleanly, I'll offer to move the check to the end of the pickup path.
      </div>
      <ul v-if="blockers.length" class="blockers"><li v-for="b in blockers" :key="b">{{ b }}</li></ul>
      <div class="row">
        <span class="muted grow">{{ tool?.active ? `${label} is on the carriage.` : `${label} will be picked up first.` }}</span>
        <button class="primary" :disabled="busy || !!state.busy || blockers.length > 0" @click="begin">{{ tool?.active ? 'Start' : `Pick up ${label} and start` }}</button>
      </div>
    </template>

    <!-- APPROACH -->
    <template v-else-if="step === 'start'">
      <p>{{ label }} is in front of its dock. Next it slides slowly (5 mm/s, last bit 2.5 mm/s) along the dock path to the saved position
        <span class="mono">X{{ f(tool?.park.x ?? NaN) }} Y{{ f(tool?.park.y ?? NaN) }} Z{{ f(tool?.park.z ?? NaN) }}</span> and stops there with the tool still on the carriage.</p>
      <p class="muted">Keep a hand near the e-stop.</p>
      <div class="row"><span class="grow" /><button @click="cancel">Cancel</button><button class="primary" :disabled="busy" @click="enter">Slide into dock</button></div>
    </template>

    <!-- FIT QUESTION -->
    <template v-else-if="step === 'fit'">
      <h3>{{ label }} is at {{ totalMoved ? 'the adjusted' : 'its saved' }} dock position with the tool still on the carriage. How does it sit in the dock?</h3>
      <div class="options">
        <button v-for="o in fitOptions" :key="o.value" class="option" :disabled="busy" @click="answerFit(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
    </template>

    <!-- DIRECTION -->
    <template v-else-if="step === 'dir'">
      <h3>Which way is {{ label }} off in {{ axis }}?</h3>
      <div class="options">
        <button v-for="o in dirOptions" :key="o.label" class="option" @click="answerDir(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
      <div class="row"><button class="ghost" @click="step = 'fit'">Back</button></div>
    </template>

    <!-- AMOUNT -->
    <template v-else-if="step === 'amount'">
      <h3>Roughly how far? I'll move it slowly so you can watch.</h3>
      <p class="muted">If you're not sure, pick a bit less than it looks; you'll be asked again afterwards.</p>
      <div class="row">
        <button v-for="a in amounts" :key="a" :disabled="busy" @click="nudge(a)">{{ a }} mm</button>
        <input v-model="custom" class="mono" style="width: 80px" placeholder="mm" inputmode="decimal" />
        <button :disabled="busy || !custom" @click="nudge(parseFloat(custom))">Move</button>
        <span class="grow" />
        <button class="ghost" @click="step = 'dir'">Back</button>
      </div>
    </template>

    <!-- TEST -->
    <template v-else-if="step === 'test'">
      <p>Now a real test at this position: {{ label }} leaves the dock along the pickup path, does a full dropoff, picks itself up again, and the probes are checked.</p>
      <div class="row"><span class="grow" /><button @click="step = 'fit'">Adjust more</button><button class="primary" :disabled="busy" @click="test">Test this position</button></div>
    </template>

    <!-- FAILED: DID IT LATCH? -->
    <template v-else-if="step === 'failed' && note !== 'probe'">
      <div class="callout err">The pickup check failed: {{ safety?.last_error || 'no tool detected' }}. The printer is still homed.</div>
      <h3>During that test, after the dropoff, did the carriage come back up and latch {{ label }} cleanly before it backed away? Where is {{ label }} now?</h3>
      <div class="options">
        <button v-for="o in latchedOptions" :key="o.value" class="option" :disabled="busy" @click="answerLatched(o.value)"><b>{{ o.label }}</b><span>{{ o.desc }}</span></button>
      </div>
    </template>

    <template v-else-if="step === 'failed' && note === 'probe'">
      <div class="callout warn">
        The tool latched cleanly, and the check already runs at the end of the pickup path where the tool hangs free, yet its probe still reads "docked".
        That points at the probe itself: a sticking Tap/OptoTap, a dirty or misaligned optical flag, or wiring. Run <b>Detect tool</b> with {{ label }} on the carriage to see what it reads.
      </div>
      <div class="row"><span class="grow" /><button @click="step = 'mount'">Mount it by hand and re-detect</button></div>
    </template>

    <!-- VERIFY TOO EARLY -->
    <template v-else-if="step === 'verifyfix'">
      <div class="callout info">
        <b>The pickup worked; the check ran too early.</b> It runs at the moment the carriage latches, while {{ label }} is still resting in its dock,
        and the dock holds the Tap in its "docked" state. Moving the check to the end of the pickup path (tool lifted out and hanging free) fixes the false failures.
      </div>
      <p class="muted">This changes <code>params_pickup_path</code> in your toolchanger config (backed up first) and applies it to all tools now, with no restart.
        Then {{ label }} is picked up again with the corrected check.</p>
      <div class="row"><span class="grow" /><button @click="step = 'mount'">Not now</button><button class="primary" :disabled="busy" @click="fixVerify">Move the check and retry pickup</button></div>
    </template>

    <!-- MOUNT BY HAND -->
    <template v-else-if="step === 'mount'">
      <p><b>Put {{ label }} on the carriage by hand</b>, fully seated, so the toolchanger can see it again. Careful if it was hot.</p>
      <p class="muted">Then press the button. It re-reads all probes, with no motion and no restart.</p>
      <div class="row"><span class="grow" /><button class="primary" :disabled="busy" @click="mounted">It's on the carriage: re-detect</button></div>
    </template>

    <!-- SAVE -->
    <template v-else-if="step === 'save'">
      <div class="callout ok"><b>{{ label }} picked up and verified at X{{ raw.params_park_x }} Y{{ raw.params_park_y }} Z{{ raw.params_park_z }}.</b></div>
      <p>Save this as {{ label }}'s dock position? It's written to the tool's config file (backed up first) and is already active, so no restart is needed.</p>
      <div class="row"><span class="grow" /><button @click="step = 'fit'" :disabled="!aligning">Keep adjusting</button><button class="primary" :disabled="busy" @click="save">Save dock position</button></div>
    </template>

    <!-- DONE -->
    <template v-else-if="step === 'done'">
      <div class="callout ok">{{ note }}</div>
      <p>Next: run a few dock cycles to confirm it's repeatable.</p>
      <div class="row">
        <span class="grow" />
        <button @click="step = 'check'; note = ''">Align again</button>
        <button class="primary" :disabled="!!state.busy" @click="tryRun(`TC_TEST_DOCK T=${props.toolNumber} CYCLES=3`, `Dock test ${label} ×3`)">Run 3 dock cycles</button>
      </div>
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
.blockers { margin: 0; padding-left: 20px; color: var(--warn); }
</style>
