<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { mcus, mr, tools } from '../store'

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
onMounted(scan)

const toolFor = (mcu: string) => tools.value.filter((t) => t.mcu?.name === mcu).map((t) => t.label).join(', ')
</script>

<template>
  <section class="stack">
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
            <code v-for="u in can" :key="u" class="uuid">{{ u }}</code>
          </div>
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
.uuid { padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; }
h3 { margin-bottom: 4px; }
</style>
