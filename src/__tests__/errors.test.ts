import {
  CloudStorageError,
  ErrorCode,
  isCloudStorageError,
  isRetryable,
  normalizeError,
  requiresUserAction,
} from '../errors'

describe('CloudStorageError', () => {
  it('keeps instanceof working after the ES5 Error downlevel', () => {
    const e = new CloudStorageError(ErrorCode.NOT_SIGNED_IN, 'nope')
    expect(e).toBeInstanceOf(CloudStorageError)
    expect(e).toBeInstanceOf(Error)
  })

  it('recognises a plain bridged object, not just a real instance', () => {
    // The bridge does not preserve the prototype on every path, so the guard
    // has to test shape rather than identity.
    const bridged = { code: 'ERR_QUOTA_EXCEEDED', message: 'full' }
    expect(isCloudStorageError(bridged)).toBe(true)
    expect(isCloudStorageError({ code: 'SOMETHING_ELSE' })).toBe(false)
    expect(isCloudStorageError(null)).toBe(false)
  })
})

describe('normalizeError', () => {
  it('preserves the native code and coerces stringified numbers', () => {
    // iOS userInfo dictionaries arrive with numbers as strings.
    const native = { code: 'ERR_RATE_LIMITED', message: 'slow down', retryAfterMs: '2500' }
    const e = normalizeError(native, 'cloudKit')
    expect(e.code).toBe(ErrorCode.RATE_LIMITED)
    expect(e.retryAfterMs).toBe(2500)
    expect(e.provider).toBe('cloudKit')
  })

  it('never swallows an unrecognised failure', () => {
    const e = normalizeError(new Error('boom'), 'googleDrive')
    expect(e.code).toBe(ErrorCode.UNKNOWN)
    expect(e.message).toBe('boom')
    expect(e.cause).toBeInstanceOf(Error)
  })
})

describe('error classification', () => {
  it.each([
    [ErrorCode.NETWORK_UNAVAILABLE, true],
    [ErrorCode.RATE_LIMITED, true],
    [ErrorCode.NOT_SIGNED_IN, false],
    [ErrorCode.QUOTA_EXCEEDED, false],
  ])('isRetryable(%s) === %s', (code, expected) => {
    expect(isRetryable(new CloudStorageError(code, 'x'))).toBe(expected)
  })

  it.each([
    [ErrorCode.NOT_SIGNED_IN, true],
    [ErrorCode.AUTH_EXPIRED, true],
    [ErrorCode.QUOTA_EXCEEDED, true],
    [ErrorCode.NETWORK_UNAVAILABLE, false],
  ])('requiresUserAction(%s) === %s', (code, expected) => {
    expect(requiresUserAction(new CloudStorageError(code, 'x'))).toBe(expected)
  })
})
