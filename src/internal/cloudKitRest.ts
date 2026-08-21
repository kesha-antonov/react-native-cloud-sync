import { CloudSyncError, ErrorCode, timedOut } from '../errors'
import { byteLength } from './bytes'
import { withTimeout } from './timeout'

/** Default request timeout. Generous, because a large record on a slow link is normal. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * CloudKit Web Services REST client.
 *
 * This is how the `cloudKit` provider reaches a user's PRIVATE database from
 * Android and from the browser, where `CloudKit.framework` does not exist.
 *
 * Why an interactive user token and not a server key: Apple is explicit that a
 * server-to-server key reaches only the *public* database - "Use a
 * server-to-server key to access the public database of a container as the
 * developer who created the key." Sign in with Apple cannot substitute either;
 * per Apple DTS, "The unique user identifiers for Sign in with Apple and
 * CloudKit are not linked." So an interactive `ckWebAuthToken` is not a shortcut
 * this package chose - it is the only mechanism that exists.
 *
 * Deliberately no dependency on CloudKit JS. That library pulls Node's `crypto`
 * for server-to-server signing, which is what killed the last React Native
 * attempt at this (KjellConnelly/react-native-cloudkit pinned v1 because "2.0
 * requires crypto which ... doesn't work with React Native"). The REST API in
 * user-token mode needs no crypto at all: two query parameters on a `fetch`.
 */

export interface CloudKitRestConfig {
  /** e.g. `iCloud.com.example.app`. Must match the app's entitlement exactly. */
  containerIdentifier: string
  /**
   * A CloudKit Console **Client** API token, not a server-to-server key.
   *
   * A client token grants only what the authenticated user could already do, so
   * it is safe to ship in an app binary. A server-to-server private key is not.
   */
  apiToken: string
  environment: 'development' | 'production'
  /** Returns the stored `ckWebAuthToken`, or null when the user has not signed in. */
  getAuthToken: () => Promise<string | null> | string | null
  /**
   * Called when CloudKit reports the token is no longer usable, so the host can
   * clear it and prompt for re-auth.
   *
   * This fires more often than you might expect: a `ckWebAuthToken` expires
   * after 30 minutes, or 2 weeks if the user ticked "Keep me signed in" during
   * sign-in. Apple documents no refresh mechanism.
   */
  onAuthExpired?: () => Promise<void> | void
  /** Overridable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Overridable for tests. Defaults to the global `XMLHttpRequest` constructor.
   *
   * Only used for the raw asset-bytes upload/download - `fetch` in React
   * Native exposes no upload-progress events at all, and `XMLHttpRequest.upload
   * .onprogress` (and its response-side `.onprogress`) are what the per-record
   * progress `cloudKitAssets.onProgress` promises actually needs. Every other
   * request in this client stays on `fetch`.
   */
  xhrImpl?: () => XMLHttpRequest
  /**
   * Abandon a request that has not answered in this long. Default 30000.
   *
   * React Native's `fetch` has no timeout of its own, so without this a socket
   * that never answers hangs the operation forever - and `isReachable()` is on
   * the path of every read, so one hung probe stalls the whole store.
   */
  timeoutMs?: number
}

/**
 * CloudKit Web Services' own ceiling on a single asset upload, undocumented
 * anywhere except the upload endpoint's own reference page: 15 MB, and the
 * upload URL it hands out is valid for 15 minutes. Native `CKAsset` has no such
 * limit - this is specific to the REST upload-token protocol.
 */
export const MAX_ASSET_UPLOAD_BYTES = 15 * 1024 * 1024

/**
 * The "Asset Dictionary" CloudKit Web Services deals in - what the upload
 * endpoint returns after receiving bytes, and what a fetched record's Asset
 * field value looks like. Passed back verbatim as a record field's value to
 * attach an upload to a record; never reconstructed field-by-field, since it
 * is an opaque blob the server itself validates.
 */
