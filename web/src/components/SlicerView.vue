<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { analyze, GcodeScanner, macroParams, type Finding, type PrinterFacts, type ScanResult } from '../lib/gcodeCheck'
import { mr, tools } from '../store'

interface GFile { path: string; modified: number; size: number }

const files = ref<GFile[]>([])
const picked = ref('')
const mode = ref<'file' | 'paste'>('file')
const pasted = ref('')
const progress = ref(0)
const running = ref(false)
const error = ref('')
const findings = ref<Finding[] | null>(null)
const scanInfo = ref<ScanResult | null>(null)
let abort: AbortController | null = null

onMounted(async () => {
  try {
    const list: GFile[] = await mr.call('server.files.list', { root: 'gcodes' })
    files.value = list.filter((f) => /\.(gcode|gco|g)$/i.test(f.path)).sort((a, b) => b.modified - a.modified)
    picked.value = files.value[0]?.path ?? ''
  } catch (e: any) {
    error.value = e.message
  }
})

async function facts(): Promise<PrinterFacts> {
  const res = await mr.call('printer.objects.query', { objects: { gcode: ['commands'], configfile: ['config'] } })
  const commands = new Set(Object.keys(res.status.gcode?.commands ?? {}).map((c) => c.toUpperCase()))
  const cfg = res.status.configfile?.config ?? {}
  const ps = cfg['gcode_macro PRINT_START'] ?? cfg['gcode_macro print_start']
  return {
    commands,
    tools: tools.value.map((t) => ({ number: t.number, nozzle: t.nozzle, name: t.name })),
    printStartParams: ps?.gcode ? macroParams(ps.gcode) : new Set(),
    sections: new Set(Object.keys(cfg).map((k) => k.toLowerCase())),
  }
}

async function check() {
  error.value = ''
  findings.value = null
  running.value = true
  progress.value = 0
  try {
    const f = await facts()
    if (mode.value === 'paste') {
      const s = new GcodeScanner(true)
      s.push(pasted.value)
      scanInfo.value = s.end()
      findings.value = analyze(scanInfo.value, f, true)
      return
    }
    const file = files.value.find((x) => x.path === picked.value)
    if (!file) return
    const s = new GcodeScanner()
    abort = new AbortController()
    await mr.stream('gcodes', file.path, (text, loaded) => {
      s.push(text)
      progress.value = file.size ? loaded / file.size : 0
    }, abort.signal)
    scanInfo.value = s.end()
    findings.value = analyze(scanInfo.value, f)
  } catch (e: any) {
    if (e.name !== 'AbortError') error.value = e.message
  } finally {
    running.value = false
    abort = null
  }
}

const order = { error: 0, warning: 1, info: 2, ok: 3 }
const sorted = computed(() => [...(findings.value ?? [])].sort((a, b) => order[a.severity] - order[b.severity]))
const counts = computed(() => {
  const c = { error: 0, warning: 0 }
  for (const f of findings.value ?? []) if (f.severity === 'error' || f.severity === 'warning') c[f.severity]++
  return c
})
const ORCA_START = 'PRINT_START TOOL=[initial_tool] TOOL_TEMP={nozzle_temperature_initial_layer[initial_tool]} BED_TEMP=[bed_temperature_initial_layer_single]'
const ORCA_CHANGE = 'T[next_extruder]'
const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB'
</script>

