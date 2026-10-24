<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { emergencyStop, firmwareRestart, homed, isPrinting, printState, runWithTool, state, status, tc } from './store'
import RecoveryBanner from './components/RecoveryBanner.vue'
import PrepBar from './components/PrepBar.vue'
import ToolRequiredDialog from './components/ToolRequiredDialog.vue'
import ToolsView from './components/ToolsView.vue'
import DockView from './components/DockView.vue'
import SlicerView from './components/SlicerView.vue'
import HardwareView from './components/HardwareView.vue'
import LogPanel from './components/LogPanel.vue'

const tabs = [
  { id: 'tools', label: 'Tools' },
  { id: 'dock', label: 'Dock test & align' },
  { id: 'slicer', label: 'Slicer check' },
  { id: 'hardware', label: 'Boards & IDs' },
  { id: 'console', label: 'Console' },
] as const
type TabId = (typeof tabs)[number]['id']

function readTab(): TabId {
  const h = location.hash.slice(1)
  return (tabs.find((t) => t.id === h)?.id ?? 'tools') as TabId
}
const tab = ref<TabId>(readTab())
watch(tab, (t) => history.replaceState(null, '', '#' + t))
window.addEventListener('hashchange', () => (tab.value = readTab()))

const klippyClass = computed(() => (state.klippy === 'ready' ? 'ok' : state.klippy === 'startup' ? 'warn' : 'err'))
const tcClass = computed(() => ({ ready: 'ok', changing: 'info', initializing: 'info', error: 'err' })[tc.value.status as string] ?? 'warn')
const qgl = computed(() => status.value.quad_gantry_level?.applied)
</script>

<template>
  <header class="top">
    <div class="row brand">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="var(--accent)" d="M7,2H17V8H19V13H16.5L13,17H11L7.5,13H5V8H7V2M10,22H2V20H10A1,1 0 0,0 11,19V18H13V19A3,3 0 0,1 10,22Z"/></svg>
      <h1>ToolConfig</h1>
      <span class="grow" />
      <button
        class="estop"
        :disabled="state.connection !== 'open' || state.klippy === 'shutdown'"
        title="Emergency stop: halts all motion and heaters immediately (bypasses the command queue). Needs a Firmware restart afterwards."
        @click="emergencyStop"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.27,3L3,8.27V15.73L8.27,21H15.73L21,15.73V8.27L15.73,3M8.41,7L12,10.59L15.59,7L17,8.41L13.41,12L17,15.59L15.59,17L12,13.41L8.41,17L7,15.59L10.59,12L7,8.41" /></svg>
        Emergency stop
      </button>
    </div>
    <div class="row status-pills">
      <span v-if="state.connection !== 'open'" class="pill err"><span class="dot" />Moonraker {{ state.connection }}</span>
      <span v-else class="pill" :class="klippyClass"><span class="dot" />Klipper {{ state.klippy }}</span>
      <span v-if="state.klippy === 'ready'" class="pill" :class="tcClass"><span class="dot" />Changer {{ tc.status ?? '?' }}<template v-if="tc.tool">: {{ String(tc.tool).replace('tool ', '') }}</template></span>
      <span v-if="state.klippy === 'ready'" class="pill" :class="homed === 'xyz' ? 'ok' : 'warn'"><span class="dot" />{{ homed ? 'Homed ' + homed.toUpperCase() : 'Not homed' }}</span>
      <span v-if="state.klippy === 'ready'" class="pill hide-sm" :class="qgl ? 'ok' : 'warn'"><span class="dot" />{{ qgl ? 'QGL done' : 'No QGL' }}</span>
      <span v-if="printState !== 'standby'" class="pill info"><span class="dot" />{{ printState }}</span>
      <span v-if="state.busy" class="pill info"><span class="dot" />Running: {{ state.busy.slice(0, 40) }}</span>
      <template v-if="state.klippy === 'ready'">
        <button :disabled="!!state.busy || isPrinting" title="G28: home all axes (heats the nozzle to probe temperature for Z)" @click="runWithTool('G28', 'Home all')">Home all</button>
        <button :disabled="!!state.busy || isPrinting || homed !== 'xyz'" :title="homed !== 'xyz' ? 'Home first' : 'QUAD_GANTRY_LEVEL, then re-home Z'" @click="runWithTool('QUAD_GANTRY_LEVEL\nG28 Z', 'Quad gantry level')">Quad gantry level</button>
      </template>
      <a class="btn small" href="/">Mainsail</a>
    </div>
  </header>

  <main>
    <div v-if="state.klippy !== 'ready' && state.connection === 'open'" class="callout err">
      <strong>Klipper is {{ state.klippy }}.</strong>
      <pre class="mono klippy-msg">{{ state.klippyMessage }}</pre>
      <button class="primary" @click="firmwareRestart">Firmware restart</button>
    </div>

    <RecoveryBanner />
    <ToolRequiredDialog />
    <PrepBar v-if="tab === 'tools' || tab === 'dock'" />

    <div v-if="state.pendingRestart.length" class="callout warn row">
      <div class="grow">
        <strong>Saved, but these changes need a Klipper restart:</strong>
        {{ state.pendingRestart.join(', ') }}.
        <span class="muted">Restarting loses homing and QGL.</span>
      </div>
      <button @click="state.pendingRestart = []">Later</button>
      <button class="primary" @click="firmwareRestart">Restart Klipper now</button>
    </div>

    <nav class="tabs">
      <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
    </nav>

    <ToolsView v-if="tab === 'tools'" @go="(t: TabId) => (tab = t)" />
    <DockView v-else-if="tab === 'dock'" />
    <SlicerView v-else-if="tab === 'slicer'" />
    <HardwareView v-else-if="tab === 'hardware'" />
    <LogPanel v-else-if="tab === 'console'" :tall="true" />
  </main>
</template>

<style scoped>
.top { position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.brand { flex: 1 1 auto; min-width: 0; }
.brand h1 { font-size: 17px; }
.estop { display: inline-flex; align-items: center; gap: 6px; background: #d32f2f; border-color: #b71c1c; color: #fff; font-weight: 700; padding: 7px 14px; letter-spacing: .02em; }
.estop:hover:not(:disabled) { background: #b71c1c; border-color: #7f0000; }
.status-pills { justify-content: flex-end; }
main { max-width: 1400px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.klippy-msg { white-space: pre-wrap; margin: 6px 0 10px; }
</style>
