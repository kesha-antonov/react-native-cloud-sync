import { CloudSyncError, ErrorCode } from '../errors'
import { throwIfAborted, withTimeout, type AbortLike } from './timeout'

/**
 * Google Drive `appDataFolder` REST client.
 *
 * `appDataFolder` is a hidden per-app, per-Google-account folder: nothing shows
 * up in the user's visible Drive, and the data survives an app uninstall because
 * it is tied to the account rather than the install.
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
  /** Drive's version counter. Increments on every content change. */
  version?: string
}

/** The `fields` mask every listing uses, so a read also learns modification time. */
const FILE_FIELDS = 'id,name,modifiedTime,version'

/** True for the 404 the client tags when a file id no longer resolves. */
function isNotFound(e: unknown): boolean {
  return e instanceof CloudSyncError && e.serverErrorCode === 'NOT_FOUND'
}

/** True for a transfer failure worth retrying after re-querying the real offset. */
function isRetryableTransfer(e: unknown): boolean {
  return e instanceof CloudSyncError
    && (e.code === ErrorCode.NETWORK_UNAVAILABLE || e.code === ErrorCode.RATE_LIMITED)
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

    if (res.status === 401 || res.status === 403) {
      await this.config.onAuthExpired?.()
      throw new CloudSyncError(
        ErrorCode.AUTH_EXPIRED,
        `[RNCloudSync] Google Drive returned HTTP ${res.status}; the access token is not valid.`,
        { provider: 'googleDrive' }
      )
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      throw new CloudSyncError(
        ErrorCode.RATE_LIMITED,
        '[RNCloudSync] Google Drive rate limited the request.',
        {
          provider: 'googleDrive',
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        }
      )
    }
    if (res.status === 507)
      throw new CloudSyncError(
        ErrorCode.QUOTA_EXCEEDED,
        '[RNCloudSync] Google Drive storage quota exceeded.',
        { provider: 'googleDrive' }
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
    // would otherwise terminate the quoted literal and produce a malformed query.
    const q = encodeURIComponent(`name='${name.replace(/'/g, '\\\'')}' and trashed=false`)
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
    const id = await this.findFileId(name)
    if (id == null) return null

    try {
      const res = await this.request(`${FILES_URL}/${id}?alt=media`, { method: 'GET' })
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

    const res = await this.request(`${FILES_URL}/${fresh}?alt=media`, { method: 'GET' })
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
    const value = await this.getItem(name)
    if (value == null) return null
    const meta = this.metaCache.get(name)
    return { value, modifiedAt: meta?.modifiedAt, version: meta?.version }
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
        await this.request(`${UPLOAD_URL}/${id}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: value,
        })
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
    const boundary = `rncs-${Math.random().toString(36).slice(2)}`
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
   * That resumability is scoped to this call: the session lives only in
   * memory, so if the process dies mid-upload, the next call to `uploadFile`
   * starts a fresh session from byte 0. Persisting the session URI so a
   * restart can resume it too is future scope, not something callers should
   * assume works today.
   */
  async uploadFile(
    name: string,
    source: DriveChunkSource,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void,
    signal?: AbortLike
  ): Promise<void> {
    throwIfAborted(signal, 'googleDrive')
    const existingId = await this.findFileId(name)
    const sessionUrl = await this.startResumableSession(name, existingId)

    let offset = 0
    let newId: string | undefined
    const total = source.size

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

    // A create only learns its id from the final response; an update already
    // had one via `existingId`.
    if (newId != null) this.idCache.set(name, newId)

    onProgress?.(total, total)
  }

  private async startResumableSession(name: string, existingId: string | null): Promise<string> {
    const url = existingId != null
      ? `${UPLOAD_URL}/${existingId}?uploadType=resumable`
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
      const resumeFrom = await this.queryUploadOffset(sessionUrl, total)
      const retryLength = Math.min(this.chunkBytes, total - resumeFrom)
      return await this.putChunk(sessionUrl, source, resumeFrom, retryLength, total, onProgress)
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
    const range = total === 0 ? 'bytes */0' : `bytes ${offset}-${offset + bytes.length - 1}/${total}`

    const res = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': range },
      // TS's DOM lib types BodyInit's BufferSource as Uint8Array<ArrayBuffer>
      // specifically, which a plain Uint8Array read doesn't structurally
      // match even though every fetch implementation accepts it at runtime.
      body: bytes as BodyInit,
    }, [308])

    const nextOffset = offset + bytes.length
    if (res.status === 308) {
      onProgress?.(nextOffset, total)
      return { nextOffset }
    }

    // 200/201: the file is complete.
    const json = (await res.json().catch(() => null)) as { id?: string } | null
    return { nextOffset: total, id: json?.id }
  }

  /** Asks Drive how much of an in-flight resumable session it actually has. */
  private async queryUploadOffset(sessionUrl: string, total: number): Promise<number> {
    const res = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${total}` },
    }, [308])

    if (res.status !== 308) return total // already complete, unexpectedly

    const range = res.headers.get('Range') // "bytes=0-8388607"
    if (range == null) return 0

    const match = /bytes=0-(\d+)/.exec(range)
    return match ? Number(match[1]) + 1 : 0
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
    const id = await this.findFileId(name)
    if (id == null) return false

    const total = await this.fileSize(id)

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
      const res = await this.request(`${FILES_URL}/${id}?alt=media`, {
        method: 'GET',
        headers: { Range: `bytes=${offset}-${end}` },
      })
      const bytes = new Uint8Array(await res.arrayBuffer())
      await sink.write(bytes, isFirstChunk)
      isFirstChunk = false
      offset += bytes.length
      onProgress?.(offset, total)
    }

    return true
  }

  private async fileSize(id: string): Promise<number> {
    const res = await this.request(`${FILES_URL}/${id}?fields=size`, { method: 'GET' })
    const json = (await res.json()) as { size?: string }
    return json.size != null ? Number(json.size) : 0
  }

  async removeItem(name: string): Promise<void> {
    const id = await this.findFileId(name)
    // Already absent is the desired end state, not a failure.
    if (id == null) return

    try {
      await this.request(`${FILES_URL}/${id}`, { method: 'DELETE' })
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
    const names: string[] = []
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
        names.push(f.name)
        this.remember(f)
      }
      pageToken = json.nextPageToken
    } while (pageToken != null)

    return names
  }

  /**
   * A cursor marking "everything up to now", for {@link pollChanges}.
   *
   * Drive's change feed is cursor-based rather than time-based, so a watcher
   * has to take a starting cursor before it can ask what changed since.
   */
  async getStartPageToken(): Promise<string> {
    const res = await this.request(
      `${CHANGES_URL}/startPageToken?spaces=appDataFolder`,
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
          if (change.removed === true || change.file?.trashed === true) {
            this.idCache.delete(name)
            this.metaCache.delete(name)
          }
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
