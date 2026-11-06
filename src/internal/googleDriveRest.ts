import { CloudSyncError, ErrorCode, isCancelled } from '../errors'
import { clampRetryAfterMs } from './records'
import { throwIfAborted, withTimeout, type AbortLike } from './timeout'

/**
 * Google Drive `appDataFolder` REST client.
 *
 * `appDataFolder` is a hidden per-app, per-Google-account folder: nothing shows
 * up in the user's visible Drive, and the data is tied to the Google account
 * rather than the device or install, so reinstalling the app or switching
 * devices doesn't lose it. It goes away only if the user disconnects the app
 * from their Drive account or deletes the data folder directly - Google
 * documents both as the ways this folder is actually removed.
 *
 * Auth is deliberately injected rather than owned. The library does not depend
 * on `@react-native-google-signin/google-signin` (or any other sign-in library),
 * so the host app keeps control of the consent flow, and the same client works
 * unchanged in a browser where that library does not apply.
 */

export interface GoogleDriveConfig {
  /**
   * Returns a valid OAuth access token with the `drive.appdata` scope, or null
   * if the user is not connected. Called before every request, so implementers
   * should refresh silently here rather than caching a stale token.
   */
  getAccessToken: () => Promise<string | null> | string | null
  /** Called when Drive rejects the token, so the host can prompt for reconnect. */
  onAuthExpired?: () => Promise<void> | void
  fetchImpl?: typeof fetch
  /**
   * Bytes per chunk for `uploadFile`/`downloadFile`. Default 8 MiB.
   *
   * Must be a multiple of 256 KiB (262144) - Google's resumable upload
   * protocol requires that for every chunk but the last. Lowered in tests to
   * exercise the multi-chunk path without a multi-MB fixture.
   */
  chunkBytes?: number
  /**
   * What to do when `appDataFolder` holds more than one file with the same
   * name. Default `'newest'`.
   *
   * Drive names are not unique - it is a file store with ids, not a key-value
   * store - so two devices creating the same key while both are offline
   * genuinely produce two files. Picking whichever the API happened to list
   * first is the worst option: the choice is unspecified, so two devices can
   * settle on different files and diverge permanently with no error anywhere.
   *
   * `'newest'` picks the most recently modified, which every device agrees on.
   * `'error'` raises {@link ErrorCode.CONFLICT} instead, for apps that would
   * rather reconcile explicitly than have one copy quietly win.
   */
  onDuplicateName?: 'newest' | 'error'
  /**
   * Abandon a request that has not answered in this long. Default 60000.
   *
   * Longer than the CloudKit client's because one "request" here can be a whole
   * 8 MiB chunk on a slow connection. `fetch` in React Native has no timeout of
   * its own, so without this a dead socket hangs the transfer forever.
   */
  timeoutMs?: number
  /**
   * Persists `uploadFile`'s resumable-session URI across process restarts.
   *
   * Without this, the session lives only in memory: a process killed mid-upload
   * loses it, and the next `uploadFile` for the same name starts over from byte
   * 0 even though Drive still has the bytes already accepted. With it, the next
   * call finds the persisted session, asks Drive for the real offset, and
   * resumes from there instead.
   *
   * A tiny JSON record, not file I/O - back it with AsyncStorage, MMKV, or a
   * single row in whatever the host app already uses. Optional; omitting it
   * keeps today's in-memory-only behaviour.
   */
  sessionStore?: GoogleDriveSessionStore
}

/** What `uploadFile` needs to resume a resumable-upload session later. */
export interface GoogleDriveUploadSession {
  sessionUrl: string
  /** The source size the session was started against - resuming into a file
   *  that has since changed size would corrupt it, so a mismatch is treated
   *  as "start fresh" rather than resumed. */
  size: number
}

/**
 * Host-supplied persistence for in-flight `uploadFile` sessions, keyed by the
 * Drive file name. See {@link GoogleDriveConfig.sessionStore}.
 */
export interface GoogleDriveSessionStore {
  get: (name: string) => Promise<GoogleDriveUploadSession | null>
  set: (name: string, session: GoogleDriveUploadSession) => Promise<void>
  remove: (name: string) => Promise<void>
}

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about'
const CHANGES_URL = 'https://www.googleapis.com/drive/v3/changes'
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

/** A local file `uploadFile` reads from, in fixed-size pieces. */
export interface DriveChunkSource {
  size: number
  read: (start: number, length: number) => Promise<Uint8Array>
}

/** A local file `downloadFile` writes into, one piece at a time. */
export interface DriveChunkSink {
  write: (bytes: Uint8Array, isFirstChunk: boolean) => Promise<void>
}

/**
 * Local file I/O for `googleDriveFiles`, supplied by the host app rather than
 * this package depending on a filesystem library.
 *
 * base64 in and out - not a stream or a byte array - because that is the
 * primitive RN filesystem libraries actually expose for a chunked read/write
 * (`expo-file-system`'s `readAsStringAsync`/`writeAsStringAsync` with
 * `EncodingType.Base64` and `position`/`length`/`append`), so the adapter
 * mirrors that rather than inventing an abstraction nothing implements
 * natively. `googleDriveFiles` does the base64 <-> bytes conversion at the
 * boundary; a chunk is capped at `chunkBytes` (8 MiB default), so the base64
 * string is never larger than that either.
 */
