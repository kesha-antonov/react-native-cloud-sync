import { Platform } from 'react-native'

import {
  getNativeModule,
  requireNativeModule,
  subscribeNativeEvent,
} from '../internal/nativeModule'
import { normalizeError, unsupportedPlatform } from '../errors'
import type {
  AccountChangeEvent,
  AccountStatus,
  CloudProvider,
  RemoteChangeEvent,
  Unsubscribe,
} from '../types'
import type {
  AccountChangeNativeEvent,
  RemoteChangeNativeEvent,
} from '../specs/NativeRNCloudSync'
import { toAccountStatus, toChangeReason } from '../internal/enums'

const NAME = 'icloudKV' as const

/**
 * `NSUbiquitousKeyValueStore`.
 *
 * Apple-only by construction: there is no browser or Android API for the iCloud
 * key-value store, and no REST surface either. Reach for `cloudKit` when you
 * need the same data on Android or web.
 *
 * Hard limits, enforced here rather than left to fail silently at the OS layer:
 * 1 MB total, 1 MB per key, 1024 keys.
 */
const APPLE_PLATFORMS = ['ios', 'macos'] as const

function assertPlatform(): void {
  if (!(APPLE_PLATFORMS as readonly string[]).includes(Platform.OS))
    throw unsupportedPlatform(
      NAME,
      `NSUbiquitousKeyValueStore exists only on Apple platforms (got '${Platform.OS}'). `
      + `Use the cloudKit provider for cross-platform access to the same account.`
    )
}

export const icloudKV: CloudProvider = {
  name: NAME,

  isAvailable: async () => {
    if (!(APPLE_PLATFORMS as readonly string[]).includes(Platform.OS)) return false
    const m = getNativeModule()
    if (m == null) return false
    try {
      return await m.isAvailable()
    }
    catch {
      return false
    }
  },

  getAccountStatus: async (): Promise<AccountStatus> => {
    assertPlatform()
    try {
      return toAccountStatus(await requireNativeModule().getAccountStatus())
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  getItem: async (key: string) => {
    assertPlatform()
    try {
      return await requireNativeModule().kvGetItem(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  setItem: async (key: string, value: string) => {
    assertPlatform()
    try {
      await requireNativeModule().kvSetItem(key, value)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  removeItem: async (key: string) => {
    assertPlatform()
    try {
      await requireNativeModule().kvRemoveItem(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  getAllKeys: async () => {
    assertPlatform()
    try {
      return await requireNativeModule().kvGetAllKeys()
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  onRemoteChange: (listener: (e: RemoteChangeEvent) => void): Unsubscribe =>
    subscribeNativeEvent<RemoteChangeNativeEvent>(
      'onRemoteChange',
      'remoteChange',
      (e) => {
        if (e.provider !== NAME) return
        listener({ keys: e.keys, reason: toChangeReason(e.reason), provider: NAME })
      }
    ),

  onAccountChange: (listener: (e: AccountChangeEvent) => void): Unsubscribe =>
    subscribeNativeEvent<AccountChangeNativeEvent>(
      'onAccountChange',
      'accountChange',
      (e) => {
        listener({
          status: toAccountStatus(e.status),
          identityChanged: e.identityChanged,
          provider: NAME,
        })
      }
    ),
}

/**
 * Flushes pending changes to disk.
 *
 * Exposed separately because it is not part of the generic {@link CloudProvider}
 * contract - and because its semantics are routinely misread. It maps to
 * `NSUbiquitousKeyValueStore.synchronize()`, which schedules an upload; it does
 * not wait for or confirm one. A resolved `sync()` means "queued", never
 * "stored in iCloud".
 */
export async function sync(): Promise<boolean> {
  assertPlatform()
  try {
    return await requireNativeModule().kvSync()
  }
  catch (e) {
    throw normalizeError(e, NAME)
  }
}
