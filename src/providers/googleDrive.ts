import { getGoogleDriveClient, isGoogleDriveConfigured } from '../config'
import { normalizeError } from '../errors'
import type { AccountStatus, CloudProvider } from '../types'

const NAME = 'googleDrive' as const

/**
 * Google Drive `appDataFolder`.
 *
 * The only provider that works identically on iOS, Android and web, which makes
 * it the sensible continuous backend for cross-platform apps - CloudKit's
 * Android/web path needs a periodic Apple ID re-auth, this does not.
 */
export const googleDrive: CloudProvider = {
  name: NAME,

  isAvailable: async () => {
    if (!isGoogleDriveConfigured()) return false
    try {
      // Only checks that a token can be obtained. Deliberately does not list
      // files - `isAvailable` is safe to call on a render path, and a full
      // listing is a paginated network round trip.
      return (await getGoogleDriveClient().hasToken())
    }
    catch {
      return false
    }
  },

  getAccountStatus: (): Promise<AccountStatus> =>
    Promise.resolve(isGoogleDriveConfigured() ? 'available' : 'noAccount'),

  getItem: async (key: string) => {
    try {
      return await getGoogleDriveClient().getItem(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  setItem: async (key: string, value: string) => {
    try {
      await getGoogleDriveClient().setItem(key, value)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  removeItem: async (key: string) => {
    try {
      await getGoogleDriveClient().removeItem(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  getAllKeys: async () => {
    try {
      return await getGoogleDriveClient().getAllKeys()
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
}
