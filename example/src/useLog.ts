import { useCallback, useRef, useState } from 'react'

import { isCloudStorageError } from '@kesha-antonov/react-native-cloud-storage'

import type { LogEntry } from './components/LogView'

const MAX_ENTRIES = 200

function stamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const nextId = useRef(0)

  const push = useCallback((tone: LogEntry['tone'], text: string) => {
    setEntries((prev) => {
      const entry: LogEntry = { id: nextId.current++, at: stamp(), tone, text }
      return [...prev, entry].slice(-MAX_ENTRIES)
    })
  }, [])

  const info = useCallback((t: string) => push('info', t), [push])
  const ok = useCallback((t: string) => push('ok', t), [push])
  const event = useCallback((t: string) => push('event', t), [push])

  /**
   * Logs a failure with its typed code.
   *
   * The whole reason this library exists is that `catch { return null }` throws
   * away the difference between "not signed in", "offline" and "no such key".
   * The demo shows the code, so that difference is visible on screen.
   */
  const fail = useCallback((label: string, e: unknown) => {
    if (isCloudStorageError(e)) {
      const extra: string[] = []
      if (e.retryAfterMs != null) extra.push(`retryAfterMs=${e.retryAfterMs}`)
      if (e.limitBytes != null) extra.push(`limit=${e.limitBytes}`)
      if (e.actualBytes != null) extra.push(`actual=${e.actualBytes}`)
      const suffix = extra.length > 0 ? ` (${extra.join(', ')})` : ''
      push('error', `${label} -> ${e.code}${suffix}`)
      return
    }
    push('error', `${label} -> ${String(e)}`)
  }, [push])

  const clear = useCallback(() => setEntries([]), [])

  return { entries, info, ok, event, fail, clear }
}
