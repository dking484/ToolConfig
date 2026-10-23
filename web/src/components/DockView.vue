<script setup lang="ts">
import { computed, ref } from 'vue'
import { configIndex, homed, isPrinting, safety, state, status, tc, tools, tryRun } from '../store'
import LogPanel from './LogPanel.vue'
import AlignWizard from './AlignWizard.vue'
import DockFinder from './DockFinder.vue'

const tool = computed(() => tools.value.find((t) => t.number === state.dockTool) ?? tools.value[0])
const n = computed(() => tool.value?.number ?? 0)
const cycles = ref(5)
const speed = ref(Math.round((safety.value?.test_speed_factor ?? 0.35) * 100))
const step = ref(0.1)
const steps = [0.02, 0.05, 0.1, 0.5, 1, 5]
const saveMsg = ref('')

const testMode = computed(() => !!safety.value?.test_mode)
const aligning = computed(() => tc.value.status === 'changing' && tool.value?.active)
const pos = computed(() => {
  const p = status.value.toolhead?.position ?? [0, 0, 0]
  const o = status.value.gcode_move?.homing_origin ?? [0, 0, 0]
  return { x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] }
})
const delta = computed(() => (tool.value ? { x: pos.value.x - tool.value.park.x, y: pos.value.y - tool.value.park.y, z: pos.value.z - tool.value.park.z } : null))

const checks = computed(() => {
  const t = tool.value
  const hot = (t?.temp ?? 0) > 150
  return [
    { ok: !!safety.value, label: 'Safe-failure macros loaded (no M112 on a failed pickup)' },
    { ok: homed.value === 'xyz', label: 'Printer homed (use Home all above)' },
    { ok: !!status.value.quad_gantry_level?.applied, label: 'Gantry levelled (use Quad gantry level above)' },
    { ok: ['ready', 'changing'].includes(tc.value.status), label: `Toolchanger ready (now: ${tc.value.status})` },
    { ok: !!t && t.warnings.length === 0, label: t?.warnings.length ? t.warnings.join('; ') : `${t?.label} dock position looks sane` },
    { ok: !hot, label: hot ? `${t?.label} nozzle is ${t?.temp?.toFixed(0)}°C. Probing tools refuse to work above 150°C` : 'Nozzle cool enough' },
    { ok: !isPrinting.value, label: 'Not printing' },
  ]
})
const ready = computed(() => checks.value.every((c) => c.ok) && !state.busy)

const f = (v: number | undefined, d = 2) => (v === undefined || isNaN(v) ? '-' : v.toFixed(d))

async function setTestMode(on: boolean) {
  await tryRun(`TC_TEST_MODE ENABLE=${on ? 1 : 0} SPEED=${(speed.value / 100).toFixed(2)}`, on ? 'Test mode on' : 'Test mode off')
}
function runTest() {
  tryRun(`TC_TEST_DOCK T=${n.value} CYCLES=${cycles.value}`, `Dock test T${n.value} ×${cycles.value}`)
}
function jog(axis: 'X' | 'Y' | 'Z', dir: 1 | -1) {
  const d = (step.value * dir).toFixed(3)
  tryRun(`G91\nG0 ${axis}${d} F${axis === 'Z' ? 300 : 1200}\nG90`, `Jog ${axis}${d}`)
}
async function saveAlignment() {
  saveMsg.value = ''
  const ok = await tryRun('TOOL_ALIGN_DONE', 'Finish alignment')
  if (!ok || !tool.value) return
  // status now holds the live (tested) park position; persist it to Tn.cfg
  const t = status.value[tool.value.name]
  try {
    await configIndex.load()
    const files = await configIndex.write(
      (['x', 'y', 'z'] as const).map((a) => ({ section: tool.value!.name, key: `params_park_${a}`, value: String(t[`params_park_${a}`]) })),
    )
    saveMsg.value = `Saved park X${t.params_park_x} Y${t.params_park_y} Z${t.params_park_z} to ${files.join(', ')} (no restart needed).`
  } catch (e: any) {
    saveMsg.value = 'Could not save to the config file: ' + e.message
  }
}
</script>

