import { CloudStorageError, ErrorCode } from '../errors'

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
}

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
  serverRecord?: { fields?: Record<string, { value?: unknown }> }
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
}

/**
 * CloudKit codes that all mean "the record is already there".
 *
 * `ATOMIC_ERROR` is included because an atomic batch reports a failed operation
 * at the top level rather than per record.
 */
const EXISTS_CODES = new Set(['EXISTS', 'CONFLICT', 'ATOMIC_ERROR'])

function isAlreadyExists(e: unknown): boolean {
  if (!(e instanceof CloudStorageError)) return false
  if (e.serverErrorCode != null) return EXISTS_CODES.has(e.serverErrorCode)
  return e.code === ErrorCode.CONFLICT
}

export class CloudKitRestClient {
  private readonly config: CloudKitRestConfig

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
      throw new CloudStorageError(
        ErrorCode.CONTAINER_MISCONFIGURED,
        '[RNCloudStorage] No CloudKit API token configured. Create a Client token in the '
        + 'CloudKit Console under API Access and pass it to configureCloudKit().',
        { provider: 'cloudKit' }
      )

    const token = await this.config.getAuthToken()
    if (!token)
      throw new CloudStorageError(
        ErrorCode.NOT_SIGNED_IN,
        '[RNCloudStorage] No CloudKit web auth token. The user must sign in with their '
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
  ): Promise<CloudStorageError> {
    const message = `[RNCloudStorage] CloudKit: ${code ?? 'unknown'}${reason ? ` - ${reason}` : ''}`
    const provider = 'cloudKit'
    const base = { provider, serverErrorCode: code }

    switch (code) {
      case 'AUTHENTICATION_REQUIRED':
      case 'AUTHENTICATION_FAILED':
        await this.handleAuthExpired()
        return new CloudStorageError(ErrorCode.AUTH_EXPIRED, message, base)
      case 'ACCESS_DENIED':
        await this.handleAuthExpired()
        return new CloudStorageError(ErrorCode.AUTH_EXPIRED, message, base)
      case 'QUOTA_EXCEEDED':
        return new CloudStorageError(ErrorCode.QUOTA_EXCEEDED, message, base)
      case 'THROTTLED':
      case 'TRY_AGAIN_LATER':
        return new CloudStorageError(ErrorCode.RATE_LIMITED, message, {
          ...base,
          retryAfterMs: retryAfter != null ? retryAfter * 1000 : undefined,
        })
      case 'CONFLICT':
        return new CloudStorageError(ErrorCode.CONFLICT, message, { ...base, serverValue })
      case 'BAD_REQUEST':
      case 'ZONE_NOT_FOUND':
        return new CloudStorageError(ErrorCode.CONTAINER_MISCONFIGURED, message, base)
      default:
        return new CloudStorageError(ErrorCode.UNKNOWN, message, base)
    }
  }

  private async post(path: string, body: unknown): Promise<CloudKitResponse> {
    const token = await this.requireAuthToken()
    const url
      = `${this.baseUrl()}${path}`
        + `?ckAPIToken=${encodeURIComponent(this.config.apiToken)}`
        + `&ckWebAuthToken=${encodeURIComponent(token)}`

    let res: Response
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    catch (e) {
      throw new CloudStorageError(
        ErrorCode.NETWORK_UNAVAILABLE,
        '[RNCloudStorage] CloudKit request failed to reach the server.',
        { provider: 'cloudKit', cause: e }
      )
    }

    const json = (await res.json().catch(() => null)) as CloudKitResponse | null

    // Top-level error dict. This is the branch cryptoc's port could never
    // reach - 421 responses carry no `records`, so an error nested-lookup misses
    // it entirely. Check the root BEFORE looking at per-record results.
    if (json?.serverErrorCode != null)
      throw await this.toError(json.serverErrorCode, json.reason, json.retryAfter)

    if (!res.ok) {
      // HTTP-level failure with no parseable CloudKit error body.
      if (res.status === 401 || res.status === 421) {
        await this.handleAuthExpired()
        throw new CloudStorageError(
          ErrorCode.AUTH_EXPIRED,
          `[RNCloudStorage] CloudKit returned HTTP ${res.status}; the web auth token is no longer valid.`,
          { provider: 'cloudKit' }
        )
      }
      if (res.status === 429 || res.status === 503)
        throw new CloudStorageError(
          ErrorCode.RATE_LIMITED,
          `[RNCloudStorage] CloudKit returned HTTP ${res.status}.`,
          { provider: 'cloudKit' }
        )

      throw new CloudStorageError(
        ErrorCode.UNKNOWN,
        `[RNCloudStorage] CloudKit returned HTTP ${res.status}.`,
        { provider: 'cloudKit' }
      )
    }

    return json ?? {}
  }

  async getRecord(recordName: string, recordType = RECORD_TYPE_DEFAULT): Promise<string | null> {
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
    return typeof value === 'string' ? value : null
  }

  async saveRecord(
    recordName: string,
    value: string,
    recordType = RECORD_TYPE_DEFAULT
  ): Promise<void> {
    const bytes = byteLength(value)
    if (bytes > MAX_RECORD_BYTES)
      throw new CloudStorageError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudStorage] Value is ${bytes} bytes; CloudKit records are limited to ${MAX_RECORD_BYTES}. `
        + `Use the store facade with tiering enabled to route large values to a CKAsset.`,
        { provider: 'cloudKit', limitBytes: MAX_RECORD_BYTES, actualBytes: bytes }
      )

    const record = {
      recordType,
      recordName,
      fields: { [VALUE_FIELD]: { value } },
    }

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
    const json = await this.post('/records/query', {
      query: { recordType },
    })
    return (json.records ?? [])
      .map(r => r.recordName)
      .filter((n): n is string => typeof n === 'string')
  }
}

/**
 * UTF-8 byte length.
 *
 * `String.length` counts UTF-16 code units, which under-reports for any
 * non-ASCII payload - the exact way a "just under the limit" value turns into a
 * server-side rejection.
 */
export function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length

  return unescape(encodeURIComponent(s)).length
}
