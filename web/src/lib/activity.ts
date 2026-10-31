// What the printer is doing right now, for the "something is happening" line.

export interface ConsoleLine {
  time: number // ms
  text: string
  kind: 'cmd' | 'resp' | 'error'
}

// Temperature reports ("B:25.0 /0.0 T0:150.6 /150.0 ...") repeat every second while waiting
const TEMP = /\bT\d+:[\d.]+ \/[\d.]+|^B:[\d.]+ \/[\d.]+/

/** The newest console response since `since` (ms) that says something, without the "// " / "echo: " prefix. */
export function latestMessage(log: ConsoleLine[], since: number): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]
    if (l.time < since) break
    if (l.kind === 'cmd' || TEMP.test(l.text)) continue
    const text = l.text.replace(/^(\/\/|echo:)\s*/, '').trim()
    if (text) return text.split('\n')[0]
  }
  return ''
}

export interface Heater {
  label: string
  temp: number | null
  target: number | null
}

/** Heaters still on their way to a target (more than 2 °C off it). */
export function heating(heaters: Heater[]): Heater[] {
  return heaters.filter((h) => h.target != null && h.temp != null && h.target > 0 && Math.abs(h.target - h.temp) > 2)
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}
