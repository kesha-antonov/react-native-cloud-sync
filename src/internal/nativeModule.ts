import { NativeEventEmitter, NativeModules, Platform, TurboModuleRegistry } from 'react-native'

import type { Spec } from '../specs/NativeRNCloudStorage'
import { CloudStorageError, ErrorCode } from '../errors'
import type { Unsubscribe } from '../types'

const MODULE_NAME = 'RNCloudStorage'

const LINKING_ERROR
  = `[RNCloudStorage] The native module doesn't seem to be linked. Make sure you have:\n\n`
    + `  - run 'pod install' (iOS) or rebuilt the app (Android) after installing\n`
    + `  - rebuilt the app after installing, not just restarted Metro\n`
    + `  - not using Expo Go, which cannot load custom native modules\n`

let cached: Spec | null = null
let resolved = false

/**
 * Whether the running app is on the New Architecture.
 *
 * Detected from which registry produced the module rather than from a global
 * flag, because `global.__turboModuleProxy` is not reliable across the RN
 * versions this package supports (0.71 through 0.86+).
 */
let isNewArch = false

/**
 * Resolves the native module lazily.
 *
 * New arch exposes it through TurboModuleRegistry; old arch through the
 * NativeModules proxy. Resolution is deferred rather than done at import time
 * so that merely importing this package on a platform without the native module
 * (web, or Android for the iCloud provider) does not throw at bundle-evaluation
 * time - which is exactly the crash cryptoc had to work around with a
 * `Platform.OS === 'ios' ? requireNativeModule(...) : null` guard.
 */
export function getNativeModule(): Spec | null {
  if (resolved) return cached
  resolved = true

  // TurboModuleRegistry.get is safe on the old architecture too - it simply
  // returns null there rather than throwing (unlike getEnforcing).
  const turbo = TurboModuleRegistry.get<Spec>(MODULE_NAME)
  if (turbo != null) {
    cached = turbo
    isNewArch = true
    return cached
  }

  const legacy = (NativeModules as Record<string, unknown>)[MODULE_NAME]
  if (legacy != null) {
    cached = legacy as Spec
    isNewArch = false
    return cached
  }

  cached = null
  return null
}

/** Like {@link getNativeModule} but throws a diagnostic instead of returning null. */
export function requireNativeModule(): Spec {
  const m = getNativeModule()
  if (m == null)
    throw new CloudStorageError(
      ErrorCode.UNSUPPORTED_PLATFORM,
      Platform.OS === 'web'
        ? '[RNCloudStorage] This provider requires a native module and is not available on web.'
        : LINKING_ERROR
    )

  return m
}

export function hasNativeModule(): boolean {
  return getNativeModule() != null
}

let legacyEmitter: NativeEventEmitter | null = null

function getLegacyEmitter(): NativeEventEmitter {
  if (legacyEmitter == null)
    // The old-architecture module is an RCTEventEmitter, so it is a valid
    // NativeEventEmitter argument. On Android events always travel over
    // RCTDeviceEventEmitter, which NativeEventEmitter also handles.
    legacyEmitter = new NativeEventEmitter(
      (NativeModules as Record<string, never>)[MODULE_NAME]
    )

  return legacyEmitter
}

/**
 * Event names differ per architecture.
 *
 * Codegen's EventEmitter properties must be named `onSomething`, while the old
 * architecture's `supportedEvents` list uses the bare name. Rather than leak
 * that split into every call site, subscribe through this helper.
 * (react-native-background-downloader carries the same `onDownloadBegin` vs
 * `downloadBegin` split for the same reason.)
 */
export function subscribeNativeEvent<T>(
  newArchName: 'onRemoteChange' | 'onAccountChange' | 'onAssetProgress',
  legacyName: 'remoteChange' | 'accountChange' | 'assetProgress',
  listener: (e: T) => void
): Unsubscribe {
  const m = getNativeModule()
  if (m == null) return () => undefined

  if (isNewArch) {
    const emitter = m[newArchName] as unknown as {
      (cb: (e: T) => void): { remove: () => void }
    }
    const sub = emitter(listener)
    return () => {
      sub.remove()
    }
  }

  const sub = getLegacyEmitter().addListener(legacyName, listener as (e: unknown) => void)
  return () => {
    sub.remove()
  }
}

/** Exposed for tests and diagnostics only. */
export function __resetNativeModuleCache(): void {
  cached = null
  resolved = false
  legacyEmitter = null
  isNewArch = false
}