export interface GoogleDriveFileAdapter {
  /** Size in bytes of the local file at `uri`. */
  statSize: (uri: string) => Promise<number>
  /** Reads `length` bytes starting at `position` from the local file at `uri`, base64-encoded. */
  readChunk: (uri: string, position: number, length: number) => Promise<string>
  /** Creates (or overwrites) the local file at `uri` with these base64-encoded bytes. */
  writeChunk: (uri: string, base64: string) => Promise<void>
  /** Appends base64-encoded bytes to a file `writeChunk` already created. */
  appendChunk: (uri: string, base64: string) => Promise<void>
}

interface DriveFile {
  id: string
  name: string
  /** RFC 3339. Requested explicitly - Drive omits it unless `fields` asks. */
  modifiedTime?: string
  /** Drive's version counter. Increments on every server-side change to the
   *  file, not just content - a rename bumps it too. */
  version?: string
}

/** The `fields` mask every listing uses, so a read also learns modification time. */
const FILE_FIELDS = 'id,name,modifiedTime,version'

/**
 * The next offset a resumable session expects, from a 308's `Range` header
 * ("bytes=0-8388607" -> 8388608). Undefined when there is no usable header.
 */
function parsePersistedRange(range: string | null): number | undefined {
  if (range == null) return undefined
  const match = /bytes=0-(\d+)/.exec(range)
  return match ? Number(match[1]) + 1 : undefined
}

/**
 * `Retry-After` in milliseconds, or undefined when absent or not a number of
 * seconds. Checked for absence first: `Number(null)` is 0, which would tell
 * the backoff "retry immediately" whenever Drive simply sent no header.
 */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('Retry-After')
  if (header == null || header.trim() === '') return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) ? clampRetryAfterMs(seconds * 1000) : undefined
}

/**
 * The only origins the bearer token is ever sent to.
 *
 * Every Drive endpoint lives on `www.googleapis.com`. The one URL this client
 * does not build itself - the resumable-session URI - comes from a `Location`
 * header or, across restarts, from the host's `sessionStore`. Neither is a
 * place to take a destination for an OAuth token on trust: a tampered store
 * entry or a misbehaving proxy would otherwise receive `Authorization: Bearer`
 * for the user's Drive. Upload sessions are allowed on any single-label
 * `*.googleapis.com` host, but only under `/upload/`.
 */
const DRIVE_API_PREFIX = 'https://www.googleapis.com/'
const DRIVE_UPLOAD_URL = /^https:\/\/[a-z0-9-]+\.googleapis\.com\/upload\//

function isTrustedDriveUrl(url: string): boolean {
  return url.startsWith(DRIVE_API_PREFIX) || DRIVE_UPLOAD_URL.test(url)
}

/** A path segment for a server-issued file id. */
function idPath(id: string): string {
  return encodeURIComponent(id)
}

/**
 * A multipart boundary that does not occur in `value`.
 *
 * A boundary that does appear in the content ends the part early: whatever
 * follows it is parsed as another part, so a value containing
 * `--<boundary>` would be truncated (or reshaped) on the way to Drive.
 * `Math.random` is predictable enough that a crafted value can aim for it, so
 * the boundary comes from `crypto.getRandomValues` where available and is
 * checked against the content either way.
 */
function multipartBoundary(value: string): string {
  for (;;) {
    const boundary = `rncs-${randomToken()}`
    if (!value.includes(boundary)) return boundary
  }
}

function randomToken(): string {
  const cryptoImpl = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (typeof cryptoImpl?.getRandomValues === 'function') {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16))
    let out = ''
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
    return out
  }
  let out = ''
  for (let i = 0; i < 4; i += 1) out += Math.random().toString(36).slice(2)
  return out
}

/**
 * Names per `getItemsWithMeta` listing query. Drive caps the length of `q`;
 * 50 quoted names stays well inside it even for long keys.
 */
const NAMES_PER_QUERY = 50

/**
 * Escapes a value for a single-quoted Drive query literal. Backslash FIRST, so
 * it doesn't double-escape the backslash the quote-escaping just added.
 */
function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
}

/** True for the 404 the client tags when a file id no longer resolves. */
function isNotFound(e: unknown): boolean {
  return e instanceof CloudSyncError && e.serverErrorCode === 'NOT_FOUND'
}

/** True for a transfer failure worth retrying after re-querying the real offset. */
function isRetryableTransfer(e: unknown): boolean {
  return e instanceof CloudSyncError
    && (
      e.code === ErrorCode.NETWORK_UNAVAILABLE
      || e.code === ErrorCode.RATE_LIMITED
      // A chunk that ran out of time is the most common way a large upload on
      // a slow link fails, and Drive may well have kept part of it.
      || e.code === ErrorCode.TIMEOUT
    )
}

export class GoogleDriveClient {
  private readonly config: GoogleDriveConfig
  /**
   * name -> fileId.
   *
   * Drive has no "get by name" endpoint, so every read would otherwise cost a
   * list query. react-native-cloud-storage's Drive backend does exactly that and
   * additionally lists the *whole* drive before filtering client-side, which its
   * users measured in minutes (kuatsu#49) and which can loop forever (kuatsu#39).
   * A scoped `q=` query plus this cache keeps a read to one request, usually zero.
   */
  private readonly idCache = new Map<string, string>()
  /**
   * name -> the metadata the last listing reported.
   *
   * Kept beside the id cache so `getItemWithMeta` does not need a second round
   * trip to learn a modification time the `q=` query already returned.
   */
  private readonly metaCache = new Map<string, { modifiedAt?: number; version?: string }>()
  private readonly chunkBytes: number