<template>
  <section class="dock">
    <div class="stack">
      <div class="panel">
        <header class="panel-head">
          <h2 class="grow">Tool</h2>
          <button v-for="t in tools" :key="t.number" class="small" :class="{ blue: t.number === n }" @click="state.dockTool = t.number">{{ t.label }}</button>
        </header>
        <div v-if="tool" class="panel-body">
          <table class="kv">
            <tbody>
              <tr><td>Saved dock</td><td class="mono">X {{ f(tool.park.x) }} · Y {{ f(tool.park.y) }} · Z {{ f(tool.park.z) }} <span class="muted">· safe Y {{ f(tool.safeY, 1) }}</span></td></tr>
              <tr><td>On gantry</td><td>{{ tc.tool ? String(tc.tool).replace('tool ', '') : 'nothing' }} <span class="muted">· {{ tool.label }}'s sensor says: {{ tool.where === 'gantry' ? 'on gantry' : tool.where === 'dock' ? 'in dock' : 'unknown' }}</span></td></tr>
            </tbody>
          </table>
          <ul class="checks">
            <li v-for="c in checks" :key="c.label" :class="c.ok ? 'ok' : 'bad'">{{ c.ok ? '✓' : '✗' }} {{ c.label }}</li>
          </ul>
        </div>
      </div>

      <div class="panel">
        <header class="panel-head">
          <h2 class="grow">1 · Test mode</h2>
          <span class="pill" :class="testMode ? 'info' : ''"><span class="dot" />{{ testMode ? 'ON' : 'off' }}</span>
        </header>
        <div class="panel-body stack">
          <p class="muted">Slows every dock move and makes a failed pickup report-only: the gantry backs out of the dock, nothing pauses, and you can retry right away.</p>
          <div class="row">
            <label class="field">Dock speed <span class="mono">{{ speed }}%</span>
              <input v-model.number="speed" type="range" min="10" max="100" step="5" :disabled="testMode" />
            </label>
            <span class="grow" />
            <button v-if="!testMode" class="blue" :disabled="!!state.busy || isPrinting" @click="setTestMode(true)">Enable test mode</button>
            <button v-else :disabled="!!state.busy" @click="setTestMode(false)">Disable test mode</button>
          </div>
        </div>
      </div>

      <details :key="`find-${n}`" class="panel manual" :open="!!tool?.warnings.length">
        <summary class="panel-head">
          <h2 class="grow">2 · Find {{ tool?.label }}'s dock (free jog)</h2>
          <span v-if="tool?.warnings.length" class="pill warn"><span class="dot" />dock position not valid</span>
        </summary>
        <div class="panel-body">
          <DockFinder :tool-number="n" />
        </div>
      </details>

      <div class="panel">
        <header class="panel-head">
          <h2 class="grow">3 · Align the dock position</h2>
          <span v-if="aligning" class="pill info"><span class="dot" />aligning {{ tool?.label }}</span>
        </header>
        <div class="panel-body stack">
          <AlignWizard :key="n" :tool-number="n" />
        </div>
      </div>

      <div class="panel">
        <header class="panel-head"><h2 class="grow">4 · Repeat dock / pick-up</h2></header>
        <div class="panel-body stack">
          <p class="muted">Picks up {{ tool?.label }} if needed, then drops it in its dock and picks it up again, verifying the probe each time. Stops at the first failure and says what the probes saw.</p>
          <div class="row">
            <label class="field">Cycles <input v-model.number="cycles" type="number" min="1" max="50" style="width: 80px" /></label>
            <span class="grow" />
            <div class="counters">
              <span class="pill ok"><span class="dot" />{{ safety?.test_pass ?? 0 }} passed</span>
              <span class="pill" :class="(safety?.test_fail ?? 0) ? 'err' : ''"><span class="dot" />{{ safety?.test_fail ?? 0 }} failed</span>
            </div>
            <button class="primary" :disabled="!ready" @click="runTest">Run {{ cycles }}×</button>
          </div>
          <p v-if="!testMode" class="muted small">Tip: enable test mode first for slow, forgiving moves.</p>
        </div>
      </div>

      <details class="panel manual">
        <summary class="panel-head"><h2 class="grow">Manual alignment (jog pad)</h2></summary>
        <div class="panel-body stack">
          <ol class="steps muted">
            <li>Pick up {{ tool?.label }}, then <b>Start</b>. The gantry moves in front of the dock in docking mode, so moves are in raw toolhead coordinates.</li>
            <li>Jog until the tool sits seated in its dock, exactly as if it had just been picked up.</li>
            <li><b>Test this position</b>: undocks and redocks using it, and verifies pickup. Repeat as needed.</li>
            <li><b>Save</b> writes the park position to the tool's config file. No restart needed.</li>
          </ol>
          <div class="row">
            <button v-if="tool && !tool.active" class="blue" :disabled="homed !== 'xyz' || !!state.busy || isPrinting" @click="tryRun(`T${n}`, `Pick up T${n}`)">Pick up {{ tool.label }}</button>
            <button :disabled="!tool?.active || aligning || !ready" @click="tryRun('TOOL_ALIGN_START', 'Start alignment')">Start</button>
            <button class="primary" :disabled="!aligning || !!state.busy" @click="tryRun('TOOL_ALIGN_TEST', 'Test position')">Test this position</button>
            <button class="blue" :disabled="!aligning || !!state.busy" @click="saveAlignment">Save</button>
            <button :disabled="!aligning || !!state.busy" @click="tryRun('TOOL_ALIGN_CANCEL', 'Cancel alignment')">Cancel</button>
          </div>
          <p v-if="saveMsg" class="callout info">{{ saveMsg }}</p>

          <div class="jog" :class="{ off: !aligning }">
            <div class="row">
              <span class="muted">Step</span>
              <button v-for="s in steps" :key="s" class="small" :class="{ blue: step === s }" @click="step = s">{{ s }}</button>
            </div>
            <div class="pad">
              <span />
              <button :disabled="!aligning || !!state.busy" @click="jog('Y', 1)">Y+</button>
              <span />
              <button :disabled="!aligning || !!state.busy" @click="jog('Z', 1)">Z+</button>
              <button :disabled="!aligning || !!state.busy" @click="jog('X', -1)">X−</button>
              <span class="mono center">{{ step }}</span>
              <button :disabled="!aligning || !!state.busy" @click="jog('X', 1)">X+</button>
              <span />
              <span />
              <button :disabled="!aligning || !!state.busy" @click="jog('Y', -1)">Y−</button>
              <span />
              <button :disabled="!aligning || !!state.busy" @click="jog('Z', -1)">Z−</button>
            </div>
            <table class="kv mono">
              <tbody>
                <tr><td>Position</td><td>X {{ f(pos.x, 3) }} · Y {{ f(pos.y, 3) }} · Z {{ f(pos.z, 3) }}</td></tr>
                <tr v-if="delta"><td>vs saved dock</td><td>ΔX {{ f(delta.x, 3) }} · ΔY {{ f(delta.y, 3) }} · ΔZ {{ f(delta.z, 3) }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <div class="panel">
        <header class="panel-head"><h2 class="grow">If something goes wrong</h2></header>
        <div class="panel-body row">
          <button :disabled="homed !== 'xyz' || !!state.busy" @click="tryRun(`TC_BACK_OUT T=${n}`, 'Back out')">Back out of {{ tool?.label }} dock</button>
          <button class="blue" :disabled="!!state.busy" @click="tryRun('TC_RECOVER', 'Recover')">Re-detect &amp; clear error</button>
          <button :disabled="!!state.busy" @click="tryRun('DETECT_ACTIVE_TOOL_PROBE', 'Detect')">Detect tool</button>
          <span class="muted small">None of these restart Klipper or lose homing.</span>
        </div>
      </div>
    </div>

    <LogPanel class="log" />
  </section>
</template>

<style scoped>
.dock { display: grid; gap: 14px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: start; }
@media (max-width: 980px) { .dock { grid-template-columns: 1fr; } }
.log { position: sticky; top: 64px; }
.checks { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 3px; font-size: 13px; }
.checks .ok { color: var(--ok); }
.checks .bad { color: var(--warn); }
.counters { display: flex; gap: 6px; }
.steps { margin: 0; padding-left: 18px; display: grid; gap: 3px; font-size: 13px; }
.small { font-size: 12.5px; }
.jog { display: grid; gap: 10px; }
.jog.off { opacity: .55; }
.pad { display: grid; grid-template-columns: repeat(4, 64px); gap: 6px; }
.pad .center { display: flex; align-items: center; justify-content: center; }
p { margin: 0; }
.manual > summary { cursor: pointer; list-style: none; }
.manual:not([open]) > summary { border-bottom: none; }
</style>
