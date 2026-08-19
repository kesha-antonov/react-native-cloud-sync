import { Platform } from 'react-native'

/**
 * A short, stable-per-launch device identifier.
 *
 * Deliberately not persisted: the demo wants to tell panes apart within a
 * recording session, and re-launching a simulator to get a fresh label is
 * useful rather than a problem.
 */
const id = Math.random().toString(36).slice(2, 6).toUpperCase()

export function deviceId(): string {
  return id
}

export function deviceLabel(): string {
  const os = Platform.OS
  const pretty = os === 'ios' ? 'iOS' : os === 'android' ? 'Android' : os === 'web' ? 'Web' : os
  return `${pretty} · ${id}`
}