  constructor(config: GoogleDriveConfig) {
    this.config = config
    this.chunkBytes = config.chunkBytes ?? DEFAULT_CHUNK_BYTES
  }

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch
  }

  private async requireToken(): Promise<string> {
    const token = await this.config.getAccessToken()
    if (!token)
      throw new CloudSyncError(
        ErrorCode.NOT_SIGNED_IN,
        '[RNCloudSync] No Google Drive access token. Connect a Google account first.',
        { provider: 'googleDrive' }
      )

    return token
  }

  /**
   * `extraOkStatuses` is for the resumable-upload protocol, where 308 ("Resume
   * Incomplete") is an expected, successful outcome rather than an error - the
   * caller inspects the response itself rather than getting a thrown rejection.
   */
  private async request(url: string, init: RequestInit, extraOkStatuses: number[] = []): Promise<Response> {
    // Checked before the token is even fetched, so it can never be attached to
    // a request bound anywhere else.
    if (!isTrustedDriveUrl(url))
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Refusing to send Google Drive credentials to a URL outside googleapis.com.',
        { provider: 'googleDrive', serverErrorCode: 'UNTRUSTED_URL' }
      )

    const token = await this.requireToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)

    let res: Response
    try {
      res = await withTimeout(
        this.fetch(url, { ...init, headers }),
        this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        'googleDrive'
      )
    }
    catch (e) {
      // A timeout is already classified and retryable; re-wrapping it as a
      // network failure would throw the distinction away.
      if (e instanceof CloudSyncError) throw e
      throw new CloudSyncError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudSync] Google Drive request failed to reach the server.',
        { provider: 'googleDrive', cause: e }
      )
    }

    if (res.ok || extraOkStatuses.includes(res.status)) return res

    if (res.status === 401) {
      await this.config.onAuthExpired?.()
      throw new CloudSyncError(
        ErrorCode.AUTH_EXPIRED,
        '[RNCloudSync] Google Drive returned HTTP 401; the access token is not valid.',
        { provider: 'googleDrive' }
      )
    }
    if (res.status === 403) {
      // Drive overloads 403 for three unrelated conditions, distinguished only by
      // `error.errors[0].reason` in the body - never by a different status code.
      // Quota-exceeded in particular is NOT the 507 a WebDAV-flavoured API might
      // use; Drive documents it as 403 `storageQuotaExceeded`, so treating it as
      // an auth failure (and wrongly prompting reconnect) is the wrong default.
      const reason = await this.driveErrorReason(res)

      if (reason === 'storageQuotaExceeded')
        throw new CloudSyncError(
          ErrorCode.QUOTA_EXCEEDED,
          '[RNCloudSync] Google Drive storage quota exceeded.',
          { provider: 'googleDrive' }
        )
      if (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded')
        throw new CloudSyncError(
          ErrorCode.RATE_LIMITED,
          '[RNCloudSync] Google Drive rate limited the request.',
          { provider: 'googleDrive' }
        )

      await this.config.onAuthExpired?.()
      throw new CloudSyncError(
        ErrorCode.AUTH_EXPIRED,
        '[RNCloudSync] Google Drive returned HTTP 403; the access token is not valid or lacks permission.',
        { provider: 'googleDrive' }
      )
    }
    if (res.status === 429)
      // The request-frequency case, distinct from the per-user 403 variants
      // above - this one really is a plain 429, no reason string to parse.
      throw new CloudSyncError(
        ErrorCode.RATE_LIMITED,
        '[RNCloudSync] Google Drive rate limited the request.',
        {
          provider: 'googleDrive',
          retryAfterMs: retryAfterMs(res),
        }
      )

    if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504)
      // Google documents every one of these as transient ("backend error") and
      // asks clients to back off and retry - for a resumable upload, to query
      // the offset and resume. Reporting them as a permanent UNKNOWN made the
      // outbox drop writes and the chunk retry give up on a passing hiccup.
      throw new CloudSyncError(
        ErrorCode.RATE_LIMITED,
        `[RNCloudSync] Google Drive returned HTTP ${res.status}; retry later.`,
        {
          provider: 'googleDrive',
          serverErrorCode: `HTTP_${res.status}`,
          retryAfterMs: retryAfterMs(res),
        }
      )

    // Tagged so callers can tell "this file id is gone" from a generic failure.
    // Without the tag a stale memoised id was indistinguishable from a real
    // error, so it could never be recovered from.
    if (res.status === 404)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Google Drive has no file with that id.',
        { provider: 'googleDrive', serverErrorCode: 'NOT_FOUND' }
      )

    throw new CloudSyncError(
      ErrorCode.UNKNOWN,
      `[RNCloudSync] Google Drive returned HTTP ${res.status}.`,
      { provider: 'googleDrive' }
    )
  }

  /**
   * Best-effort read of Drive's `error.errors[0].reason` from a failed
   * response body - the only way a 403 status distinguishes an invalid token
   * from quota-exceeded from a rate limit. Returns undefined for a body that
   * is missing, unparseable, or doesn't carry the shape Drive documents,
   * rather than throwing a second error while already handling one.
   */
  private async driveErrorReason(res: Response): Promise<string | undefined> {
    try {
      const json = await res.json() as { error?: { errors?: { reason?: string }[] } }
      return json.error?.errors?.[0]?.reason
    }
    catch {
      return undefined
    }
  }

  /**
   * Resolves a file name to its id within appDataFolder, or null if absent.
   *
   * Pass `refresh` to bypass the memo after a cached id turned out to be stale.
   */
  private async findFileId(name: string, refresh = false): Promise<string | null> {
    if (!refresh) {
      const cached = this.idCache.get(name)
      if (cached != null) return cached
    }
    this.idCache.delete(name)

    // Scope the query server-side. Escaping matters: an apostrophe in a key
    // would otherwise terminate the quoted literal and produce a malformed
    // query - and a literal backslash needs the same treatment, escaped FIRST
    // so it doesn't double-escape the backslash the quote-escaping just added.
    const q = encodeURIComponent(`name='${escapeQueryLiteral(name)}' and trashed=false`)
    const url = `${FILES_URL}?spaces=appDataFolder&q=${q}&fields=files(${FILE_FIELDS})&pageSize=10`

    const res = await this.request(url, { method: 'GET' })
    const json = (await res.json()) as { files?: DriveFile[] }
    const matches = (json.files ?? []).filter(f => f.name === name)

    if (matches.length === 0) {
      this.metaCache.delete(name)
      return null
    }

    const file = matches.length === 1 ? matches[0] : this.pickAmongDuplicates(name, matches)
    this.remember(file)
    return file.id
  }

  /**
   * Chooses between several files that share a name.
   *
   * Deterministically, and that is the whole point: the list order Drive
   * returns is unspecified, so picking the first match lets two devices settle
   * on two different files for the same key and diverge forever, silently.
   * Ordering by modification time - newest first, ties broken by id - gives
   * every device the same answer.
   */
  private pickAmongDuplicates(name: string, matches: DriveFile[]): DriveFile {
    if (this.config.onDuplicateName === 'error')
      throw new CloudSyncError(
        ErrorCode.CONFLICT,
        `[RNCloudSync] Google Drive holds ${matches.length} files named '${name}'. `
        + `Reconcile them, or configure onDuplicateName: 'newest' to always take the `
        + `most recently modified.`,
        { provider: 'googleDrive', serverErrorCode: 'DUPLICATE_NAME' }
      )

    return [...matches].sort((a, b) => {
      const at = a.modifiedTime == null ? 0 : Date.parse(a.modifiedTime)
      const bt = b.modifiedTime == null ? 0 : Date.parse(b.modifiedTime)
      if (bt !== at) return bt - at
      // Same timestamp: id is stable and unique, so this still agrees across
      // devices rather than depending on response order.
      return a.id < b.id ? -1 : 1
    })[0]
  }

  /** Records what a listing told us about a file, ids and metadata together. */
  private remember(file: DriveFile): void {
    this.idCache.set(file.name, file.id)
    const parsed = file.modifiedTime == null ? Number.NaN : Date.parse(file.modifiedTime)
    this.metaCache.set(file.name, {
      modifiedAt: Number.isNaN(parsed) ? undefined : parsed,
      version: file.version,
    })
  }

  async getItem(name: string): Promise<string | null> {
    return await this.readItem(name, false)
  }

  /**
   * `refresh` skips the memoised id and lists the name again, which is also
   * what refreshes the cached metadata.
   */
  private async readItem(name: string, refresh: boolean): Promise<string | null> {
    const id = await this.findFileId(name, refresh)
    if (id == null) return null

    try {
      const res = await this.request(`${FILES_URL}/${idPath(id)}?alt=media`, { method: 'GET' })
      return await res.text()
    }
    catch (e) {
      if (!isNotFound(e)) throw e
    }

    // The memoised id pointed at a file that is no longer there - another device
    // deleted it. Look the name up again rather than throwing off a stale memo
    // forever, and report a genuine absence as absent.
    const fresh = await this.findFileId(name, true)
    if (fresh == null) return null

    const res = await this.request(`${FILES_URL}/${idPath(fresh)}?alt=media`, { method: 'GET' })
    return await res.text()
  }

  /**
   * A read that also reports Drive's own `modifiedTime`.
   *
   * Free: resolving a name to an id is already a listing, and asking that
   * listing for `modifiedTime` costs nothing extra. Surfacing it is what lets
   * {@link resolveByModifiedAt} order copies without the app embedding a
   * timestamp in its payload.
   */
  async getItemWithMeta(
    name: string
  ): Promise<{ value: string; modifiedAt?: number; version?: string } | null> {
    // Always re-listed. The cached metadata is whatever the last listing saw,
    // which can be arbitrarily old once another device has written - and a
    // stale `modifiedAt` is exactly what makes a modified-time resolver rank
    // a newer copy below an older one. One extra request is the price.
    const value = await this.readItem(name, true)
    if (value == null) return null
    const meta = this.metaCache.get(name)
    return { value, modifiedAt: meta?.modifiedAt, version: meta?.version }
  }

  /**
   * {@link getItemWithMeta} for many names, with the metadata from one listing
   * per batch of names rather than one per name.
   *
   * Drive has no batch endpoint for content, so each value is still its own
   * download - but the id lookup, which is also where `modifiedTime` comes
   * from, collapses into `(name='a' or name='b' ...)` queries. Results line up
   * with `names`; a name with no file is `null`.
   */
  async getItemsWithMeta(
    names: string[]
  ): Promise<({ value: string; modifiedAt?: number; version?: string } | null)[]> {
    if (names.length === 0) return []

    const wanted = [...new Set(names)]
    const byName = new Map<string, DriveFile[]>()

    for (let i = 0; i < wanted.length; i += NAMES_PER_QUERY) {
      const batch = wanted.slice(i, i + NAMES_PER_QUERY)
      const clause = batch.map(n => `name='${escapeQueryLiteral(n)}'`).join(' or ')
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          spaces: 'appDataFolder',
          q: `(${clause}) and trashed=false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: '1000',
        })
        if (pageToken != null) params.set('pageToken', pageToken)
        const res = await this.request(`${FILES_URL}?${params.toString()}`, { method: 'GET' })
        const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string }
        for (const f of json.files ?? []) {
          // `name=` is exact server-side, but filter anyway, as `findFileId` does.
          if (!batch.includes(f.name)) continue
          const group = byName.get(f.name)
          if (group == null) byName.set(f.name, [f])
          else group.push(f)
        }
        pageToken = json.nextPageToken
      } while (pageToken != null)
    }

    const results = new Map<string, { value: string; modifiedAt?: number; version?: string } | null>()
    for (const name of wanted) {
      const files = byName.get(name)
      if (files == null) {
        this.idCache.delete(name)
        this.metaCache.delete(name)
        results.set(name, null)
        continue
      }

      const file = files.length === 1 ? files[0] : this.pickAmongDuplicates(name, files)
      this.remember(file)

      let value: string | null
      try {
        const res = await this.request(`${FILES_URL}/${idPath(file.id)}?alt=media`, { method: 'GET' })
        value = await res.text()
      }
      catch (e) {
        // Deleted between the listing and the download: re-resolve this one
        // name the slow way rather than failing the whole batch.
        if (!isNotFound(e)) throw e
        value = await this.readItem(name, true)
      }

      if (value == null) {
        results.set(name, null)
        continue
      }
      const meta = this.metaCache.get(name)
      results.set(name, { value, modifiedAt: meta?.modifiedAt, version: meta?.version })
    }

    return names.map(n => results.get(n) ?? null)
  }

  /**
   * Storage usage for the whole Google account.
   *
   * Note this is the account's total, not the `appDataFolder`'s share of it -
   * Drive reports no per-folder usage. Still the number a "you are running out
   * of space" prompt needs, because that is the limit a write will actually hit.
   * `limit` is absent for unlimited (Workspace pooled) accounts.
   */
  async getQuota(): Promise<{ usedBytes?: number; totalBytes?: number }> {
    const res = await this.request(`${ABOUT_URL}?fields=storageQuota`, { method: 'GET' })
    const json = (await res.json()) as {
      storageQuota?: { usage?: string; limit?: string }
    }
    const usage = Number(json.storageQuota?.usage)
    const limit = Number(json.storageQuota?.limit)
    return {
      usedBytes: Number.isFinite(usage) ? usage : undefined,
      totalBytes: Number.isFinite(limit) ? limit : undefined,
    }
  }

  async setItem(name: string, value: string): Promise<void> {
    const id = await this.findFileId(name)

    if (id != null)
      try {
        const res = await this.request(`${UPLOAD_URL}/${idPath(id)}?uploadType=media&fields=${FILE_FIELDS}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: value,
        })
        // The update bumped `modifiedTime`/`version`. Leaving the pre-write
        // metadata cached made the next `getItemWithMeta` report this device's
        // own fresh write with the old timestamp - which is exactly what a
        // modified-time resolver then ranks below an older copy elsewhere.
        const json = (await res.json().catch(() => null)) as Partial<DriveFile> | null
        if (json?.id != null) this.remember({ ...json, id: json.id, name })
        else this.metaCache.delete(name)
        return
      }
      catch (e) {
        // Same stale-memo case. Fall through and create the file again instead
        // of failing every future write to this key.
        if (!isNotFound(e)) throw e
        this.idCache.delete(name)
        this.metaCache.delete(name)
      }

    // Multipart create: metadata part pins the file into appDataFolder, second
    // part carries the content.
    const boundary = multipartBoundary(value)
    const metadata = JSON.stringify({ name, parents: ['appDataFolder'] })
    const body
      = `--${boundary}\r\n`
        + `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
        + `--${boundary}\r\n`
        + `Content-Type: application/json\r\n\r\n${value}\r\n`
        + `--${boundary}--`

    const res = await this.request(`${UPLOAD_URL}?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    const json = (await res.json()) as Partial<DriveFile>
    // Remember what the create returned so the next read does not have to list.
    if (json.id != null) this.remember({ ...json, id: json.id, name })
  }

  /**
   * Uploads `source` as `name`, using Drive's resumable protocol instead of
   * `setItem`'s single-request multipart body.
   *
   * Two things a whole-file `setItem(name, base64OfEverything)` cannot do at
   * a few hundred MB: hold the payload in memory as one JS string, and recover
   * from a dropped connection without starting over. Reading happens in fixed
   * chunks through `source.read`, so peak memory is one chunk rather than the
   * whole file, and a chunk that fails mid-flight is retried - by asking Drive
   * how many bytes it actually has and resuming from there - rather than
   * restarting the transfer.
   *
   * That resumability spans a process restart too, when {@link
   * GoogleDriveConfig.sessionStore} is configured: the session URI is persisted
   * before the first chunk goes out, and a later `uploadFile` for the same name
   * finds it, asks Drive for the real offset, and resumes from there instead of
   * byte 0. Without a `sessionStore`, the session lives only in memory, exactly
   * as before - a process that dies mid-upload loses it, and the next call
   * starts fresh.
   */
  async uploadFile(
    name: string,
    source: DriveChunkSource,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void,
    signal?: AbortLike
  ): Promise<void> {
    throwIfAborted(signal, 'googleDrive')
    const total = source.size
    const resumed = await this.resumeOrStartSession(name, total)

    // The resumed session was already complete server-side - most likely the
    // last chunk's own response was what got lost to the process dying, not
    // the chunk itself. Nothing left to send.
    if (resumed.completed) {
      if (resumed.id != null) this.idCache.set(name, resumed.id)
      await this.config.sessionStore?.remove(name)
      onProgress?.(total, total)
      return
    }

    const sessionUrl = resumed.sessionUrl
    let offset = resumed.offset
    let newId: string | undefined

    try {
      // A zero-byte file still needs one request to actually create it.
      do {
        // Checked between chunks rather than only up front: a cancel during a
        // multi-hundred-megabyte transfer has to take effect while it is running,
        // which is the entire point of being able to cancel one.
        throwIfAborted(signal, 'googleDrive')
        const length = Math.min(this.chunkBytes, total - offset)
        const step = await this.putChunkWithRetry(sessionUrl, source, offset, length, total, onProgress)
        offset = step.nextOffset
        if (step.id != null) newId = step.id
      } while (offset < total)
    }
    catch (e) {
      // A deliberate cancel abandons the session - the caller asked to stop,
      // not to resume later. Any other failure (network drop, timeout, the
      // process itself dying) leaves the persisted session in place, since
      // that is precisely what lets the next call resume instead of restarting.
      if (isCancelled(e)) await this.config.sessionStore?.remove(name)
      throw e
    }

    // A create only learns its id from the final response; an update already
    // had one via `existingId`.
    if (newId != null) this.idCache.set(name, newId)

    await this.config.sessionStore?.remove(name)
    onProgress?.(total, total)
  }

  /**
   * Finds an existing session to resume, or starts a new one.
   *
   * A persisted session is trusted only when its recorded size still matches
   * `total` - resuming a byte-range PUT into a file that has since changed
   * would corrupt it, so a mismatch is treated the same as no session at all.
   * A persisted session Drive no longer recognises (expired, or the upload id
   * was never valid) is also treated as absent: `queryUploadOffset` failing is
   * the signal, since there is no cheaper way to ask than trying to use it.
   */
  private async resumeOrStartSession(
    name: string, total: number
  ): Promise<{ sessionUrl: string; offset: number; completed: boolean; id?: string }> {
    const persisted = await this.config.sessionStore?.get(name)

    if (
      persisted != null
      && persisted.size === total
      && typeof persisted.sessionUrl === 'string'
      && isTrustedDriveUrl(persisted.sessionUrl)
    )
      try {
        const { offset, id } = await this.queryUploadOffset(persisted.sessionUrl, total)
        return { sessionUrl: persisted.sessionUrl, offset, completed: offset >= total, id }
      }
      catch {
        // Falls through to starting a fresh session below.
      }

    const existingId = await this.findFileId(name)
    let sessionUrl: string
    try {
      sessionUrl = await this.startResumableSession(name, existingId)
    }
    catch (e) {
      // A memoised id for a file another device has since deleted. Look the
      // name up again (and create it if it really is gone) rather than failing
      // every later upload of this name off the stale memo.
      if (existingId == null || !isNotFound(e)) throw e
      sessionUrl = await this.startResumableSession(name, await this.findFileId(name, true))
    }
    await this.config.sessionStore?.set(name, { sessionUrl, size: total })
    return { sessionUrl, offset: 0, completed: false }
  }

  private async startResumableSession(name: string, existingId: string | null): Promise<string> {
    const url = existingId != null
      ? `${UPLOAD_URL}/${idPath(existingId)}?uploadType=resumable`
      : `${UPLOAD_URL}?uploadType=resumable&fields=id`
    const metadata = existingId != null ? {} : { name, parents: ['appDataFolder'] }

    const res = await this.request(url, {
      method: existingId != null ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(metadata),
    })

    const location = res.headers.get('Location')
    if (location == null)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Google Drive did not return a resumable session URI.',
        { provider: 'googleDrive' }
      )
    // Persisted and later sent the bearer token, so it has to be a Drive URL.
    if (!isTrustedDriveUrl(location))
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Google Drive returned a resumable session URI outside googleapis.com.',
        { provider: 'googleDrive', serverErrorCode: 'UNTRUSTED_URL' }
      )

    return location
  }

  /** One chunk, with a single retry that re-queries the server's real offset first. */
  private async putChunkWithRetry(
    sessionUrl: string,
    source: DriveChunkSource,
    offset: number,
    length: number,
    total: number,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<{ nextOffset: number; id?: string }> {
    try {
      return await this.putChunk(sessionUrl, source, offset, length, total, onProgress)
    }
    catch (e) {
      if (!isRetryableTransfer(e)) throw e
      const resumed = await this.queryUploadOffset(sessionUrl, total)
      // The dropped chunk's own response was what got lost, not the chunk -
      // Drive already has everything. A retry PUT here would send a zero-length,
      // malformed Content-Range (end before start).
      if (resumed.offset >= total) {
        onProgress?.(total, total)
        return { nextOffset: total, id: resumed.id }
      }
      const retryLength = Math.min(this.chunkBytes, total - resumed.offset)
      return await this.putChunk(sessionUrl, source, resumed.offset, retryLength, total, onProgress)
    }
  }

  private async putChunk(
    sessionUrl: string,
    source: DriveChunkSource,
    offset: number,
    length: number,
    total: number,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<{ nextOffset: number; id?: string }> {
    const bytes = await source.read(offset, length)
    // A source that hands back nothing for a non-empty range would otherwise
    // never advance the offset, and `uploadFile` would loop forever.
    if (length > 0 && bytes.length === 0)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        `[RNCloudSync] The upload source returned no bytes at offset ${offset} of ${total}.`,
        { provider: 'googleDrive' }
      )
    const range = total === 0 ? 'bytes */0' : `bytes ${offset}-${offset + bytes.length - 1}/${total}`

    const res = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': range },
      // TS's DOM lib types BodyInit's BufferSource as Uint8Array<ArrayBuffer>
      // specifically, which a plain Uint8Array read doesn't structurally
      // match even though every fetch implementation accepts it at runtime.
      body: bytes as BodyInit,
    }, [308])

    if (res.status === 308) {
      // Drive may persist fewer bytes than were sent, and says so in `Range`.
      // Resuming from `offset + bytes.length` regardless would skip whatever it
      // dropped and leave a hole in the uploaded file. Only fall back to the
      // sent length when the header is missing entirely.
      const persisted = parsePersistedRange(res.headers.get('Range'))
      const nextOffset = persisted ?? offset + bytes.length
      onProgress?.(nextOffset, total)
      return { nextOffset }
    }

    // 200/201: the file is complete.
    const json = (await res.json().catch(() => null)) as { id?: string } | null
    return { nextOffset: total, id: json?.id }
  }

  /**
   * Asks Drive how much of an in-flight resumable session it actually has, or
   * discovers the upload was already complete server-side - the completing
   * chunk's own response can be lost the same way any other one can, and this
   * status check gets the same completion response back in that case,
   * `id` included.
   *
   * Throws (via `request`) when `sessionUrl` is not a session Drive
   * recognises any more - expired, or never valid. Callers treat that as the
   * signal to stop trusting it, since there is no cheaper way to ask.
   */
  private async queryUploadOffset(sessionUrl: string, total: number): Promise<{ offset: number; id?: string }> {
    const res = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${total}` },
    }, [308])

    if (res.status !== 308) {
      const json = (await res.json().catch(() => null)) as { id?: string } | null
      return { offset: total, id: json?.id ?? undefined }
    }

    return { offset: parsePersistedRange(res.headers.get('Range')) ?? 0 }
  }

  /**
   * Downloads `name` into `sink`, in the same fixed-size chunks `uploadFile`
   * writes in - so a restore never holds the whole file in memory either.
   * Resolves `false` when no such file exists, `true` once every chunk has
   * been handed to the sink.
   */
  async downloadFile(
    name: string,
    sink: DriveChunkSink,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void,
    signal?: AbortLike
  ): Promise<boolean> {
    throwIfAborted(signal, 'googleDrive')
    let id = await this.findFileId(name)
    if (id == null) return false

    let total: number
    try {
      total = await this.fileSize(id)
    }
    catch (e) {
      // Same stale-memo case `getItem` recovers from: another device deleted
      // (or replaced) the file. Without this every later download of the name
      // failed off the cached id until the app restarted.
      if (!isNotFound(e)) throw e
      id = await this.findFileId(name, true)
      if (id == null) return false
      total = await this.fileSize(id)
    }

    if (total === 0) {
      await sink.write(new Uint8Array(0), true)
      onProgress?.(0, 0)
      return true
    }

    let offset = 0
    let isFirstChunk = true
    while (offset < total) {
      throwIfAborted(signal, 'googleDrive')
      const end = Math.min(offset + this.chunkBytes, total) - 1
      const res = await this.request(`${FILES_URL}/${idPath(id)}?alt=media`, {
        method: 'GET',
        headers: { Range: `bytes=${offset}-${end}` },
      })
      const bytes = new Uint8Array(await res.arrayBuffer())
      // Same guard as the upload side: an empty body would never advance.
      if (bytes.length === 0)
        throw new CloudSyncError(
          ErrorCode.UNKNOWN,
          `[RNCloudSync] Google Drive returned no bytes at offset ${offset} of ${total}.`,
          { provider: 'googleDrive' }
        )
      await sink.write(bytes, isFirstChunk)
      isFirstChunk = false
      offset += bytes.length
      onProgress?.(offset, total)
    }

    return true
  }

  private async fileSize(id: string): Promise<number> {
    const res = await this.request(`${FILES_URL}/${idPath(id)}?fields=size`, { method: 'GET' })
    const json = (await res.json()) as { size?: string }
    if (json.size == null) return 0
    const size = Number(json.size)
    // A size that is not a non-negative integer would make the chunk loop
    // either never run - reporting a download that wrote nothing as complete -
    // or compute nonsense ranges.
    if (!Number.isSafeInteger(size) || size < 0)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Google Drive reported an invalid file size.',
        { provider: 'googleDrive' }
      )
    return size
  }

  async removeItem(name: string): Promise<void> {
    const id = await this.findFileId(name)
    // Already absent is the desired end state, not a failure.
    if (id == null) return

    try {
      await this.request(`${FILES_URL}/${idPath(id)}`, { method: 'DELETE' })
    }
    catch (e) {
      // Deleted from under us: the end state the caller asked for already holds.
      if (!isNotFound(e)) throw e
    }
    finally {
      this.idCache.delete(name)
      this.metaCache.delete(name)
    }
  }

  async getAllKeys(): Promise<string[]> {
    const byName = new Map<string, DriveFile[]>()
    let pageToken: string | undefined

    // Paginate rather than assuming one page holds everything.
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        q: 'trashed=false',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '100',
      })
      if (pageToken != null) params.set('pageToken', pageToken)

      const res = await this.request(`${FILES_URL}?${params.toString()}`, { method: 'GET' })
      const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string }

      for (const f of json.files ?? []) {
        const group = byName.get(f.name)
        if (group == null) byName.set(f.name, [f])
        else group.push(f)
      }
      pageToken = json.nextPageToken
    } while (pageToken != null)

    // Drive names are not unique. Memoising whichever duplicate happened to be
    // listed last bypassed `pickAmongDuplicates` entirely - the next `getItem`
    // served that arbitrary file from the cache - and the same key came back
    // once per copy.
    for (const [name, files] of byName)
      if (files.length === 1) {
        this.remember(files[0])
      }
      else if (this.config.onDuplicateName !== 'error') {
        this.remember(this.pickAmongDuplicates(name, files))
      }
      else {
        // Leave it uncached so the next read raises the CONFLICT itself.
        this.idCache.delete(name)
        this.metaCache.delete(name)
      }

    return [...byName.keys()]
  }

  /**
   * A cursor marking "everything up to now", for {@link pollChanges}.
   *
   * Drive's change feed is cursor-based rather than time-based, so a watcher
   * has to take a starting cursor before it can ask what changed since.
   */
  async getStartPageToken(): Promise<string> {
    const res = await this.request(
      // No `spaces` here: `changes.getStartPageToken` takes only the shared
      // drive parameters. The cursor covers every space; `changes.list` is
      // where `spaces=appDataFolder` scopes the feed.
      `${CHANGES_URL}/startPageToken`,
      { method: 'GET' }
    )
    const json = (await res.json()) as { startPageToken?: string }
    if (json.startPageToken == null)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] Google Drive did not return a change cursor.',
        { provider: 'googleDrive' }
      )

    return json.startPageToken
  }

  /**
   * What changed in `appDataFolder` since `pageToken`, and the cursor to use
   * next time.
   *
   * This is how a non-Apple platform learns that another device wrote something
   * - CloudKit gets `NSUbiquitousKeyValueStore` notifications and `CKAccountChanged`
   * for free, but Drive has no push channel without a server to receive its
   * webhooks, so the honest equivalent is a cursor the app polls. Cheap: a poll
   * with nothing to report is one request returning an empty list.
   *
   * Deletions are included - `removed` entries and trashed files both surface,
   * because "another device deleted this key" is exactly as important as
   * "another device changed it".
   */
  async pollChanges(pageToken: string): Promise<{ names: string[]; nextToken: string }> {
    const names = new Set<string>()
    let token = pageToken
    let nextToken: string

    for (;;) {
      const params = new URLSearchParams({
        pageToken: token,
        spaces: 'appDataFolder',
        includeRemoved: 'true',
        fields: 'newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,trashed))',
      })
      const res = await this.request(`${CHANGES_URL}?${params.toString()}`, { method: 'GET' })
      const json = (await res.json()) as {
        newStartPageToken?: string
        nextPageToken?: string
        changes?: {
          fileId?: string
          removed?: boolean
          file?: { id?: string; name?: string; trashed?: boolean }
        }[]
      }

      for (const change of json.changes ?? []) {
        const name = change.file?.name
        if (name != null) {
          names.add(name)
          // A file that went away must not keep answering reads from the id
          // cache, and one that changed must be re-read rather than served
          // from a stale memo.
          // Dropped on every change, not only a removal. A changed file keeps
          // its id but not its cached modification time, and a change to a
          // *different* file under a cached name - another device created a
          // same-named copy - has to go back through the listing or the
          // duplicate resolution never runs and this device keeps reading its
          // old copy forever. One listing on the next read is the cost.
          this.idCache.delete(name)
          this.metaCache.delete(name)
          continue
        }

        // Drive omits `file` for a change the caller can no longer see. All we
        // have is the id, so drop whichever cached name points at it.
        if (change.fileId != null) this.forgetById(change.fileId)
      }

      // `nextPageToken` means more pages of the same batch; `newStartPageToken`
      // means this was the last page and is the cursor for next time.
      if (json.nextPageToken != null) {
        token = json.nextPageToken
        continue
      }
      nextToken = json.newStartPageToken ?? token
      break
    }

    return { names: [...names], nextToken }
  }

  /** Drops whatever name currently memoises this file id. */
  private forgetById(fileId: string): void {
    for (const [name, id] of this.idCache)
      if (id === fileId) {
        this.idCache.delete(name)
        this.metaCache.delete(name)
        return
      }
  }

  /**
   * Whether an access token can currently be obtained, without making a network
   * request. Backs the provider's `isAvailable()` probe.
   */
  async hasToken(): Promise<boolean> {
    try {
      return (await this.config.getAccessToken()) != null
    }
    catch {
      return false
    }
  }

  /** Drops memoised file ids. Call after an account switch. */
  clearCache(): void {
    this.idCache.clear()
    this.metaCache.clear()
  }
}
