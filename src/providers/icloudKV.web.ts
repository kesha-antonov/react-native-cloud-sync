import { unsupportedPlatform } from '../errors'
import type { AccountStatus, CloudProvider } from '../types'

const NAME = 'icloudKV' as const

const DETAIL
  = 'NSUbiquitousKeyValueStore has no browser API. Use the cloudKit provider, which '
    + 'reaches the same private database over CloudKit Web Services.'

function reject(): never {
  throw unsupportedPlatform(NAME, DETAIL)
}

/**
 * Web build of the iCloud key-value provider.
 *
 * Every operation rejects with `ERR_UNSUPPORTED_PLATFORM` rather than resolving
 * `null` or silently no-oping, so a web build fails loudly at the call site
 * instead of appearing to work and quietly dropping data.
 */
export const icloudKV: CloudProvider = {
  name: NAME,
  isAvailable: () => Promise.resolve(false),
  getAccountStatus: (): Promise<AccountStatus> => Promise.resolve('couldNotDetermine'),
  getItem: reject,
  setItem: reject,
  removeItem: reject,
  getAllKeys: reject,
  // Not `reject`: a quota question has a truthful answer on web - there is no
  // key-value store here to be full - and `getQuota` is documented as reporting
  // `null` for a provider that does not know.
  getQuota: () => Promise.resolve(null),
}

export function sync(): Promise<boolean> {
  return reject()
}

export function getAllItems(): Promise<Record<string, string>> {
  return reject()
}
