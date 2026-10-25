<script setup lang="ts">
// Home Assistant style editor for one tool's config file: a visual editor
// (a card per section, labelled fields) and a code editor (the raw file).
// Both edit the same text; switching views never loses anything.
import { computed, onMounted, ref } from 'vue'
import { normalizeSection, parseCfg, removeOption, setOption } from '../lib/cfgEdit'
import { diffCfg, kindOf, liveCommand, type FieldDef } from '../lib/toolSchema'
import { configIndex, DISABLED_DIR, isPrinting, moveConfigFile, mr, recordChange, state, tryRun } from '../store'

const props = defineProps<{
  mode: 'edit' | 'create'
  path: string // file path relative to the config root
  title: string
  initialText?: string // create mode: generated file
  toolNumber: number
  extruder: string | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const view = ref<'visual' | 'code'>('visual')
const original = ref('')
const text = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const editable = ref(true)
const showChanges = ref(false)
const createDisabled = ref(false)
const overrides = ref<Record<string, string>>({}) // "section|key" -> where it is overridden

onMounted(async () => {
  try {
    if (props.mode === 'create') {
      original.value = ''
      text.value = props.initialText ?? ''
      createDisabled.value = /SET_ME/.test(text.value)
    } else {
      const t = await mr.getText('config', props.path)
      original.value = t
      text.value = t
      await configIndex.ensureFresh()
      editable.value = !!configIndex.files.find((f) => f.path === props.path)?.editable
      // keys this file sets but a later file (or SAVE_CONFIG) overrides
      for (const s of parseCfg(t)) {
        for (const key of s.options.keys()) {
          const loc = configIndex.locate(s.name, key)
          const auto = configIndex.autosaveValue(s.name, key)
          if (auto !== undefined) overrides.value[`${normalizeSection(s.name)}|${key}`] = `SAVE_CONFIG (${auto})`
          else if (loc && loc.defined && loc.file.path !== props.path) overrides.value[`${normalizeSection(s.name)}|${key}`] = loc.file.path
        }
      }
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

// ---- visual model, derived from the text every time ----
const ORDER = ['tool', 'extruder', 'mcu', 'probe', 'tmc', 'partfan', 'hotendfan', 'leds', 'accel', 'macro', 'other']
const cards = computed(() =>
  parseCfg(text.value)
    .filter((s) => !s.name.startsWith('include '))
    .map((s) => {
      const kind = kindOf(s.name)
      const known = new Set(kind.fields.map((f) => f.key))
      const extra: FieldDef[] = [...s.options.values()]
        .filter((o) => !known.has(o.key.toLowerCase()))
        .map((o) => ({ key: o.key.toLowerCase(), label: o.key, type: o.value.includes('\n') ? 'code' : 'text' }) as FieldDef)
      return { name: s.name, kind, fields: kind.fields, extra, values: s.options }
    })
    .sort((a, b) => ORDER.indexOf(a.kind.id) - ORDER.indexOf(b.kind.id)),
)
const showUnset = ref(false)

function display(v: string | undefined, f: FieldDef) {
  if (v === undefined) return ''
  if (f.type === 'code') return v.replace(/^\n/, '')
  if (f.quoted) return v.replace(/^['"]|['"]$/g, '')
  return v
}
function setField(section: string, f: FieldDef, raw: string) {
  const v = raw.trim()
  if (v === '') {
    text.value = removeOption(text.value, section, f.key)
    return
  }
  let value = v
  if (f.type === 'code') {
    const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.trimEnd())
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    value = '\n' + lines.join('\n')
  }
  else if (f.quoted) value = `'${v.replace(/^['"]|['"]$/g, '')}'`
  text.value = setOption(text.value, section, f.key, value)
}

// ---- changes + checks ----
const diff = computed(() => diffCfg(original.value, text.value))
const dirty = computed(() => text.value !== original.value)
const restartNeeded = computed(() => props.mode === 'create' || diff.value.structural || diff.value.changes.some((c) => c.apply === 'restart'))
const checks = computed(() => {
  const out: string[] = []
  const secs = parseCfg(text.value)
  const tool = secs.find((s) => /^tool\s/i.test(s.name))
  if (!tool) out.push('There is no [tool …] section in this file.')
  const tn = tool?.options.get('tool_number')?.value
  if (tool && tn !== String(props.toolNumber)) out.push(`tool_number is ${tn ?? 'missing'} but this is T${props.toolNumber}.`)
  for (const s of secs.filter((x) => /^mcu\s/i.test(x.name))) {
    const uuid = s.options.get('canbus_uuid')?.value
    if (uuid !== undefined && !/^[0-9a-f]{12}$/i.test(uuid)) out.push(`[${s.name}] canbus_uuid "${uuid}" is not 12 hex digits${uuid === 'SET_ME' ? ' (board not set yet)' : ''}.`)
    if (uuid === undefined && !s.options.has('serial')) out.push(`[${s.name}] has neither canbus_uuid nor serial.`)
  }
  const nums = ['params_park_x', 'params_park_y', 'params_park_z']
  if (tool && nums.some((k) => tool.options.get(k)?.value === '-1')) out.push('Dock position not set yet (-1): teach it in Dock test & align before using this tool.')
  return out
})
const blocking = computed(() => checks.value.filter((c) => /no \[tool|tool_number is|neither/.test(c)))

function stampName(p: string) {
  return `toolconfig-backups/${p.replace(/\//g, '__')}.${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.bak`
}

async function save() {
  error.value = ''
  saving.value = true
  try {
    if (props.mode === 'create') {
      const name = props.path.split('/').pop()!
      const target = createDisabled.value ? `${DISABLED_DIR}/${name}` : props.path
      const existing = await mr.call('server.files.get_directory', { path: `config/${target.slice(0, target.lastIndexOf('/'))}` }).catch(() => ({ files: [] }))
      if ((existing.files ?? []).some((f: any) => f.filename === name)) throw new Error(`${target} already exists`)
      await mr.upload('config', target, text.value)
      if (!createDisabled.value) {
        recordChange({ kind: 'create', path: target, label: props.title, time: Date.now() })
        if (!state.pendingRestart.includes(props.title)) state.pendingRestart.push(props.title)
      }
    } else {
      const list = diff.value.changes.map((c) => `${c.section} › ${c.key}: ${c.before ?? '(unset)'} → ${c.after ?? '(removed)'}${c.apply === 'live' ? '   [live]' : ''}`).join('\n')
      if (!confirm(`Save ${props.path}?\n\n${list || '(comment/format changes only)'}\n\nA backup goes to config/toolconfig-backups/.`)) return
      await mr.upload('config', stampName(props.path), original.value)
      await mr.upload('config', props.path, text.value)
      recordChange({ kind: 'edit', path: props.path, backupText: original.value, label: props.title, time: Date.now() })
      for (const c of diff.value.changes) {
        const cmd = c.key.startsWith('gcode_') && isPrinting.value ? null : liveCommand(c, props.toolNumber, props.extruder)
        if (cmd) await tryRun(cmd, `Apply ${c.key}`)
      }
      if (restartNeeded.value && !state.pendingRestart.includes(props.title)) state.pendingRestart.push(props.title)
      configIndex.load().catch(() => undefined)
    }
    emit('saved')
    emit('close')
  } catch (e: any) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function disableTool() {
  if (!confirm(`Disable ${props.title}?\n\nIts file moves to config/${DISABLED_DIR}/ (not deleted), so Klipper stops loading it after a restart. You can enable it again from the Tools tab.`)) return
  try {
    const to = `${DISABLED_DIR}/${props.path.split('/').pop()}`
    await moveConfigFile(props.path, to)
    recordChange({ kind: 'disable', from: props.path, to, label: `Disable ${props.title}`, time: Date.now() })
    if (!state.pendingRestart.includes(`disable ${props.title}`)) state.pendingRestart.push(`disable ${props.title}`)
    emit('saved')
    emit('close')
  } catch (e: any) {
    error.value = e.message
  }
}

function closeAsk() {
  if (dirty.value && props.mode === 'edit' && !confirm('Discard your changes?')) return
  emit('close')
}
const lineCount = computed(() => text.value.split('\n').length)
</script>

<template>
  <div class="modal-back" @click.self="closeAsk">
    <div class="panel modal wide">
      <header class="panel-head head">
        <h2 class="grow">{{ mode === 'create' ? 'New tool' : 'Edit' }} {{ title }} <span class="muted mono small">{{ path }}</span></h2>
        <div class="seg">
          <button :class="{ on: view === 'visual' }" @click="view = 'visual'">Visual editor</button>
          <button :class="{ on: view === 'code' }" @click="view = 'code'">Code editor</button>
        </div>
        <button class="ghost" @click="closeAsk">Close</button>
      </header>

      <div class="panel-body stack">
        <p v-if="loading" class="muted">Reading your config files…</p>
        <div v-if="!editable" class="callout warn">This file is read-only here (it's a symlink into another repo). View only.</div>

        <!-- ===================== VISUAL ===================== -->
        <template v-if="!loading && view === 'visual'">
          <div class="row">
            <span class="muted small grow">A card per section of the file. Changes update the file text; switch to the code editor at any time to see or edit it directly.</span>
            <label class="row small muted"><input v-model="showUnset" type="checkbox" /> show unset fields</label>
          </div>
          <section v-for="c in cards" :key="c.name" class="card-sec">
            <header class="row"><span class="tag">{{ c.kind.icon }}</span><h3 class="grow">{{ c.kind.title(c.name) }}</h3><code class="muted small">[{{ c.name }}]</code></header>
            <div class="fields">
              <template v-for="f in [...c.fields, ...c.extra]" :key="f.key">
                <label v-if="showUnset || c.values.has(f.key)" class="field" :class="{ code: f.type === 'code' }">
                  <span>
                    {{ f.label }}
                    <span v-if="f.apply === 'live'" class="badge live" title="Applied immediately when saved, no restart">live</span>
                    <span v-if="overrides[`${c.name.toLowerCase()}|${f.key}`]" class="badge warn" :title="`A later file overrides this: ${overrides[`${c.name.toLowerCase()}|${f.key}`]}`">overridden</span>
                  </span>
                  <textarea v-if="f.type === 'code'" :value="display(c.values.get(f.key)?.value, f)" rows="3" :disabled="!editable" @change="setField(c.name, f, ($event.target as HTMLTextAreaElement).value)" />
                  <select v-else-if="f.type === 'select'" :value="display(c.values.get(f.key)?.value, f)" :disabled="!editable" @change="setField(c.name, f, ($event.target as HTMLSelectElement).value)">
                    <option value="">(not set)</option>
                    <option v-if="c.values.has(f.key) && !f.options?.includes(display(c.values.get(f.key)?.value, f))" :value="display(c.values.get(f.key)?.value, f)">{{ display(c.values.get(f.key)?.value, f) }}</option>
                    <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
                  </select>
                  <select v-else-if="f.type === 'bool'" :value="display(c.values.get(f.key)?.value, f)" :disabled="!editable" @change="setField(c.name, f, ($event.target as HTMLSelectElement).value)">
                    <option value="">(not set)</option>
                    <option value="True">True</option>
                    <option value="False">False</option>
                  </select>
                  <input v-else :value="display(c.values.get(f.key)?.value, f)" :class="{ mono: f.type === 'pin' }" :inputmode="f.type === 'number' ? 'decimal' : 'text'" :placeholder="c.values.has(f.key) ? '' : 'not set (default)'" :title="f.help" :disabled="!editable" @change="setField(c.name, f, ($event.target as HTMLInputElement).value)" />
                  <small v-if="f.help" class="help">{{ f.help }}</small>
                </label>
              </template>
            </div>
          </section>
        </template>

        <!-- ===================== CODE ===================== -->
        <template v-if="!loading && view === 'code'">
          <textarea v-model="text" class="code-area" spellcheck="false" :rows="Math.min(40, Math.max(16, lineCount))" :readonly="!editable" />
          <p class="muted small">{{ lineCount }} lines. Switch back to the visual editor and your edits show up in the cards.</p>
        </template>

        <!-- ===================== CHECKS + SAVE ===================== -->
        <ul v-if="checks.length" class="checks"><li v-for="c in checks" :key="c">{{ c }}</li></ul>
        <div v-if="mode === 'edit' && dirty" class="changes">
          <button class="ghost small" @click="showChanges = !showChanges">{{ showChanges ? '▾' : '▸' }} {{ diff.changes.length }} change(s){{ restartNeeded ? ' · needs a Klipper restart' : ' · all applied live' }}</button>
          <ul v-if="showChanges" class="mono small">
            <li v-for="c in diff.changes" :key="c.section + c.key">[{{ c.section }}] {{ c.key }}: {{ c.before ?? '(unset)' }} → {{ c.after ?? '(removed)' }} <b :class="c.apply">{{ c.apply }}</b></li>
          </ul>
        </div>
        <label v-if="mode === 'create'" class="row small"><input v-model="createDisabled" type="checkbox" /> Create it disabled (in {{ DISABLED_DIR }}/). Use this if its board isn't connected yet, so Klipper still starts.</label>
        <div v-if="error" class="callout err">{{ error }}</div>

        <div class="row">
          <button v-if="mode === 'edit' && editable" class="danger ghost" :disabled="saving" @click="disableTool">Disable tool…</button>
          <span class="grow" />
          <button v-if="mode === 'edit'" :disabled="!dirty || saving" @click="text = original">Revert</button>
          <button @click="closeAsk">Cancel</button>
          <button class="primary" :disabled="saving || !editable || (mode === 'edit' && !dirty) || blocking.length > 0" @click="save">
            {{ saving ? 'Saving…' : mode === 'create' ? (createDisabled ? 'Create (disabled)' : 'Create tool') : 'Save' }}
          </button>
        </div>
        <p class="muted small">
          {{ mode === 'create' ? 'Creating a tool needs a Klipper restart (re-home afterwards).' : 'Dock position, offsets, input shaper, pressure advance and rotation distance apply immediately; everything else needs a Klipper restart.' }}
          If Klipper won't start afterwards, the page offers to undo the last change.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wide { width: min(1100px, 100%); }
.head { flex-wrap: wrap; }
.small { font-size: 12.5px; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg button { border: none; border-radius: 0; background: transparent; }
.seg button.on { background: var(--accent-2); color: #fff; }
.card-sec { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px 12px; display: grid; gap: 10px; }
.card-sec h3 { font-size: 14px; }
.tag { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; }
.fields { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.field.code { grid-column: 1 / -1; }
.field textarea { font-family: var(--mono); }
.help { font-size: 11px; color: var(--muted); }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; margin-left: 4px; }
.badge.live { color: var(--ok); }
.badge.warn { color: var(--warn); }
.code-area { width: 100%; font-family: var(--mono); font-size: 12.5px; line-height: 1.45; tab-size: 4; white-space: pre; }
.checks { margin: 0; padding-left: 20px; color: var(--warn); font-size: 13px; }
.changes ul { margin: 6px 0 0; padding-left: 20px; }
.changes b.live { color: var(--ok); font-weight: 500; }
.changes b.restart { color: var(--warn); font-weight: 500; }
</style>
