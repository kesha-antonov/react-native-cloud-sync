import CloudKit
import Foundation

/// The error vocabulary, kept identical to `src/errors.ts` and to the Kotlin
/// side. These strings are public API - apps branch on them.
@objc public class CloudSyncErrorCode: NSObject {
    @objc public static let notSignedIn = "ERR_NOT_SIGNED_IN"
    @objc public static let accountRestricted = "ERR_ACCOUNT_RESTRICTED"
    @objc public static let accountUnavailable = "ERR_ACCOUNT_UNAVAILABLE"
    @objc public static let accountUndetermined = "ERR_ACCOUNT_UNDETERMINED"
    @objc public static let authExpired = "ERR_AUTH_EXPIRED"
    @objc public static let networkUnavailable = "ERR_NETWORK_UNAVAILABLE"
    @objc public static let quotaExceeded = "ERR_QUOTA_EXCEEDED"
    @objc public static let rateLimited = "ERR_RATE_LIMITED"
    @objc public static let payloadTooLarge = "ERR_PAYLOAD_TOO_LARGE"
    @objc public static let conflict = "ERR_CONFLICT"
    @objc public static let containerMisconfigured = "ERR_CONTAINER_MISCONFIGURED"
    @objc public static let unsupportedPlatform = "ERR_UNSUPPORTED_PLATFORM"
    @objc public static let cancelled = "ERR_CANCELLED"
    @objc public static let unknown = "ERR_UNKNOWN"
}

enum CloudSyncError: Error {
    case coded(code: String, message: String, info: [String: Any])

    var code: String {
        switch self {
        case let .coded(code, _, _): return code
        }
    }

    var message: String {
        switch self {
        case let .coded(_, message, _): return message
        }
    }

    var info: [String: Any] {
        switch self {
        case let .coded(_, _, info): return info
        }
    }

    /// Bridges to an `NSError` so `reject(code, message, error)` carries the
    /// extra fields (`retryAfterMs`, `limitBytes`, ...) into JS `userInfo`.
    var asNSError: NSError {
        var userInfo: [String: Any] = info
        userInfo[NSLocalizedDescriptionKey] = message
        return NSError(domain: "RNCloudSync", code: 0, userInfo: userInfo)
    }

    static func from(_ error: Error) -> CloudSyncError {
        if let already = error as? CloudSyncError { return already }
        guard let ckError = error as? CKError else {
            return .coded(
                code: CloudSyncErrorCode.unknown,
                message: error.localizedDescription,
                info: [:]
            )
        }
        return fromCKError(ckError)
    }

    /// Maps CloudKit's error codes onto the shared vocabulary.
    ///
    /// The mapping matters more than it looks: collapsing these into one failure
    /// (or into `nil`) is what makes a signed-out user indistinguishable from an
    /// empty backup, which is the defect this whole package exists to avoid.
    static func fromCKError(_ error: CKError) -> CloudSyncError {
        var info: [String: Any] = [:]
        if let retryAfter = error.userInfo[CKErrorRetryAfterKey] as? Double {
            info["retryAfterMs"] = retryAfter * 1000
        }

        switch error.code {
        case .notAuthenticated:
            return .coded(
                code: CloudSyncErrorCode.notSignedIn,
                message: "No iCloud account is signed in on this device.",
                info: info
            )
        case .managedAccountRestricted, .permissionFailure:
            return .coded(
                code: CloudSyncErrorCode.accountRestricted,
                message: "This iCloud account is restricted from using CloudKit.",
                info: info
            )
        case .networkUnavailable, .networkFailure, .serviceUnavailable:
            return .coded(
                code: CloudSyncErrorCode.networkUnavailable,
                message: "Could not reach iCloud: \(error.localizedDescription)",
                info: info
            )
        case .quotaExceeded:
            return .coded(
                code: CloudSyncErrorCode.quotaExceeded,
                message: "The iCloud account is out of storage.",
                info: info
            )
        case .requestRateLimited, .zoneBusy:
            return .coded(
                code: CloudSyncErrorCode.rateLimited,
                message: "CloudKit is rate limiting requests.",
                info: info
            )
        case .limitExceeded:
            return .coded(
                code: CloudSyncErrorCode.payloadTooLarge,
                message: "The record exceeds CloudKit's size limit.",
                info: info
            )
        case .serverRecordChanged:
            if let server = error.userInfo[CKRecordChangedErrorServerRecordKey] as? CKRecord,
               let value = server[CloudSyncImpl.valueField] as? String {
                info["serverValue"] = value
            }
            return .coded(
                code: CloudSyncErrorCode.conflict,
                message: "A newer version of this record exists on the server.",
                info: info
            )
        case .badContainer, .missingEntitlement, .badDatabase:
            return .coded(
                code: CloudSyncErrorCode.containerMisconfigured,
                message: "CloudKit container or entitlement problem: \(error.localizedDescription)",
                info: info
            )
        case .operationCancelled:
            return .coded(
                code: CloudSyncErrorCode.cancelled,
                message: "The CloudKit operation was cancelled.",
                info: info
            )
        default:
            return .coded(
                code: CloudSyncErrorCode.unknown,
                message: error.localizedDescription,
                info: info
            )
        }
    }
}
