/**
 * The error vocabulary shared verbatim by iOS (Swift), Android (Kotlin), the
 * REST clients and the web build.
 *
 * Why this exists at all: every React Native cloud library surveyed before this
 * one collapses distinct failures into `null` or into a bare `false`, and two of
 * them go further and report a *failed write as a success*. That is not a
 * hypothetical - it is the single most repeated defect in this problem space:
 *
 *   - jacobp100/react-native-cloudkit-storage's `setItem` checks the enclosing
 *     `error` variable instead of the operation's own `operationError`, so a
 *     quota-exceeded or not-signed-in write resolves successfully.
 *   - cryptoc's in-app CloudKit module discarded the `Result` handed to
 *     `modifyRecordsResultBlock` entirely, with the same outcome.
 *
 * The rule that prevents both, and that every provider in this package obeys:
 *
 *   `null` is returned for exactly one condition - the key genuinely does not
 *   exist. Every other outcome rejects with a `CloudSyncError` carrying a
 *   stable `code`.
 */

/**
 * Stable, cross-platform failure codes.
 *
 * These strings are duplicated in `ios/CloudSyncError.swift` - the only other
 * place that raises them, since Android and web reach CloudKit and Drive over
 * REST from this same TypeScript. They are part of the public API: apps branch
 * on them, so treat a change here as a breaking change.
 */
