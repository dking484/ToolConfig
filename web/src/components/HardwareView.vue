<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { configIndex, isPrinting, mcus, mr, recordChange, state, tools } from '../store'
import ProbeLive from './ProbeLive.vue'

interface Serial { device_path: string; path_by_id?: string; manufacturer?: string; product?: string; serial_number?: string; device_name?: string }
interface Usb { vendor_id: string; product_id: string; manufacturer: string | null; product: string | null; serial: string | null; description: string | null; usb_location: string }

const can = ref<string[] | null>(null)
const serials = ref<Serial[]>([])
const usb = ref<Usb[]>([])
const iface = ref('can0')
const error = ref('')
const scanning = ref(false)

async function scan() {
  error.value = ''
  scanning.value = true
  try {
    const [c, s, u] = await Promise.allSettled([
      mr.call('machine.peripherals.canbus', { interface: iface.value }, 15000),
      mr.call('machine.peripherals.serial'),
      mr.call('machine.peripherals.usb'),
    ])
    can.value = c.status === 'fulfilled' ? (c.value.can_uuids ?? []).map((x: any) => x.uuid) : []
    if (c.status === 'rejected') error.value = 'CAN scan: ' + c.reason.message
    serials.value = s.status === 'fulfilled' ? s.value.serial_devices ?? [] : []
    usb.value = u.status === 'fulfilled' ? (u.value.usb_devices ?? []).filter((d: Usb) => d.manufacturer && !/Linux/.test(d.manufacturer)) : []
  } finally {
    scanning.value = false
  }
}
onMounted(() => {
  if (state.connection === 'open') scan()
})
// Opened before Moonraker's socket was up (e.g. a reload on this tab)
watch(
  () => state.connection,
  (c) => {
    if (c === 'open') scan()
  },
)

const toolFor = (mcu: string) => tools.value.filter((t) => t.mcu?.name === mcu).map((t) => t.label).join(', ')

// ---- assign an unassigned CAN board to a tool (e.g. after replacing one) ----
// Read from the config files, not Klipper's status: after a board swap
// Klipper can't connect to the old board and doesn't start at all.
interface BoardSlot {
  mcu: string // "EBBT4"
  tool: string // "T4", or '' when no [tool] shares its file
  uuid: string | null
  usb: boolean
  status: 'connected' | 'offline' | 'unknown'
}
const slots = ref<BoardSlot[]>([])
const picked = ref('')
const target = ref<string | null>(null) // mcu name
const assignMsg = ref('')
const assigning = ref(false)
const loadingSlots = ref(false)

function boardStatus(mcu: string): BoardSlot['status'] {
  const m = mcus.value.find((x) => x.name === mcu)
  if (state.klippy === 'ready' && m) return m.connected ? 'connected' : 'offline'
  const failed = state.klippyMessage.match(/mcu '([^']+)': Unable to connect/)
  return failed && failed[1] === mcu ? 'offline' : 'unknown'
}

async function loadSlots() {
  await configIndex.load()
  const byName = new Map<string, BoardSlot>()
  for (const f of configIndex.files) {
    for (const s of f.sections) {
      const m = s.name.match(/^mcu\s+(\S+)$/i)
      if (!m) continue
      const tool = f.sections.find((x) => /^tool\s+/i.test(x.name))?.name.replace(/^tool\s+/i, '')
      const prev = byName.get(m[1])
      byName.set(m[1], {
        mcu: m[1],
        tool: tool ?? tools.value.find((t) => t.mcu?.name === m[1])?.label ?? prev?.tool ?? '',
        uuid: s.options.get('canbus_uuid')?.value ?? prev?.uuid ?? null,
        usb: s.options.has('serial') || !!prev?.usb,
        status: boardStatus(m[1]),
      })
    }
  }
  slots.value = [...byName.values()]
}

async function pick(uuid: string) {
  picked.value = picked.value === uuid ? '' : uuid
  assignMsg.value = ''
  if (!picked.value) return
  loadingSlots.value = true
  try {
    await loadSlots()
  } catch (e: any) {
    assignMsg.value = '!! Could not read the config files: ' + e.message
  } finally {
    loadingSlots.value = false
  }
  // A replaced board leaves its tool's old board offline: suggest that one
  target.value = slots.value.find((s) => s.status === 'offline')?.mcu ?? null
}

async function assign() {
  const slot = slots.value.find((s) => s.mcu === target.value)
  const uuid = picked.value
  if (!slot || !uuid) return
  const section = `mcu ${slot.mcu}`
  const who = slot.tool || slot.mcu
  assignMsg.value = ''
  assigning.value = true
  try {
    await configIndex.load()
    const loc = configIndex.locate(section, 'canbus_uuid')
    if (!loc) throw new Error(`[${section}] is not in any config file`)
    if (!loc.section.options.has('canbus_uuid') && loc.section.options.has('serial'))
      throw new Error(`${who}'s board is wired over USB (serial:). Edit the tool to switch it to CAN.`)
    if (configIndex.autosaveValue(section, 'canbus_uuid') !== undefined)
      throw new Error(`[${section}] canbus_uuid is set in printer.cfg's SAVE_CONFIG block, which would override the tool file. Remove it there first.`)
    const old = slot.uuid ? `${slot.uuid}${slot.status === 'unknown' ? '' : ` (${slot.status})`}` : 'no CAN board'
    if (
      !confirm(
        `Assign CAN board ${uuid} to ${who} ([${section}])?\n\n${who} uses ${old} now.\nThe change is saved to ${loc.file.path} (backup in toolconfig-backups/, Undo available). Klipper needs a restart afterwards, which loses homing.`,
      )
    )
      return
    const before = loc.file.text
    await configIndex.write([{ section, key: 'canbus_uuid', value: uuid }])
    const label = `${who} board ${uuid}`
    recordChange({ kind: 'edit', path: loc.file.path, backupText: before, label, time: Date.now() })
    if (!state.pendingRestart.includes(label)) state.pendingRestart.push(label)
    assignMsg.value = `Saved: ${who} now uses ${uuid}. Restart Klipper (Firmware restart) to connect to it.`
    picked.value = ''
  } catch (e: any) {
    assignMsg.value = '!! ' + e.message
  } finally {
    assigning.value = false
  }
}
</script>

