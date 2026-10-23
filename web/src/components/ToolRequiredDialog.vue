<script setup lang="ts">
import { computed, ref } from 'vue'
import { detectTools, homed, run, toolPrompt, tools, tryRun } from '../store'

const busy = ref(false)
const msg = ref('')
const p = computed(() => toolPrompt.value)
const docked = computed(() => tools.value.filter((t) => !p.value?.open.includes(t.number) && t.warnings.length === 0))
const canPickUp = computed(() => homed.value === 'xyz' && p.value?.reason === 'none')

function close() {
  toolPrompt.value = null
  msg.value = ''
}

async function checkAgain() {
  if (!p.value) return
  busy.value = true
  msg.value = ''
  try {
    const open = await detectTools()
    if (open.length === 1) {
      const { script, label } = p.value
      close()
      await tryRun(script, label)
      return
    }
    toolPrompt.value = { ...p.value, reason: open.length ? 'multiple' : 'none', open }
    msg.value = open.length ? `Still more than one: ${open.map((n) => 'T' + n).join(', ')}.` : 'Still no tool detected on the gantry.'
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = false
  }
}

async function pickUp(n: number) {
  if (!p.value) return
  busy.value = true
  msg.value = ''
  const { script, label } = p.value
  try {
    // Re-detect + forget any stale "active" tool, then pick up for real
    await run(`TC_RETRY_PICKUP T=${n}`, `Pick up T${n}`)
    const open = await detectTools()
    if (!open.includes(n)) throw new Error(`T${n} was not detected after the pickup. See the banner above.`)
    close()
    await tryRun(script, label)
  } catch (e: any) {
    msg.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="p" class="modal-back" @click.self="close">
    <div class="panel modal small">
      <header class="panel-head"><h2 class="grow">{{ p.label }}: {{ p.reason === 'none' ? 'no tool on the gantry' : "can't tell which tool is on the gantry" }}</h2></header>
      <div class="panel-body stack">
        <template v-if="p.reason === 'none'">
          <p><b>There is no tool on the gantry to perform this action.</b> Please place a tool on the gantry{{ canPickUp ? ', or would you like us to pick one up?' : '.' }}</p>
          <p v-if="!canPickUp" class="muted">
            We can't pick one up for you right now: picking up a tool needs Z homed, and homing Z uses the probe of the tool on the gantry.
            Put a tool on the gantry by hand (fully seated), then check again.
          </p>
        </template>
        <template v-else>
          <p><b>More than one tool probe reads "on the gantry": {{ p.open.map((n) => 'T' + n).join(', ') }}.</b></p>
          <p class="muted">Usually a tool is sitting crooked or not fully seated in its dock, so its probe isn't pressed. Seat it properly, then check again.</p>
        </template>

        <div v-if="canPickUp && docked.length" class="row">
          <span class="muted">Pick up:</span>
          <button v-for="t in docked" :key="t.number" class="blue" :disabled="busy" @click="pickUp(t.number)">{{ t.label }}</button>
        </div>
        <div v-if="msg" class="callout warn">{{ msg }}</div>
        <div class="row">
          <span class="grow" />
          <button :disabled="busy" @click="close">Cancel</button>
          <button class="primary" :disabled="busy" @click="checkAgain">{{ busy ? 'Checking…' : "I've placed a tool – check again" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.small { width: min(560px, 100%); }
p { margin: 0; }
</style>
