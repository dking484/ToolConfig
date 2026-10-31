<script setup lang="ts">
// Z offsets from each tool's own Tap probe (TC_MEASURE_Z), applied live with
// TC_SET_Z_OFFSET and saved to the tool's config file.
import { computed, ref, watch } from 'vue'
import { configIndex, homed, isPrinting, run, state, status, tc, tools } from '../store'
import LogPanel from './LogPanel.vue'

interface Measured {
  trigger: number
  spread: number
  probe_z_offset: number
  gcode_z_offset: number
  new_probe_z_offset: number | null
  new_gcode_z_offset: number | null
}
interface ZMeasure {
  time: number
  x: number
  y: number
  reference: number
  complete: boolean
  tools: Record<string, Measured>
}

const SPREAD = 0.02
const ui = computed(() => status.value.toolchanger_ui ?? {})
const liveProbeZ = computed<Record<string, number>>(() => ui.value.probe_z_offsets ?? {})
const probeTools = computed(() => tools.value.filter((t) => String(t.number) in liveProbeZ.value))
const ref0 = computed(() => (probeTools.value.some((t) => t.number === 0) ? 0 : probeTools.value[0]?.number ?? 0))
const m = computed(() => (ui.value.z_measure ?? null) as ZMeasure | null)

// Tools to measure: by default the ones whose dock position is valid
const picked = ref<number[]>([])
watch(
  probeTools,
  (list) => {
    if (!picked.value.length) picked.value = list.filter((t) => !t.warnings.length || t.number === ref0.value).map((t) => t.number)
  },
  { immediate: true },
)
const toMeasure = computed(() => [...new Set([ref0.value, ...picked.value])].sort((a, b) => a - b))
const x = ref<number | ''>('')
const y = ref<number | ''>('')

const hot = computed(() => probeTools.value.filter((t) => toMeasure.value.includes(t.number) && (t.temp ?? 0) > 150))
const checks = computed(() => [
  { ok: ui.value.sensors === 'tool_probe', label: 'Every tool has its own probe' },
  { ok: homed.value === 'xyz', label: 'Printer homed' },
  { ok: tc.value.status === 'ready', label: `Toolchanger ready (now: ${tc.value.status})` },
  { ok: !isPrinting.value, label: 'Not printing' },
  {
    ok: !hot.value.length,
    label: hot.value.length ? `${hot.value.map((t) => t.label).join(', ')} above 150°C: Tap probing refuses hot nozzles` : 'Nozzles at 150°C or cooler',
  },
  {
    ok: !probeTools.value.some((t) => toMeasure.value.includes(t.number) && t.warnings.length),
    label: 'Every tool to measure has a valid dock position',
  },
])
const ready = computed(() => checks.value.every((c) => c.ok) && !state.busy && toMeasure.value.length > 1)
const error = ref('')
const note = ref('')

async function measure() {
  error.value = ''
  note.value = ''
  const xy = (x.value !== '' ? ` X=${x.value}` : '') + (y.value !== '' ? ` Y=${y.value}` : '')
  try {
    await run(`TC_MEASURE_Z TOOLS=${toMeasure.value.join(',')} REF=${ref0.value}${xy}`, 'Measure Z offsets')
  } catch (e: any) {
    error.value = e.message
  }
}