<template>
  <section class="stack">
    <ProbeLive />
    <div class="panel">
      <header class="panel-head"><h2 class="grow">Boards Klipper is using</h2></header>
      <div class="panel-body">
        <table class="list">
          <thead><tr><th>Name</th><th>Used by</th><th>Connection</th><th>Chip</th><th>Firmware</th><th>Status</th></tr></thead>
          <tbody>
            <tr v-for="m in mcus" :key="m.name">
              <td class="mono">{{ m.name }}</td>
              <td>{{ toolFor(m.name) || (m.name === 'mcu' ? 'main board' : '-') }}</td>
              <td class="mono">{{ m.canbusUuid ? 'CAN ' + m.canbusUuid : m.serial ? m.serial.replace('/dev/serial/by-id/', 'USB ') : '-' }}</td>
              <td>{{ m.mcuType ?? '-' }}</td>
              <td class="mono">{{ m.version ?? '-' }}</td>
              <td><span class="pill" :class="m.connected ? 'ok' : 'err'"><span class="dot" />{{ m.connected ? 'connected' : 'offline' }}</span></td>
            </tr>
          </tbody>
        </table>
        <p class="muted small">Each tool board is identified by its <b>CAN UUID</b> (CAN bus boards, like EBB36/SB2209 over a U2C or a CAN-bridge mainboard) or by its <b>USB serial path</b> (<code>/dev/serial/by-id/usb-Klipper_…</code>) when it's wired over USB. Edit a tool to change which board it uses.</p>
      </div>
    </div>

    <div class="panel">
      <header class="panel-head">
        <h2 class="grow">Find new boards</h2>
        <input v-model="iface" class="mono" style="width: 80px" title="CAN interface" />
        <button class="blue" :disabled="scanning" @click="scan">{{ scanning ? 'Scanning…' : 'Scan' }}</button>
      </header>
      <div class="panel-body stack">
        <div v-if="error" class="callout warn">{{ error }}</div>
        <div>
          <h3>Unassigned CAN boards on {{ iface }}</h3>
          <p class="muted small">Only boards that are not yet claimed by Klipper answer this query (new boards, or boards in Katapult). Boards Klipper is already using are listed above.</p>
          <div class="row">
            <span v-if="can && !can.length" class="muted">None found.</span>
            <button v-for="u in can" :key="u" class="uuid mono" :class="{ on: picked === u }" title="Assign this board to a tool" @click="pick(u)">{{ u }}</button>
          </div>
          <p v-if="can && can.length && !picked" class="muted small">Click a board to assign it to a tool, e.g. after replacing that tool's board.</p>
          <div v-if="picked" class="assign row">
            <span>Assign <code>{{ picked }}</code> to</span>
            <select v-model="target" :disabled="loadingSlots">
              <option :value="null" disabled>{{ loadingSlots ? 'Reading config…' : 'choose a tool…' }}</option>
              <option v-for="s in slots" :key="s.mcu" :value="s.mcu">
                {{ s.tool ? `${s.tool} · ` : '' }}{{ s.mcu }} · {{ s.uuid ?? (s.usb ? 'USB' : 'no ID') }}{{ s.status === 'offline' ? ' · NOT CONNECTING' : s.status === 'connected' ? ' · connected' : '' }}
              </option>
            </select>
            <button class="primary" :disabled="target === null || assigning || isPrinting" :title="isPrinting ? 'Not during a print' : ''" @click="assign">
              {{ assigning ? 'Saving…' : 'Assign' }}
            </button>
            <button class="ghost" @click="picked = ''">Cancel</button>
          </div>
          <p v-if="assignMsg" class="small" :class="assignMsg.startsWith('!!') ? 'err-text' : ''">{{ assignMsg.replace(/^!! /, '') }}</p>
        </div>
        <div>
          <h3>USB serial devices</h3>
          <table v-if="serials.length" class="list">
            <tbody>
              <tr v-for="s in serials" :key="s.device_path"><td class="mono">{{ s.path_by_id ?? s.device_path }}</td><td>{{ s.product ?? s.device_name }}</td></tr>
            </tbody>
          </table>
          <p v-else class="muted">None.</p>
        </div>
        <div>
          <h3>USB devices</h3>
          <table class="list">
            <tbody>
              <tr v-for="d in usb" :key="d.usb_location"><td class="mono">{{ d.vendor_id }}:{{ d.product_id }}</td><td>{{ d.manufacturer }} {{ d.product }}</td><td class="mono muted">{{ d.serial }}</td><td class="muted">{{ d.description }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
p { margin: 6px 0; }
.small { font-size: 12.5px; }
.uuid { padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.uuid.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--panel)); }
.assign { margin-top: 8px; gap: 8px; flex-wrap: wrap; align-items: center; }
.err-text { color: var(--err); }
h3 { margin-bottom: 4px; }
</style>