export const ErrorCode = {
  /** No iCloud/Drive account is signed in on the device. */
  NOT_SIGNED_IN: 'ERR_NOT_SIGNED_IN',
  /** An account exists but is restricted (parental controls, MDM). */
  ACCOUNT_RESTRICTED: 'ERR_ACCOUNT_RESTRICTED',
  /** CloudKit reported `.temporarilyUnavailable` - retry later. */
  ACCOUNT_UNAVAILABLE: 'ERR_ACCOUNT_UNAVAILABLE',
  /** CloudKit could not determine account status. Not the same as signed out. */
  ACCOUNT_UNDETERMINED: 'ERR_ACCOUNT_UNDETERMINED',
  /** A previously valid credential expired. On Android CloudKit this is routine: */
  /** a `ckWebAuthToken` lives 30 minutes, or 2 weeks if the user ticked */
  /** "Keep me signed in". There is no documented refresh - re-auth is required. */
  AUTH_EXPIRED: 'ERR_AUTH_EXPIRED',
  /** Device is offline, or the request could not reach the server. */
  NETWORK_UNAVAILABLE: 'ERR_NETWORK_UNAVAILABLE',
  /** The user's iCloud/Drive storage is full. */
  QUOTA_EXCEEDED: 'ERR_QUOTA_EXCEEDED',
  /** Server asked us to back off. Carries `retryAfterMs` when the server said so. */
  RATE_LIMITED: 'ERR_RATE_LIMITED',
  /** Value exceeds the backing store's limit. Carries `limitBytes`/`actualBytes`. */
  PAYLOAD_TOO_LARGE: 'ERR_PAYLOAD_TOO_LARGE',
  /**
   * The key cannot round-trip through the configured providers - illegal
   * characters, too long, or a reserved prefix. Raised before the request, so
   * it never reaches the server as a confusing `BAD_REQUEST`.
   */
  INVALID_KEY: 'ERR_INVALID_KEY',
  /** The operation ran longer than the configured timeout. */
  TIMEOUT: 'ERR_TIMEOUT',
  /** A concurrent write won. Carries `serverValue` so the app can merge. */
  CONFLICT: 'ERR_CONFLICT',
  /** Entitlements, container identifier or API token are missing or wrong. */
  CONTAINER_MISCONFIGURED: 'ERR_CONTAINER_MISCONFIGURED',
  /** This provider has no implementation on the current platform. */
  UNSUPPORTED_PLATFORM: 'ERR_UNSUPPORTED_PLATFORM',
  /** The operation was cancelled by the caller. */
  CANCELLED: 'ERR_CANCELLED',
  /** Anything the native layer could not classify. `cause` holds the original. */
  UNKNOWN: 'ERR_UNKNOWN',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

const ALL_CODES: readonly string[] = Object.values(ErrorCode)

export interface CloudSyncErrorInfo {
  /** Milliseconds to wait before retrying. Set on {@link ErrorCode.RATE_LIMITED}. */
  retryAfterMs?: number
  /** The store's size limit in bytes. Set on {@link ErrorCode.PAYLOAD_TOO_LARGE}. */
  limitBytes?: number
  /** The rejected payload's size in bytes. Set on {@link ErrorCode.PAYLOAD_TOO_LARGE}. */
  actualBytes?: number
  /** The value currently on the server. Set on {@link ErrorCode.CONFLICT}. */
  serverValue?: string | null
  /** Which provider raised this. */
  provider?: string
  /**
   * The backend's own error code, when there was one - e.g. CloudKit Web
   * Services' `EXISTS` or `ATOMIC_ERROR`. Useful for diagnosing a response
   * that this package classified as `ERR_UNKNOWN`.
   */
  serverErrorCode?: string
  /** The underlying native or network error, when there was one. */
  cause?: unknown
}

/**
 * The single error type every operation in this package rejects with.
 *
 * `instanceof` is deliberately not the recommended check - a rejected promise
 * crossing the React Native bridge arrives as a plain object on some paths, so
 * {@link isCloudSyncError} tests the shape instead.
 */
export class CloudSyncError extends Error implements CloudSyncErrorInfo {
  readonly code: ErrorCode
  readonly retryAfterMs?: number
  readonly limitBytes?: number
  readonly actualBytes?: number
  readonly serverValue?: string | null
  readonly provider?: string
  readonly serverErrorCode?: string
  readonly cause?: unknown

  constructor(code: ErrorCode, message: string, info: CloudSyncErrorInfo = {}) {
    super(message)
    this.name = 'CloudSyncError'
    this.code = code
    this.retryAfterMs = info.retryAfterMs
    this.limitBytes = info.limitBytes
    this.actualBytes = info.actualBytes
    this.serverValue = info.serverValue
    this.provider = info.provider
    this.serverErrorCode = info.serverErrorCode
    this.cause = info.cause

    // Restore the prototype chain: TypeScript's ES5 downlevel of `extends Error`
    // otherwise leaves `instanceof CloudSyncError` false.
    Object.setPrototypeOf(this, CloudSyncError.prototype)
  }
}

/** Narrowing guard that works on both real instances and bridged plain objects. */
export function isCloudSyncError(e: unknown): e is CloudSyncError {
  if (e == null || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' && ALL_CODES.includes(code)
}

/**
 * True when retrying the same call later could plausibly succeed.
 *
 * TIMEOUT is in this set because running out of time says nothing about whether
 * the operation is possible - only that this attempt took too long.
 */
export function isRetryable(e: unknown): boolean {
  if (!isCloudSyncError(e)) return false
  switch (e.code) {
    case ErrorCode.NETWORK_UNAVAILABLE:
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.ACCOUNT_UNAVAILABLE:
    case ErrorCode.ACCOUNT_UNDETERMINED:
    case ErrorCode.TIMEOUT:
      return true
    default:
      return false
  }
}

/** True when the user must take an action (sign in, free up space) to proceed. */
export function requiresUserAction(e: unknown): boolean {
  if (!isCloudSyncError(e)) return false
  switch (e.code) {
    case ErrorCode.NOT_SIGNED_IN:
    case ErrorCode.AUTH_EXPIRED:
    case ErrorCode.QUOTA_EXCEEDED:
    case ErrorCode.ACCOUNT_RESTRICTED:
      return true
    default:
      return false
  }
}

/**
 * Normalises whatever the native layer rejected with into a `CloudSyncError`.
 *
 * React Native's bridge turns `reject(code, message, nativeError)` into an Error
 * whose `code` is the string we chose natively, so the common path is a simple
 * re-wrap. Anything unrecognised becomes {@link ErrorCode.UNKNOWN} rather than
 * being swallowed.
 */
export function normalizeError(e: unknown, provider?: string): CloudSyncError {
  if (e instanceof CloudSyncError) return e

  if (isCloudSyncError(e)) {
    const raw = e as unknown as CloudSyncErrorInfo & { message?: string; userInfo?: unknown }
    const nested = nestedInfo(raw.userInfo)
    return new CloudSyncError(e.code, raw.message ?? e.code, {
      retryAfterMs: numeric(raw.retryAfterMs ?? nested.retryAfterMs),
      limitBytes: numeric(raw.limitBytes ?? nested.limitBytes),
      actualBytes: numeric(raw.actualBytes ?? nested.actualBytes),
      serverValue: raw.serverValue ?? nested.serverValue,
      provider: raw.provider ?? nested.provider ?? provider,
      serverErrorCode: raw.serverErrorCode ?? nested.serverErrorCode,
      cause: e,
    })
  }

  const message = e instanceof Error ? e.message : String(e)
  return new CloudSyncError(ErrorCode.UNKNOWN, message, { provider, cause: e })
}

/**
 * The extra fields a native rejection carries, which live one level down.
 *
 * React Native builds the JS error from `reject(code, message, nsError)` with
 * `Object.assign(new Error(message), errorData)`, and `errorData` keeps the
 * `NSError`'s dictionary intact under a nested `userInfo` key rather than
 * spreading it. So everything `CloudSyncError.asNSError` attaches on iOS -
 * `retryAfterMs`, `limitBytes`, `actualBytes`, `serverValue` - arrives as
 * `e.userInfo.limitBytes`, never as `e.limitBytes`.
 *
 * Reading only the top level is why CloudKit's `retryAfter` hint never reached
 * the outbox's backoff, and why a CONFLICT's `serverValue` - documented as the
 * thing that lets an app merge - was always undefined on iOS.
 */
function nestedInfo(userInfo: unknown): CloudSyncErrorInfo {
  if (userInfo == null || typeof userInfo !== 'object') return {}
  return userInfo
}

/**
 * The bridge stringifies numbers on some paths (`userInfo` dictionaries on iOS
 * arrive as strings), so coerce rather than trusting the declared type.
 */
function numeric(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * True when the caller asked for this - a cancelled operation is not a fault to
 * report, and a UI that shows an error toast for one is wrong.
 */
export function isCancelled(e: unknown): boolean {
  return isCloudSyncError(e) && e.code === ErrorCode.CANCELLED
}

/** The rejection an aborted operation produces. */
export function cancelled(provider?: string, detail = 'The operation was cancelled.'): CloudSyncError {
  return new CloudSyncError(ErrorCode.CANCELLED, `[RNCloudSync] ${detail}`, { provider })
}

/** The rejection a timed-out operation produces. */
export function timedOut(ms: number, provider?: string): CloudSyncError {
  return new CloudSyncError(
    ErrorCode.TIMEOUT,
    `[RNCloudSync] The request did not complete within ${ms}ms.`,
    { provider }
  )
}

/** Convenience constructor for the platform-capability guards. */
export function unsupportedPlatform(provider: string, detail: string): CloudSyncError {
  return new CloudSyncError(
    ErrorCode.UNSUPPORTED_PLATFORM,
    `[RNCloudSync] ${provider} is not available on this platform: ${detail}`,
    { provider }
  )
}
