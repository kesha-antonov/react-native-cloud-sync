import { CloudSyncError, ErrorCode } from '../errors'

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
}

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

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
 * primitive every RN filesystem library actually exposes for a chunked
 * read/write (`react-native-fs`'s `read`/`RNFS.write`, `expo-file-system`'s
 * `readAsStringAsync`/`writeAsStringAsync` with `EncodingType.Base64`), so the
 * adapter mirrors that rather than inventing an abstraction nothing implements
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
}

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
      res = await this.fetch(url, { ...init, headers })
    }
    catch (e) {
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
    const url = `${FILES_URL}?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=10`

    const res = await this.request(url, { method: 'GET' })
    const json = (await res.json()) as { files?: DriveFile[] }
    const file = json.files?.find(f => f.name === name)
    if (file == null) return null

    this.idCache.set(name, file.id)
    return file.id
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

    const res = await this.request(`${UPLOAD_URL}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    const json = (await res.json()) as { id?: string }
    if (json.id != null) this.idCache.set(name, json.id)
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
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<void> {
    const existingId = await this.findFileId(name)
    const sessionUrl = await this.startResumableSession(name, existingId)

    let offset = 0
    let newId: string | undefined
    const total = source.size

    // A zero-byte file still needs one request to actually create it.
    do {
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
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<boolean> {
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
        fields: 'nextPageToken,files(id,name)',
        pageSize: '100',
      })
      if (pageToken != null) params.set('pageToken', pageToken)

      const res = await this.request(`${FILES_URL}?${params.toString()}`, { method: 'GET' })
      const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string }

      for (const f of json.files ?? []) {
        names.push(f.name)
        this.idCache.set(f.name, f.id)
      }
      pageToken = json.nextPageToken
    } while (pageToken != null)

    return names
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
  }
}