export interface CloudKitAssetDescriptor {
  fileChecksum: string
  size: string | number
  receipt: string
  referenceChecksum?: string
  wrappingKey?: string
  /** Present only when fetching the record that owns this field, not on upload. */
  downloadURL?: string
}

/**
 * How many operations one `/records/modify` or `/records/lookup` call carries.
 *
 * Apple does not publish a hard maximum, but very large batches are rejected
 * outright and a batch is atomic, so an oversized one fails as a unit. 200
 * matches the page size CloudKit itself uses for query results.
 */
const MAX_BATCH = 200

export const RECORD_TYPE_DEFAULT = 'KVBlob'
export const VALUE_FIELD = 'value'

/** CloudKit's documented per-record ceiling, excluding assets. */
export const MAX_RECORD_BYTES = 1024 * 1024

interface CloudKitRecordResult {
  recordName?: string
  fields?: Record<string, { value?: unknown }>
  serverErrorCode?: string
  reason?: string
  retryAfter?: number
  serverRecord?: { fields?: Record<string, { value?: unknown }>; recordChangeTag?: string }
  /** Epoch millis. CloudKit returns this on every lookup without being asked. */
  modified?: { timestamp?: number }
  /**
   * The record's version. Passing it back on a save turns a blind overwrite
   * into a conditional one - see {@link CloudKitRestClient.saveRecord}.
   */
  recordChangeTag?: string
}

interface CloudKitResponse {
  records?: CloudKitRecordResult[]
  zones?: { zoneID?: { zoneName?: string } }[]
  /**
   * Top-level error fields. Critically, an `AUTHENTICATION_REQUIRED` response is
   * HTTP 421 carrying these at the ROOT with **no `records` array** - so any
   * check that looks for the error inside `records` can never fire. cryptoc's
   * implementation had exactly that bug: its auth handling was unreachable, so
   * an expired token was never cleared and every read and write silently
   * no-opped forever.
   */
  serverErrorCode?: string
  reason?: string
  retryAfter?: number
  redirectURL?: string
  /** Set when a query has more results than one response can carry. */
  continuationMarker?: string
  /** Present only on an `/assets/upload` response. */
  tokens?: { recordName?: string; fieldName?: string; url?: string }[]
}

/**
 * CloudKit codes that all mean "the record is already there".
 *
 * `ATOMIC_ERROR` is included because an atomic batch reports a failed operation
 * at the top level rather than per record.
 */
const EXISTS_CODES = new Set(['EXISTS', 'CONFLICT', 'ATOMIC_ERROR'])

function isAlreadyExists(e: unknown): boolean {
  if (!(e instanceof CloudSyncError)) return false
  if (e.serverErrorCode != null) return EXISTS_CODES.has(e.serverErrorCode)
  return e.code === ErrorCode.CONFLICT
}

/** How long a reachability answer is reused. See {@link CloudKitRestClient.isReachable}. */
const REACHABILITY_TTL_MS = 30_000

/** Record name used only to prove the container is reachable and authenticated. */
const AVAILABILITY_PROBE_RECORD = '__rncs_availability_probe__'

export class CloudKitRestClient {
  private readonly config: CloudKitRestConfig
  private reachability: { at: number; ok: boolean } | null = null

  constructor(config: CloudKitRestConfig) {
    this.config = config
  }

