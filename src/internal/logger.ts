import { getNativeModule } from './nativeModule'

let enabled = false

/**
 * Toggles verbose logging in both JS and the native layer.
 *
 * Off by default: a storage library logging every read on a hot path is noise,
 * and cloud payloads can contain user data that should not land in a device log.
 */
export function setLogsEnabled(value: boolean): void {
  enabled = value
  getNativeModule()?.setLogsEnabled(value)
}

export function isLogsEnabled(): boolean {
  return enabled
}

export function log(...args: unknown[]): void {
  if (!enabled) return
  console.warn('[RNCloudSync]', ...args)
}
