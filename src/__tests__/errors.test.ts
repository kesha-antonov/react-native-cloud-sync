import {
  CloudSyncError,
  ErrorCode,
  isCloudSyncError,
  isRetryable,
  normalizeError,
  requiresUserAction,
} from '../errors'

describe('CloudSyncError', () => {
  it('keeps instanceof working after the ES5 Error downlevel', () => {
    const e = new CloudSyncError(ErrorCode.NOT_SIGNED_IN, 'nope')
    expect(e).toBeInstanceOf(CloudSyncError)
    expect(e).toBeInstanceOf(Error)
  })

  it('recognises a plain bridged object, not just a real instance', () => {
    // The bridge does not preserve the prototype on every path, so the guard
    // has to test shape rather than identity.
    const bridged = { code: 'ERR_QUOTA_EXCEEDED', message: 'full' }
    expect(isCloudSyncError(bridged)).toBe(true)
    expect(isCloudSyncError({ code: 'SOMETHING_ELSE' })).toBe(false)
    expect(isCloudSyncError(null)).toBe(false)
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
    expect(isRetryable(new CloudSyncError(code, 'x'))).toBe(expected)
  })

  it.each([
    [ErrorCode.NOT_SIGNED_IN, true],
    [ErrorCode.AUTH_EXPIRED, true],
    [ErrorCode.QUOTA_EXCEEDED, true],
    [ErrorCode.NETWORK_UNAVAILABLE, false],
  ])('requiresUserAction(%s) === %s', (code, expected) => {
    expect(requiresUserAction(new CloudSyncError(code, 'x'))).toBe(expected)
  })
})

describe('normalizeError and the bridge shape', () => {
  // React Native builds the JS error with
  // `Object.assign(new Error(message), errorData)`, and `errorData` keeps the
  // NSError dictionary nested under `userInfo` rather than spreading it. Reading
  // only the top level meant every field the native layer attaches was dropped.
  it('reads the fields iOS nests under userInfo', () => {
    const bridged = Object.assign(new Error('too big'), {
      code: 'ERR_PAYLOAD_TOO_LARGE',
      userInfo: { limitBytes: 1048576, actualBytes: 2097152 },
    })

    const e = normalizeError(bridged, 'cloudKit')

    expect(e.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE)
    expect(e.limitBytes).toBe(1048576)
    expect(e.actualBytes).toBe(2097152)
  })

  it('carries a CONFLICT serverValue up from userInfo so the app can merge', () => {
    // Documented as the whole point of the CONFLICT code, and undefined on iOS
    // for as long as the nested dictionary went unread.
    const bridged = Object.assign(new Error('newer on server'), {
      code: 'ERR_CONFLICT',
      userInfo: { serverValue: '{"text":"theirs"}' },
    })

    expect(normalizeError(bridged).serverValue).toBe('{"text":"theirs"}')
  })

  it('coerces a stringified retry hint out of userInfo', () => {
    const bridged = Object.assign(new Error('slow down'), {
      code: 'ERR_RATE_LIMITED',
      userInfo: { retryAfterMs: '90000' },
    })

    expect(normalizeError(bridged).retryAfterMs).toBe(90_000)
  })

  it('prefers a top-level field over the nested copy', () => {
    const bridged = Object.assign(new Error('slow down'), {
      code: 'ERR_RATE_LIMITED',
      retryAfterMs: 1000,
      userInfo: { retryAfterMs: 90_000 },
    })

    expect(normalizeError(bridged).retryAfterMs).toBe(1000)
  })

  it('is unbothered by a userInfo that is not an object', () => {
    const bridged = { code: 'ERR_UNKNOWN', message: 'x', userInfo: 'nope' }
    expect(normalizeError(bridged).code).toBe(ErrorCode.UNKNOWN)
  })
})