  private baseUrl(): string {
    const { containerIdentifier, environment } = this.config
    return `https://api.apple-cloudkit.com/database/1/${containerIdentifier}/${environment}/private`
  }

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch
  }

  private async requireAuthToken(): Promise<string> {
    if (!this.config.apiToken)
      throw new CloudSyncError(
        ErrorCode.CONTAINER_MISCONFIGURED,
        '[RNCloudSync] No CloudKit API token configured. Create a Client token in the '
        + 'CloudKit Console under API Access and pass it to configureCloudKit().',
        { provider: 'cloudKit' }
      )

    const token = await this.config.getAuthToken()
    if (!token)
      throw new CloudSyncError(
        ErrorCode.NOT_SIGNED_IN,
        '[RNCloudSync] No CloudKit web auth token. The user must sign in with their '
        + 'Apple ID before the private database can be reached.',
        { provider: 'cloudKit' }
      )

    return token
  }

  private async handleAuthExpired(): Promise<void> {
    await this.config.onAuthExpired?.()
  }

  /**
   * Maps a CloudKit `serverErrorCode` onto the package's shared vocabulary.
   * Codes are from Apple's CloudKit Web Services error reference.
   */
  private async toError(
    code: string | undefined,
    reason: string | undefined,
    retryAfter: number | undefined,
    serverValue?: string | null
  ): Promise<CloudSyncError> {
    const message = `[RNCloudSync] CloudKit: ${code ?? 'unknown'}${reason ? ` - ${reason}` : ''}`
    const provider = 'cloudKit'
    const base = { provider, serverErrorCode: code }

    switch (code) {
      case 'AUTHENTICATION_REQUIRED':
      case 'AUTHENTICATION_FAILED':
        await this.handleAuthExpired()
        return new CloudSyncError(ErrorCode.AUTH_EXPIRED, message, base)
      case 'ACCESS_DENIED':
        await this.handleAuthExpired()
        return new CloudSyncError(ErrorCode.AUTH_EXPIRED, message, base)
      case 'QUOTA_EXCEEDED':
        return new CloudSyncError(ErrorCode.QUOTA_EXCEEDED, message, base)
      case 'THROTTLED':
      case 'TRY_AGAIN_LATER':
        return new CloudSyncError(ErrorCode.RATE_LIMITED, message, {
          ...base,
          retryAfterMs: retryAfter != null ? retryAfter * 1000 : undefined,
        })
      case 'CONFLICT':
        return new CloudSyncError(ErrorCode.CONFLICT, message, { ...base, serverValue })
      case 'BAD_REQUEST':
      case 'ZONE_NOT_FOUND':
        return new CloudSyncError(ErrorCode.CONTAINER_MISCONFIGURED, message, base)
      default:
        return new CloudSyncError(ErrorCode.UNKNOWN, message, base)
    }
  }

  /**
   * HTTP-status classification for a response with no CloudKit error envelope
   * of its own to inspect - `post()`'s fallback tail, and the raw asset-bytes
   * transfer, which talks to an opaque single-use upload/download URL rather
   * than a `/records/...` JSON endpoint.
   */
  private async classifyHttpStatus(status: number): Promise<CloudSyncError> {
    if (status === 401 || status === 421) {
      await this.handleAuthExpired()
      return new CloudSyncError(
        ErrorCode.AUTH_EXPIRED,
        `[RNCloudSync] CloudKit returned HTTP ${status}; the web auth token is no longer valid.`,
        { provider: 'cloudKit' }
      )
    }
    if (status === 429 || status === 503)
      return new CloudSyncError(
        ErrorCode.RATE_LIMITED,
        `[RNCloudSync] CloudKit returned HTTP ${status}.`,
        { provider: 'cloudKit' }
      )

    return new CloudSyncError(
      ErrorCode.UNKNOWN,
      `[RNCloudSync] CloudKit returned HTTP ${status}.`,
      { provider: 'cloudKit' }
    )
  }

  private async post(path: string, body: unknown): Promise<CloudKitResponse> {
    const token = await this.requireAuthToken()
    const url
      = `${this.baseUrl()}${path}`
        + `?ckAPIToken=${encodeURIComponent(this.config.apiToken)}`
        + `&ckWebAuthToken=${encodeURIComponent(token)}`

    let res: Response
    try {
      res = await withTimeout(
        this.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        'cloudKit'
      )
    }
    catch (e) {
      // A timeout is already a classified, retryable CloudSyncError; re-wrapping
      // it as a network failure would throw away the distinction.
      if (e instanceof CloudSyncError) throw e
      throw new CloudSyncError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudSync] CloudKit request failed to reach the server.',
        { provider: 'cloudKit', cause: e }
      )
    }

    const json = (await res.json().catch(() => null)) as CloudKitResponse | null

    // Top-level error dict. This is the branch cryptoc's port could never
    // reach - 421 responses carry no `records`, so an error nested-lookup misses
    // it entirely. Check the root BEFORE looking at per-record results.
    if (json?.serverErrorCode != null)
      throw await this.toError(json.serverErrorCode, json.reason, json.retryAfter)

    // HTTP-level failure with no parseable CloudKit error body.
    if (!res.ok) throw await this.classifyHttpStatus(res.status)

    return json ?? {}
  }

  async getRecord(recordName: string, recordType = RECORD_TYPE_DEFAULT): Promise<string | null> {
    return (await this.getRecordWithMeta(recordName, recordType))?.value ?? null
  }

  /**
   * A read that also returns the server's own modification time and the
   * record's change tag.
   *
   * Both come back on a plain lookup whether or not anyone asks, so surfacing
   * them costs nothing - and they are what make {@link resolveByModifiedAt} and
   * conditional writes possible without the app instrumenting its payloads.
   */
  async getRecordWithMeta(
    recordName: string,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<{ value: string; modifiedAt?: number; recordChangeTag?: string } | null> {
    void recordType
    const json = await this.post('/records/lookup', {
      records: [{ recordName }],
    })

    const record = json.records?.find(r => r.recordName === recordName) ?? json.records?.[0]
    if (record == null) return null

    if (record.serverErrorCode != null) {
      // A record that simply is not there is a normal outcome, not a failure.
      // Note the real code is NOT_FOUND - `UNKNOWN_ITEM` is a CloudKit
      // *framework* code and never appears in Web Services responses, so
      // matching on it (as cryptoc did) silently misclassifies every miss.
      if (record.serverErrorCode === 'NOT_FOUND') return null
      throw await this.toError(record.serverErrorCode, record.reason, record.retryAfter)
    }

    const value = record.fields?.[VALUE_FIELD]?.value
    if (typeof value !== 'string') return null

    return {
      value,
      modifiedAt: typeof record.modified?.timestamp === 'number'
        ? record.modified.timestamp
        : undefined,
      recordChangeTag: record.recordChangeTag,
    }
  }

  /**
   * Reads many records in one request.
   *
   * `/records/lookup` has taken an array of record ids since the API shipped,
   * so reading 200 keys one at a time was 200 round trips for no reason - and
   * 200 chances to be throttled. Results are matched back by `recordName`
   * rather than by position, because CloudKit does not promise the response
   * preserves request order.
   */
  async getRecords(
    recordNames: string[],
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<(string | null)[]> {
    void recordType
    if (recordNames.length === 0) return []

    const found = new Map<string, string>()

    for (const batch of chunk(recordNames, MAX_BATCH)) {
      const json = await this.post('/records/lookup', {
        records: batch.map(recordName => ({ recordName })),
      })

      for (const record of json.records ?? []) {
        if (record.recordName == null) continue
        if (record.serverErrorCode != null) {
          // Absent is absent, per record - one missing key must not fail the
          // whole batch the way an atomic *write* legitimately does.
          if (record.serverErrorCode === 'NOT_FOUND') continue
          throw await this.toError(record.serverErrorCode, record.reason, record.retryAfter)
        }
        const value = record.fields?.[VALUE_FIELD]?.value
        if (typeof value === 'string') found.set(record.recordName, value)
      }
    }

    return recordNames.map(name => found.get(name) ?? null)
  }

  /**
   * Writes many records in one request.
   *
   * Uses `forceUpdate`, which creates or replaces in a single operation, so
   * unlike the single-record path there is no create-then-fall-back-to-update
   * dance to repeat per key.
   *
   * `atomic: false`, deliberately: a batch is a convenience for the caller, not
   * a transaction they asked for, and one oversized record should not silently
   * discard the other 199. Per-record failures are collected and raised
   * together.
   */
  async saveRecords(
    entries: [string, string][],
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<void> {
    if (entries.length === 0) return

    for (const [recordName, value] of entries) {
      const bytes = byteLength(value)
      if (bytes > MAX_RECORD_BYTES)
        throw new CloudSyncError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          `[RNCloudSync] '${recordName}' is ${bytes} bytes; CloudKit records are limited to `
          + `${MAX_RECORD_BYTES}.`,
          { provider: 'cloudKit', limitBytes: MAX_RECORD_BYTES, actualBytes: bytes }
        )
    }

    for (const batch of chunk(entries, MAX_BATCH)) {
      const json = await this.post('/records/modify', {
        atomic: false,
        operations: batch.map(([recordName, value]) => ({
          operationType: 'forceUpdate',
          record: { recordType, recordName, fields: { [VALUE_FIELD]: { value } } },
        })),
      })

      for (const record of json.records ?? [])
        if (record.serverErrorCode != null)
          throw await this.toError(record.serverErrorCode, record.reason, record.retryAfter)
    }
  }

  /** Deletes many records in one request, with the same per-record rules. */
  async deleteRecords(recordNames: string[], recordType = RECORD_TYPE_DEFAULT): Promise<void> {
    if (recordNames.length === 0) return

    for (const batch of chunk(recordNames, MAX_BATCH)) {
      const json = await this.post('/records/modify', {
        atomic: false,
        operations: batch.map(recordName => ({
          operationType: 'forceDelete',
          record: { recordType, recordName },
        })),
      })

      for (const record of json.records ?? []) {
        if (record.serverErrorCode == null) continue
        // Deleting something that was never there is the end state the caller
        // asked for.
        if (record.serverErrorCode === 'NOT_FOUND') continue
        throw await this.toError(record.serverErrorCode, record.reason, record.retryAfter)
      }
    }
  }

  async saveRecord(
    recordName: string,
    value: string,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<void> {
    const bytes = byteLength(value)
    if (bytes > MAX_RECORD_BYTES)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Value is ${bytes} bytes; CloudKit records are limited to ${MAX_RECORD_BYTES}. `
        + `Use the store facade with tiering enabled to route large values to a CKAsset.`,
        { provider: 'cloudKit', limitBytes: MAX_RECORD_BYTES, actualBytes: bytes }
      )

    await this.saveFields(recordName, { [VALUE_FIELD]: { value } }, recordType)
  }

  /**
   * Creates `recordName`, falling back to an unconditional update when it
   * already exists - the create-then-fall-back dance every write after the
   * first one takes. Shared by {@link saveRecord} (a `value` field) and
   * {@link uploadAsset} (an Asset field plus its `__size` sidecar), which need
   * the exact same dance for a different field set.
   */
  private async saveFields(
    recordName: string,
    fields: Record<string, { value: unknown }>,
    recordType: string
  ): Promise<void> {
    const record = { recordType, recordName, fields }

    // `atomic` defaults to true server-side. Setting it explicitly documents the
    // intent and keeps behaviour stable if that default ever changes.
    let created: CloudKitResponse | null = null
    try {
      created = await this.post('/records/modify', {
        atomic: true,
        operations: [{ operationType: 'create', record }],
      })
    }
    catch (e) {
      // A create against a record that already exists is the normal path for
      // every write after the first, so it must not surface as an error. With
      // `atomic: true` CloudKit reports that at the top level, which `post`
      // turns into a throw.
      //
      // Only an already-exists response falls through to the update below.
      // Anything else - quota, auth, rate limiting, or a response this package
      // could not classify - is rethrown. Swallowing an unclassified failure
      // here and force-updating anyway would overwrite whatever is on the
      // server on the strength of an error nobody read.
      if (!isAlreadyExists(e)) throw e
    }

    const createdRecord = created?.records?.[0]
    if (created != null && createdRecord?.serverErrorCode == null) return

    if (
      createdRecord?.serverErrorCode != null
      && !EXISTS_CODES.has(createdRecord.serverErrorCode)
    )
      throw await this.toError(createdRecord.serverErrorCode, createdRecord.reason, createdRecord.retryAfter)

    // Last-write-wins, matching the native provider's `.changedKeys` save policy
    // so both platforms resolve concurrent writes identically.
    const updated = await this.post('/records/modify', {
      atomic: true,
      operations: [{ operationType: 'forceUpdate', record }],
    })
    const updatedRecord = updated.records?.[0]
    if (updatedRecord?.serverErrorCode != null) {
      const serverValue = updatedRecord.serverRecord?.fields?.[VALUE_FIELD]?.value
      throw await this.toError(
        updatedRecord.serverErrorCode,
        updatedRecord.reason,
        updatedRecord.retryAfter,
        typeof serverValue === 'string' ? serverValue : null
      )
    }
  }

  /**
   * Uploads `bytes` as `fieldName` on `recordName`, via CloudKit Web Services'
   * asset-upload protocol: request a single-use upload URL, POST the raw bytes
   * to it, then attach the descriptor it returns (plus a `__size` sidecar, so
   * a later {@link fetchAsset} can report real download progress) to the
   * record - the same create-then-update dance {@link saveRecord} uses.
   *
   * `onProgress` reports real bytes transferred, via `XMLHttpRequest` rather
   * than `fetch` - see {@link CloudKitRestConfig.xhrImpl}.
   */
  async uploadAsset(
    recordName: string,
    fieldName: string,
    bytes: Uint8Array,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<void> {
    if (bytes.length > MAX_ASSET_UPLOAD_BYTES)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Asset is ${bytes.length} bytes; CloudKit Web Services caps a single asset `
        + `upload at ${MAX_ASSET_UPLOAD_BYTES} bytes. Use the googleDrive provider for larger files `
        + `on Android and web.`,
        { provider: 'cloudKit', limitBytes: MAX_ASSET_UPLOAD_BYTES, actualBytes: bytes.length }
      )

    const uploadUrl = await this.requestAssetUploadUrl(recordType, recordName, fieldName)
    const descriptor = await this.putAssetBytes(uploadUrl, bytes, onProgress)

    await this.saveFields(recordName, {
      [fieldName]: { value: descriptor },
      [`${fieldName}__size`]: { value: bytes.length },
    }, recordType)
  }

  /**
   * Downloads the bytes behind `fieldName` on `recordName`, or `null` when the
   * record or the field's asset does not exist.
   *
   * A fetched record's Asset field carries a `downloadURL` - that is the only
   * step this needs beyond the usual record lookup; there is no separate
   * "request a download token" round trip the way upload has one.
   */
  async fetchAsset(
    recordName: string,
    fieldName: string,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<Uint8Array | null> {
    void recordType
    const json = await this.post('/records/lookup', { records: [{ recordName }] })
    const record = json.records?.find(r => r.recordName === recordName) ?? json.records?.[0]
    if (record == null) return null

    if (record.serverErrorCode != null) {
      if (record.serverErrorCode === 'NOT_FOUND') return null
      throw await this.toError(record.serverErrorCode, record.reason, record.retryAfter)
    }

    const asset = record.fields?.[fieldName]?.value as CloudKitAssetDescriptor | undefined
    if (asset?.downloadURL == null) return null

    return await this.fetchAssetBytes(asset.downloadURL, onProgress)
  }

  private async requestAssetUploadUrl(
    recordType: string, recordName: string, fieldName: string
  ): Promise<string> {
    const json = await this.post('/assets/upload', {
      tokens: [{ recordType, recordName, fieldName }],
    })

    const url = json.tokens?.[0]?.url
    if (url == null)
      throw new CloudSyncError(
        ErrorCode.UNKNOWN,
        '[RNCloudSync] CloudKit did not return an asset upload URL.',
        { provider: 'cloudKit' }
      )

    return url
  }

  private get xhr(): () => XMLHttpRequest {
    return this.config.xhrImpl ?? (() => new XMLHttpRequest())
  }

  /**
   * POSTs raw bytes to a single-use CKWS asset-upload URL, reporting real
   * upload progress via `XMLHttpRequest.upload.onprogress` - `fetch` exposes no
   * upload-progress events in React Native. Scoped to just this one call:
   * every other CloudKit REST request stays on `fetch` through `post()`, for
   * the timeout/error handling already built there.
   */
  private putAssetBytes(
    url: string,
    bytes: Uint8Array,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<CloudKitAssetDescriptor> {
    return new Promise((resolve, reject) => {
      const req = this.xhr()
      req.open('POST', url)
      req.timeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS

      req.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded, e.total)
      }

      req.onload = () => {
        if (req.status < 200 || req.status >= 300) {
          this.classifyHttpStatus(req.status).then(reject).catch(reject)
          return
        }

        try {
          const json = JSON.parse(req.responseText) as { singleFile?: CloudKitAssetDescriptor }
          if (json.singleFile == null) throw new Error('response had no singleFile')
          onProgress?.(bytes.length, bytes.length)
          resolve(json.singleFile)
        }
        catch (e) {
          reject(new CloudSyncError(
            ErrorCode.UNKNOWN,
            '[RNCloudSync] CloudKit did not return an asset descriptor after upload.',
            { provider: 'cloudKit', cause: e }
          ))
        }
      }

      req.onerror = () => reject(new CloudSyncError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudSync] CloudKit asset upload failed to reach the server.',
        { provider: 'cloudKit' }
      ))
      req.ontimeout = () => reject(timedOut(req.timeout, 'cloudKit'))

      req.send(bytes)
    })
  }

  /**
   * GETs raw bytes from a record's asset `downloadURL`, reporting real
   * download progress via `XMLHttpRequest.onprogress`, for the same reason
   * {@link putAssetBytes} uses XHR rather than `fetch`.
   *
   * Treated as self-contained, the same way the upload URL is (Apple's own
   * reference issues that one with no `ckAPIToken`/`ckWebAuthToken` at all) -
   * if that assumption is ever wrong for a download URL specifically, it
   * surfaces as an HTTP-level auth failure here rather than a silent wrong
   * answer.
   */
  private fetchAssetBytes(
    url: string,
    onProgress?: (bytesTransferred: number, bytesTotal: number) => void
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const req = this.xhr()
      req.open('GET', url)
      req.responseType = 'arraybuffer'
      req.timeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS

      req.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded, e.total)
      }

      req.onload = () => {
        if (req.status < 200 || req.status >= 300) {
          this.classifyHttpStatus(req.status).then(reject).catch(reject)
          return
        }

        const buf = req.response as ArrayBuffer
        onProgress?.(buf.byteLength, buf.byteLength)
        resolve(new Uint8Array(buf))
      }

      req.onerror = () => reject(new CloudSyncError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudSync] CloudKit asset download failed to reach the server.',
        { provider: 'cloudKit' }
      ))
      req.ontimeout = () => reject(timedOut(req.timeout, 'cloudKit'))

      req.send()
    })
  }

  /**
   * A write that fails instead of clobbering, when the server's copy has moved
   * on since `recordChangeTag` was read.
   *
   * The normal `saveRecord` is last-write-wins - the right default for the
   * common case, and what the native provider's `.changedKeys` save policy
   * does, so both platforms agree. But last-write-wins means a genuine
   * concurrent edit is destroyed silently, and `ERR_CONFLICT` carries
   * `serverValue` precisely so an app can merge instead. Without a conditional
   * write, that error could never actually fire and the merge path was
   * unreachable.
   *
   * Read the tag with {@link getRecordWithMeta}, pass it here, and handle
   * `ERR_CONFLICT` by merging `serverValue` and retrying.
   */
  async saveRecordIfUnchanged(
    recordName: string,
    value: string,
    recordChangeTag: string,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<void> {
    const bytes = byteLength(value)
    if (bytes > MAX_RECORD_BYTES)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Value is ${bytes} bytes; CloudKit records are limited to ${MAX_RECORD_BYTES}.`,
        { provider: 'cloudKit', limitBytes: MAX_RECORD_BYTES, actualBytes: bytes }
      )

    // `update` (rather than `forceUpdate`) is the conditional form: with a
    // change tag present, CloudKit rejects the write if the server's tag has
    // moved on.
    const json = await this.post('/records/modify', {
      atomic: true,
      operations: [{
        operationType: 'update',
        record: {
          recordType,
          recordName,
          recordChangeTag,
          fields: { [VALUE_FIELD]: { value } },
        },
      }],
    })

    const result = json.records?.[0]
    if (result?.serverErrorCode == null) return

    const serverValue = result.serverRecord?.fields?.[VALUE_FIELD]?.value
    throw await this.toError(
      result.serverErrorCode,
      result.reason,
      result.retryAfter,
      typeof serverValue === 'string' ? serverValue : null
    )
  }

  async deleteRecord(recordName: string, recordType = RECORD_TYPE_DEFAULT): Promise<void> {
    const json = await this.post('/records/modify', {
      atomic: true,
      operations: [
        { operationType: 'forceDelete', record: { recordType, recordName } },
      ],
    })
    const result = json.records?.[0]
    if (result?.serverErrorCode == null) return
    // Deleting something that was never there is a success from the caller's
    // point of view - the desired end state already holds.
    if (result.serverErrorCode === 'NOT_FOUND') return
    throw await this.toError(result.serverErrorCode, result.reason, result.retryAfter)
  }

  async queryRecordNames(recordType = RECORD_TYPE_DEFAULT): Promise<string[]> {
    const names: string[] = []
    const seenMarkers = new Set<string>()
    let continuationMarker: string | undefined

    // `/records/query` caps a response at 200 records and hands back a
    // continuation marker for the rest. Taking only the first page silently
    // truncated `getAllKeys()`, and `migrate()` is built on `getAllKeys()` - so
    // it showed up as a migration that quietly copied part of the data and
    // reported success.
    do {
      const json: CloudKitResponse = await this.post('/records/query', {
        query: { recordType },
        ...(continuationMarker != null ? { continuationMarker } : {}),
      })

      for (const record of json.records ?? [])
        if (typeof record.recordName === 'string') names.push(record.recordName)

      continuationMarker = json.continuationMarker
      // A server that repeats a marker would loop forever; stop instead.
      if (continuationMarker != null) {
        if (seenMarkers.has(continuationMarker)) break
        seenMarkers.add(continuationMarker)
      }
    } while (continuationMarker != null)

    return names
  }

  /**
   * Cheap reachability check backing the provider's `isAvailable()`.
   *
   * The probe itself is a network round trip, but `isAvailable()` is documented
   * as safe on a render path and the store calls it before every provider read -
   * so unmemoised, each `getItem` on Android or web cost two requests instead of
   * one. Held briefly: long enough to collapse that pair, short enough that a
   * token expiring mid-session is noticed.
   */
  async isReachable(): Promise<boolean> {
    const now = Date.now()
    if (this.reachability != null && now - this.reachability.at < REACHABILITY_TTL_MS)
      return this.reachability.ok

    let ok: boolean
    try {
      // A `null` result and a NOT_FOUND both mean reachable and authenticated;
      // only a thrown auth/network/config error means unavailable.
      await this.getRecord(AVAILABILITY_PROBE_RECORD)
      ok = true
    }
    catch {
      ok = false
    }

    this.reachability = { at: now, ok }
    return ok
  }

  /**
   * Drops the memoised reachability answer.
   *
   * Called on an account switch: that answer was recorded for the previous
   * user's web auth token and says nothing about the new one.
   */
  clearCache(): void {
    this.reachability = null
  }
}

/** Splits `items` into runs of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Re-exported from its own module so the tiering and key-validation paths can
// use it without importing a REST client. Kept exported here because it has
// been part of this module's surface since the first release.
export { byteLength } from './bytes'