<template>
  <section class="stack">
    <div class="panel">
      <header class="panel-head">
        <h2 class="grow">Check a sliced file against this printer</h2>
        <button class="small" :class="{ blue: mode === 'file' }" @click="mode = 'file'">G-code file</button>
        <button class="small" :class="{ blue: mode === 'paste' }" @click="mode = 'paste'">Paste slicer G-code</button>
      </header>
      <div class="panel-body stack">
        <p class="muted">
          Finds every command the file uses and checks it against the commands and macros that exist in Klipper right now, so you see "Unknown command" problems before a print stops on them.
          For OrcaSlicer files it also checks the embedded profile: multi-material mode, nozzle sizes per tool, extruder offsets, and the parameters passed to PRINT_START.
        </p>
        <div v-if="mode === 'file'" class="row">
          <select v-model="picked" class="grow">
            <option v-for="f in files" :key="f.path" :value="f.path">{{ f.path }} · {{ mb(f.size) }} · {{ new Date(f.modified * 1000).toLocaleDateString() }}</option>
          </select>
          <button v-if="running" @click="abort?.abort()">Stop</button>
          <button v-else class="primary" :disabled="!picked" @click="check">Check file</button>
        </div>
        <template v-else>
          <textarea v-model="pasted" rows="8" placeholder="Paste Orca's Machine start G-code, Change filament G-code, etc." />
          <div class="row">
            <span class="muted small grow">Slicer placeholders like [next_extruder] are fine here.</span>
            <button class="primary" :disabled="!pasted.trim() || running" @click="check">Check snippet</button>
          </div>
        </template>
        <div v-if="running && mode === 'file'" class="bar"><div :style="{ width: (progress * 100).toFixed(1) + '%' }" /></div>
        <div v-if="error" class="callout err">{{ error }}</div>
      </div>
    </div>

    <div v-if="findings" class="panel">
      <header class="panel-head">
        <h2 class="grow">Results</h2>
        <span class="pill" :class="counts.error ? 'err' : 'ok'"><span class="dot" />{{ counts.error }} errors</span>
        <span class="pill" :class="counts.warning ? 'warn' : 'ok'"><span class="dot" />{{ counts.warning }} warnings</span>
        <span v-if="scanInfo" class="muted small hide-sm">{{ scanInfo.lines.toLocaleString() }} lines · {{ scanInfo.slicer || 'unknown slicer' }}</span>
      </header>
      <div class="panel-body stack">
        <div v-for="(f, i) in sorted" :key="i" class="callout" :class="f.severity === 'error' ? 'err' : f.severity === 'warning' ? 'warn' : f.severity === 'ok' ? 'ok' : 'info'">
          <strong>{{ f.title }}</strong>
          <div class="detail">{{ f.detail }}</div>
          <div v-if="f.fix" class="fix"><b>Fix:</b> {{ f.fix }}</div>
          <pre v-if="f.lines?.length" class="mono lines">{{ f.lines.join('\n') }}</pre>
        </div>
      </div>
    </div>

    <div class="panel">
      <header class="panel-head"><h2 class="grow">Recommended OrcaSlicer setup for this printer</h2></header>
      <div class="panel-body stack">
        <ol class="howto">
          <li>Printer settings → Basic information: untick <b>Single Extruder Multi Material</b>.</li>
          <li>Set the number of extruders to <b>{{ tools.length }}</b>; give each one its own nozzle diameter ({{ tools.map((t) => `${t.label} ${t.nozzle ?? '?'} mm`).join(', ') }}).</li>
          <li>G-code flavor: <b>Klipper</b>. Leave the extruder offsets at 0 (Klipper applies each tool's offsets).</li>
          <li>Machine start G-code:</li>
        </ol>
        <pre class="mono snippet">{{ ORCA_START }}</pre>
        <ol class="howto" start="5"><li>Change filament G-code (tool change):</li></ol>
        <pre class="mono snippet">{{ ORCA_CHANGE }}</pre>
        <p class="muted small">Machine end G-code: <code>PRINT_END</code>. Paste your own G-code above to check it.</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
p { margin: 0; }
.small { font-size: 12.5px; }
.bar { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
.bar div { height: 100%; background: var(--accent-2); transition: width .2s; }
.detail { margin-top: 3px; }
.fix { margin-top: 5px; }
.lines { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--muted); max-height: 180px; overflow-y: auto; }
.howto { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.snippet { margin: 0; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