// ---- results ----
const rows = computed(() => {
  const r = m.value
  if (!r) return []
  return Object.entries(r.tools)
    .map(([n, v]) => {
      const tool = tools.value.find((t) => t.number === Number(n))
      const isRef = Number(n) === r.reference
      const nowProbe = liveProbeZ.value[n]
      const nowGcode = tool?.offset.z ?? 0
      const applied =
        !isRef && v.new_probe_z_offset !== null && Math.abs(nowProbe - v.new_probe_z_offset) < 0.0005 && Math.abs(nowGcode - (v.new_gcode_z_offset ?? 0)) < 0.0005
      return { n: Number(n), label: tool?.label ?? `T${n}`, name: tool?.name ?? `tool T${n}`, isRef, v, nowProbe, nowGcode, applied, steady: v.spread <= SPREAD }
    })
    .sort((a, b) => a.n - b.n)
})
const apply = ref<number[]>([])
watch(
  () => m.value?.time,
  () => (apply.value = rows.value.filter((r) => !r.isRef && r.steady && !r.applied).map((r) => r.n)),
  { immediate: true },
)
const refRow = computed(() => rows.value.find((r) => r.isRef))
// T0 measured right after homing with it should trigger at its own z_offset
const refCheck = computed(() => (refRow.value ? refRow.value.v.trigger - refRow.value.v.probe_z_offset : null))
const when = computed(() => (m.value ? new Date(m.value.time * 1000).toLocaleString() : ''))
const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || isNaN(v) ? '-' : (v > 0 ? '+' : '') + v.toFixed(d))

