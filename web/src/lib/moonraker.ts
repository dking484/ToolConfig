// Minimal Moonraker JSON-RPC client (framework-agnostic).
// One websocket, auto-reconnect, object subscriptions and file helpers.

export type Status = Record<string, Record<string, any>>

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }
type Listener<T> = (payload: T) => void

export interface ClientEvents {
  connection: 'connecting' | 'open' | 'closed'
  status: { diff: Status; full: Status }
  gcode: string
  klippy: 'ready' | 'shutdown' | 'disconnected' | 'startup'
}

export class MoonrakerError extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export class Moonraker {
  readonly baseUrl: string
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners: Partial<Record<keyof ClientEvents, Set<Listener<any>>>> = {}
  private subscribed: Record<string, string[] | null> = {}
  private reconnectTimer: number | undefined
  status: Status = {}

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl
  }

  on<K extends keyof ClientEvents>(event: K, fn: Listener<ClientEvents[K]>): () => void {
    const set = (this.listeners[event] ??= new Set())
    set.add(fn)
    return () => set.delete(fn)
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]) {
    this.listeners[event]?.forEach((fn) => fn(payload))
  }

  connect() {
    clearTimeout(this.reconnectTimer)
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = this.baseUrl
      ? this.baseUrl.replace(/^http/, 'ws') + '/websocket'
      : `${proto}//${location.host}/websocket`
    this.emit('connection', 'connecting')
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = async () => {
      this.emit('connection', 'open')
      try {
        await this.call('server.connection.identify', {
          client_name: 'klipper-toolchanger-ui',
          version: '0.1.0',
          type: 'web',
          url: 'https://github.com/',
        })
      } catch {
        /* older Moonraker: identify is optional */
      }
      if (Object.keys(this.subscribed).length) await this.resubscribe()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onclose = () => {
      this.pending.forEach((p) => p.reject(new Error('Connection closed')))
      this.pending.clear()
      this.emit('connection', 'closed')
      this.reconnectTimer = window.setTimeout(() => this.connect(), 2000)
    }
  }

  private onMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new MoonrakerError(msg.error.message, msg.error.code))
      else p.resolve(msg.result)
      return
    }
    switch (msg.method) {
      case 'notify_status_update':
        this.merge(msg.params[0])
        break
      case 'notify_gcode_response':
        this.emit('gcode', msg.params[0])
        break
      case 'notify_klippy_ready':
        this.emit('klippy', 'ready')
        this.resubscribe()
        break
      case 'notify_klippy_shutdown':
        this.emit('klippy', 'shutdown')
        break
      case 'notify_klippy_disconnected':
        this.emit('klippy', 'disconnected')
        break
    }
  }

  private merge(diff: Status) {
    for (const [obj, fields] of Object.entries(diff)) {
      this.status[obj] = { ...(this.status[obj] ?? {}), ...fields }
    }
    this.emit('status', { diff, full: this.status })
  }

  call<T = any>(method: string, params?: Record<string, any>, timeoutMs = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to Moonraker'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }))
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
        }, timeoutMs)
      }
    })
  }

  async subscribe(objects: Record<string, string[] | null>) {
    Object.assign(this.subscribed, objects)
    const res = await this.call('printer.objects.subscribe', { objects: this.subscribed })
    this.status = {}
    this.merge(res.status)
    return res.status as Status
  }

  private async resubscribe() {
    try {
      await this.subscribe({})
    } catch {
      /* klippy not ready yet; notify_klippy_ready will retry */
    }
  }

  /** Run gcode; resolves when Klipper finishes it, rejects with Klipper's error text. */
  gcode(script: string) {
    return this.call('printer.gcode.script', { script })
  }

  // ---- HTTP helpers (same origin as the websocket) ----
  private url(path: string) {
    return this.baseUrl + path
  }

  async getText(root: string, path: string): Promise<string> {
    const r = await fetch(this.url(`/server/files/${root}/${encodePath(path)}`), { cache: 'no-store' })
    if (!r.ok) throw new Error(`Download ${root}/${path} failed: ${r.status}`)
    return r.text()
  }

  /** Fetch only part of a (possibly huge) file. Negative start = from the end. */
  async getRange(root: string, path: string, start: number, length: number): Promise<string> {
    const range = start < 0 ? `bytes=${start}` : `bytes=${start}-${start + length - 1}`
    const r = await fetch(this.url(`/server/files/${root}/${encodePath(path)}`), {
      headers: { Range: range },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`Download ${root}/${path} failed: ${r.status}`)
    return r.text()
  }

  async stream(root: string, path: string, onChunk: (text: string, loaded: number) => void, signal?: AbortSignal) {
    const r = await fetch(this.url(`/server/files/${root}/${encodePath(path)}`), { signal, cache: 'no-store' })
    if (!r.ok || !r.body) throw new Error(`Download ${root}/${path} failed: ${r.status}`)
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      onChunk(decoder.decode(value, { stream: true }), loaded)
    }
    onChunk(decoder.decode(), loaded)
  }

  async upload(root: string, path: string, content: string) {
    const slash = path.lastIndexOf('/')
    const dir = slash >= 0 ? path.slice(0, slash) : ''
    const name = slash >= 0 ? path.slice(slash + 1) : path
    const form = new FormData()
    form.append('root', root)
    if (dir) form.append('path', dir)
    form.append('file', new Blob([content], { type: 'text/plain' }), name)
    const r = await fetch(this.url('/server/files/upload'), { method: 'POST', body: form })
    if (!r.ok) throw new Error(`Upload ${root}/${path} failed: ${r.status} ${await r.text()}`)
    return r.json()
  }
}

function encodePath(p: string) {
  return p.split('/').map(encodeURIComponent).join('/')
}
