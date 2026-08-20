/**
 * Test utilities.
 *
 * Deliberately a real package entry point:
 *
 *   import { createMemoryProvider } from 'react-native-cloud-sync/testing'
 *
 * expo-cloudkit ships a comparable mock factory but never exports it from the
 * package (its own source says "Import them directly from 'expo-cloudkit/src/testing'
 * in test environments only") and never mentions it in the README - so in
 * practice nobody finds it. An untested testing helper is not a testing story.
 */
export {
  createMemoryProvider,
  type Fault,
  type FaultOp,
  type MemoryProvider,
  type MemoryProviderOptions
} from './providers/memory'

export { ErrorCode, CloudSyncError, isCloudSyncError } from './errors'
export type { AccountStatus, ChangeReason, CloudProvider } from './types'