async function applySave() {
  error.value = ''
  note.value = ''
  const chosen = rows.value.filter((r) => apply.value.includes(r.n) && r.v.new_probe_z_offset !== null)
  if (!chosen.length) return
  const list = chosen.map((r) => `${r.label}: probe z_offset ${f(r.v.new_probe_z_offset)}, gcode_z_offset ${f(r.v.new_gcode_z_offset)}`).join('\n')
  if (!confirm(`Apply now and save to the tool files?\n\n${list}\n\nThe files are backed up first. No restart needed.`)) return
  try {
    await configIndex.load()
    const edits = chosen.flatMap((r) => [
      { section: `tool_probe T${r.n}`, key: 'z_offset', value: r.v.new_probe_z_offset!.toFixed(3) },
      { section: r.name, key: 'gcode_z_offset', value: r.v.new_gcode_z_offset!.toFixed(3) },
    ])
    // A value in printer.cfg's SAVE_CONFIG block wins over the tool's file
    const shadowed = edits.filter((e) => configIndex.autosaveValue(e.section, e.key) !== undefined)
    if (shadowed.length) {
      throw new Error(
        `printer.cfg's SAVE_CONFIG block sets ${shadowed.map((e) => `[${e.section}] ${e.key}`).join(', ')}, which would override the tool file. Remove it there first.`,
      )
    }
    const files = await configIndex.write(edits)
    for (const r of chosen) {
      await run(`TC_SET_Z_OFFSET T=${r.n} PROBE_Z=${r.v.new_probe_z_offset!.toFixed(3)} GCODE_Z=${r.v.new_gcode_z_offset!.toFixed(3)}`, `Apply ${r.label} Z offsets`)
    }
    note.value = `Saved to ${files.join(', ')} and active now.`
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <section class="zo">
    <div class="stack">
      <div class="panel">
        <header class="panel-head"><h2 class="grow">Measure Z offsets</h2></header>
        <div class="panel-body stack">
          <p>
            Each tool's nozzle is its own probe. This homes Z with {{ probeTools.find((t) => t.number === ref0)?.label ?? 'T0' }} (the reference), then picks up each
            tool and probes the same spot on the bed twice. Nozzles heat to probe temperature one at a time and are turned off again.
          </p>
          <ul class="muted small expl">
            <li><b>Probe z_offset</b>: where that tool's sensor triggers. Set from the measurement, homing with any tool gives the same Z.</li>
            <li><b>gcode_z_offset</b>: how much longer or shorter the nozzle is than the reference. This assumes the Tap sensors press in about the same amount before they trigger; the first layer shows what's left.</li>
          </ul>
          <div class="row wrap">
            <span class="muted">Tools:</span>
            <label v-for="t in probeTools" :key="t.number" class="pick" :class="{ dim: t.warnings.length }" :title="t.warnings.join('; ')">
              <input v-model="picked" type="checkbox" :value="t.number" :disabled="t.number === ref0" />
              {{ t.label }}<span v-if="t.number === ref0" class="muted"> (reference)</span>
            </label>
          </div>
          <div class="row wrap">
            <span class="muted">Bed spot:</span>
            <label>X <input v-model.number="x" type="number" placeholder="center" class="num" /></label>
            <label>Y <input v-model.number="y" type="number" placeholder="center" class="num" /></label>
            <span class="muted small">Bed at print temperature gives the most useful numbers.</span>
          </div>
          <ul class="checks">
            <li v-for="c in checks" :key="c.label" :class="c.ok ? 'ok' : 'bad'">{{ c.ok ? '✓' : '✗' }} {{ c.label }}</li>
          </ul>
          <div class="row">
            <span class="grow" />
            <button class="primary" :disabled="!ready" @click="measure">Measure {{ toMeasure.map((n) => 'T' + n).join(', ') }}</button>
          </div>
          <div v-if="state.busy" class="muted">Running: {{ state.busy }}…</div>
        </div>
      </div>

      <div v-if="m" class="panel">
        <header class="panel-head">
          <h2 class="grow">Results</h2>
          <span class="muted small">{{ when }} · X{{ m.x.toFixed(1) }} Y{{ m.y.toFixed(1) }}{{ m.complete ? '' : ' · stopped early' }}</span>
        </header>
        <div class="panel-body stack">
          <table class="list">
            <thead>
              <tr><th></th><th>Tool</th><th>Trigger</th><th>Probe z_offset</th><th>gcode_z_offset</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.n">
                <td><input v-if="!r.isRef" v-model="apply" type="checkbox" :value="r.n" :disabled="r.applied" /></td>
                <td>{{ r.label }}</td>
                <td class="mono">
                  {{ f(r.v.trigger) }}
                  <span v-if="!r.steady" class="warn-text" :title="`The two probes were ${r.v.spread.toFixed(3)} mm apart`"> unsteady ±{{ r.v.spread.toFixed(3) }}</span>
                </td>
                <template v-if="r.isRef">
                  <td class="mono">{{ f(r.nowProbe) }} <span class="muted">reference</span></td>
                  <td class="mono">{{ f(r.nowGcode) }} <span class="muted">reference</span></td>
                </template>
                <template v-else>
                  <td class="mono">{{ f(r.nowProbe) }} → <b>{{ f(r.v.new_probe_z_offset) }}</b></td>
                  <td class="mono">{{ f(r.nowGcode) }} → <b>{{ f(r.v.new_gcode_z_offset) }}</b><span v-if="r.applied" class="ok-text"> applied</span></td>
                </template>
              </tr>
            </tbody>
          </table>
          <p v-if="refCheck !== null" class="small" :class="Math.abs(refCheck) > 0.05 ? 'warn-text' : 'muted'">
            Check: {{ refRow!.label }} triggered {{ f(refCheck) }} mm from its own z_offset right after homing with it
            {{ Math.abs(refCheck) > 0.05 ? '. That much usually means the bed spot differs from the homing spot (bed not flat or not level) or the probe is unsteady.' : '(should be near 0).' }}
          </p>
          <div class="row">
            <span class="grow" />
            <button class="primary" :disabled="!apply.length || !!state.busy" @click="applySave">Apply and save {{ apply.map((n) => 'T' + n).join(', ') }}</button>
          </div>
          <div v-if="note" class="callout ok">{{ note }}</div>
        </div>
      </div>
      <div v-if="error" class="callout err">{{ error }}</div>
    </div>
    <LogPanel class="log" />
  </section>
</template>

<style scoped>
.zo { display: grid; gap: 14px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: start; }
@media (max-width: 980px) { .zo { grid-template-columns: 1fr; } }
.log { position: sticky; top: 64px; }
p { margin: 0; }
.expl { margin: 0; padding-left: 18px; display: grid; gap: 3px; }
.small { font-size: 12.5px; }
.wrap { flex-wrap: wrap; }
.pick { display: inline-flex; align-items: center; gap: 4px; }
.pick.dim { opacity: .6; }
.num { width: 80px; }
.checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 3px; font-size: 13px; }
.checks .ok { color: var(--ok); }
.checks .bad { color: var(--warn); }
.warn-text { color: var(--warn); }
.ok-text { color: var(--ok); }
</style>
