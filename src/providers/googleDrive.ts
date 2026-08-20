import { getGoogleDriveClient, isGoogleDriveConfigured } from '../config'
import { GoogleDriveClient, type GoogleDriveConfig } from '../internal/googleDriveRest'
import { normalizeError } from '../errors'
import type { AccountStatus, CloudProvider, ProviderName, RemoteChangeEvent } from '../types'

const NAME = 'googleDrive' as const

/**
 * How often the change cursor is polled once something subscribes.
 *
 * 30s is a compromise: fast enough that a second device feels responsive,
 * slow enough that a backgrounded app is not spending battery on a feed that
 * is usually empty.
 */
const DEFAULT_POLL_INTERVAL_MS = 30_000

/**
 * Builds a Drive provider over whichever client `getClient` returns.
 *
 * Written as a factory so the package-level singleton and the per-instance
 * providers from {@link createGoogleDriveProvider} share one implementation
 * instead of two copies that drift.
 */
function makeDriveProvider(
  name: ProviderName,
  getClient: () => GoogleDriveClient,
  isConfigured: () => boolean,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): CloudProvider {
  const provider: CloudProvider = {
    name,

    isAvailable: async () => {
      if (!isConfigured()) return false
      try {
        // Only checks that a token can be obtained. Deliberately does not list
        // files - `isAvailable` is safe to call on a render path, and a full
        // listing is a paginated network round trip.
        return await getClient().hasToken()
      }
      catch {
        return false
      }
    },

    getAccountStatus: (): Promise<AccountStatus> =>
      Promise.resolve(isConfigured() ? 'available' : 'noAccount'),

    getItem: async (key: string) => {
      try {
        return await getClient().getItem(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    getItemWithMeta: async (key: string) => {
      try {
        return await getClient().getItemWithMeta(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    setItem: async (key: string, value: string) => {
      try {
        await getClient().setItem(key, value)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    removeItem: async (key: string) => {
      try {
        await getClient().removeItem(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    getAllKeys: async () => {
      try {
        return await getClient().getAllKeys()
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    /**
     * Storage usage for the Google account.
     *
     * Drive reports no per-folder figure, so this is the whole account's -
     * which is the number that matters anyway, since that is the limit a write
     * actually hits. `totalBytes` is absent on pooled/unlimited accounts.
     */
    getQuota: async () => {
      try {
        return { ...(await getClient().getQuota()), provider: name }
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    // Deliberately no multiGet/multiSet: Drive stores one file per key and has
    // no batch endpoint for content (the JSON-RPC batch endpoint was retired in
    // 2020 and never carried media bodies). Advertising a batch API that
    // secretly looped would hide N round trips behind a call that looks like
    // one, so the store's own sequential fallback is used - same cost, honest
    // about it.

    clearCaches: () => {
      // Memoised file ids belong to the account that was signed in when they
      // were recorded. Handing them to the next user is a cross-account leak.
      if (isConfigured()) getClient().clearCache()
      stopWatching()
    },

    /**
     * Fires when another device changed something in `appDataFolder`.
     *
     * Drive has no push channel a mobile client can subscribe to - its webhooks
     * need a public HTTPS endpoint to deliver to - so this polls Drive's change
     * cursor. That is the honest implementation, and it is cheap: a poll with
     * nothing to report is one request returning an empty list.
     *
     * Polling starts with the first subscriber and stops with the last, so an
     * app that never subscribes never makes a request. Interval comes from
     * `changePollIntervalMs` (default 30s).
     */
    onRemoteChange: (listener) => {
      changeListeners.add(listener)
      startWatching()
      return () => {
        changeListeners.delete(listener)
        if (changeListeners.size === 0) stopWatching()
      }
    },
  }

  // ---------------------------------------------------------- change polling

  const changeListeners = new Set<(e: RemoteChangeEvent) => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  let cursor: string | null = null
  let polling = false

  function startWatching(): void {
    if (timer != null || !isConfigured()) return

    timer = setInterval(() => {
      void poll()
    }, pollIntervalMs)
    // Never hold the process open for a background poll - this is a cache
    // refresh, not work anyone is waiting on.
    timer.unref?.()
  }

  function stopWatching(): void {
    if (timer != null) clearInterval(timer)
    timer = null
    cursor = null
  }

  async function poll(): Promise<void> {
    // Skip rather than queue: a poll that outruns its interval on a slow link
    // would otherwise pile up requests behind it.
    if (polling || !isConfigured()) return
    polling = true

    try {
      const client = getClient()
      if (cursor == null) {
        // First tick only establishes the starting cursor. Reporting everything
        // that ever happened as "just changed" would make every subscriber
        // re-read the whole store on launch.
        cursor = await client.getStartPageToken()
        return
      }

      const { names, nextToken } = await client.pollChanges(cursor)
      cursor = nextToken
      if (names.length === 0) return

      const event: RemoteChangeEvent = { keys: names, reason: 'serverChange', provider: name }
      for (const l of changeListeners) l(event)
    }
    catch {
      // A failed poll is not the app's problem: the next tick tries again, and
      // the cursor is only advanced on success so nothing is skipped.
    }
    finally {
      polling = false
    }
  }

  return provider
}

/**
 * Google Drive `appDataFolder`, using the credentials from
 * `configureGoogleDrive()`.
 *
 * The only provider that works identically on iOS, Android and web, which makes
 * it the sensible continuous backend for cross-platform apps - CloudKit's
 * Android/web path needs a periodic Apple ID re-auth, this does not.
 */
export const googleDrive: CloudProvider = makeDriveProvider(
  NAME,
  getGoogleDriveClient,
  isGoogleDriveConfigured
)

/**
 * A Drive provider with its own credentials and its own name.
 *
 * `configureGoogleDrive` sets one client for the whole process, which is right
 * for the overwhelmingly common single-account app but leaves no way to reach
 * two accounts at once - a profile switcher, a "copy my data to another
 * account" flow, or a test that needs two isolated instances. Those need a
 * provider that owns its config rather than reading a module-level singleton.
 *
 * ```ts
 * const work = createGoogleDriveProvider({
 *   name: 'drive:work',
 *   getAccessToken: () => workToken(),
 * })
 * const store = createCloudStore({ providers: ['drive:work'] })
 * store.registerProvider(work)
 * ```
 */
export function createGoogleDriveProvider(
  config: GoogleDriveConfig & {
    name?: ProviderName
    /** How often `onRemoteChange` polls Drive's change cursor. Default 30000. */
    changePollIntervalMs?: number
  }
): CloudProvider {
  const client = new GoogleDriveClient(config)
  return makeDriveProvider(
    config.name ?? NAME,
    () => client,
    () => true,
    config.changePollIntervalMs
  )
}
