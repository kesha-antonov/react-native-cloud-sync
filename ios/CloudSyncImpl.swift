import CloudKit
import Foundation

/// All CloudKit and NSUbiquitousKeyValueStore logic.
///
/// The ObjC++ bridge (`RNCloudSync.mm`) is deliberately thin - it only
/// adapts between the two React Native architectures and forwards here. Keeping
/// the real work in Swift is what makes CloudKit's async API tolerable; the
/// same logic in Objective-C is a completion-block pyramid.
@objc public class CloudSyncImpl: NSObject {
    @objc public static let shared = CloudSyncImpl()

    static let recordTypeDefault = "KVBlob"
    static let valueField = "value"

    /// CloudKit's documented per-record ceiling, excluding assets.
    static let maxRecordBytes = 1024 * 1024

    private var logsEnabled = false

    /// Emits (eventName, payload) to whichever architecture is listening. The
    /// bridge installs this; until it does, events are buffered (see below).
    ///
    /// `@objc` is required. Swift does not expose members to Objective-C
    /// automatically just because the class is `@objc` and inherits NSObject,
    /// so without it the bridge fails to compile with "property 'emit' not
    /// found on object of type 'CloudSyncImpl *'".
    @objc public var emit: ((String, [String: Any]) -> Void)?

    /// Opaque identity of the bridge instance that installed `emit`.
    ///
    /// React Native holds two module instances briefly across a reload: the
    /// replacement installs its callback, and only then does the outgoing one
    /// dealloc. Without an identity check that dealloc tore down the *new*
    /// instance's callback and removed its notification observers, so remote
    /// change and account events stopped firing until the next reload.
    ///
    /// A raw pointer rather than a reference on purpose: `strong` would keep the
    /// bridge module alive forever behind this singleton, and `weak` is already
    /// nil by the time that module's `dealloc` runs - which is precisely where
    /// the comparison has to happen. It is only ever compared, never
    /// dereferenced.
    @objc public var emitOwner: UnsafeMutableRawPointer?

    private let kvStore = NSUbiquitousKeyValueStore.default

    /// Resolved once. `CKContainer(identifier:)` is not free, and the previous
    /// in-app implementation this replaces rebuilt it on every single call.
    private lazy var container: CKContainer? = {
        guard let identifier = Self.resolveContainerIdentifier() else { return nil }
        return CKContainer(identifier: identifier)
    }()

    private var database: CKDatabase? { container?.privateCloudDatabase }

    // MARK: - Configuration

    /// The container id declared in the bundle's entitlement listing, if it is
    /// readable at all. `nil` means "could not confirm", never "definitely
    /// absent" - entitlements live in the code signature, and the API that reads
    /// those (`SecTaskCopyValueForEntitlement`) is not public on iOS.
    static func declaredContainerIdentifier() -> String? {
        guard let ids = Bundle.main.object(
            forInfoDictionaryKey: "com.apple.developer.icloud-container-identifiers"
        ) as? [String] else { return nil }
        return ids.first
    }

    /// Reads the container id straight out of the app's entitlements, so apps do
    /// not have to repeat it in JavaScript and cannot get the two out of sync.
    static func resolveContainerIdentifier() -> String? {
        if let declared = declaredContainerIdentifier() { return declared }
        // Entitlements are not in Info.plist on a device build; fall back to the
        // conventional `iCloud.<bundle id>` form.
        guard let bundleId = Bundle.main.bundleIdentifier else { return nil }
        return "iCloud.\(bundleId)"
    }

    @objc public func getConstants() -> [String: Any] {
        return [
            "containerIdentifier": Self.resolveContainerIdentifier() ?? "",
            // Derived from the DECLARED identifier, not the resolved one.
            // `resolveContainerIdentifier` falls back to `iCloud.<bundle id>`
            // whenever the declaration is unreadable, so deriving this from it
            // made the constant `true` for every app that has a bundle id -
            // including one with no iCloud capability at all, which is exactly
            // the case a caller reads this to detect. It is a confirmation, not
            // a guarantee: false means "not confirmed here", and the async
            // account-status path is the authoritative check.
            "hasICloudEntitlement": Self.declaredContainerIdentifier() != nil,
        ]
    }

    @objc public func setLogsEnabled(_ enabled: Bool) {
        logsEnabled = enabled
    }

    private func log(_ message: String) {
        guard logsEnabled else { return }
        NSLog("[RNCloudSync] %@", message)
    }

    // MARK: - Observers

    /// Starts observing the two notifications that every library in this space
    /// either ignores or crashes on.
    @objc public func startObserving() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(kvStoreDidChange(_:)),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: kvStore
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(identityDidChange(_:)),
            name: .NSUbiquityIdentityDidChange,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(ckAccountDidChange(_:)),
            name: .CKAccountChanged,
            object: nil
        )
        // Pull down anything already waiting so a cold start sees remote data.
        kvStore.synchronize()
    }

    @objc public func stopObserving() {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func kvStoreDidChange(_ note: Notification) {
        let userInfo = note.userInfo ?? [:]
        let keys = userInfo[NSUbiquitousKeyValueStoreChangedKeysKey] as? [String] ?? []
        let rawReason = userInfo[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int

        let reason: String
        switch rawReason {
        case NSUbiquitousKeyValueStoreServerChange: reason = "serverChange"
        case NSUbiquitousKeyValueStoreInitialSyncChange: reason = "initialSync"
        case NSUbiquitousKeyValueStoreQuotaViolationChange: reason = "quotaViolation"
        case NSUbiquitousKeyValueStoreAccountChange: reason = "accountChange"
        default: reason = "unknown"
        }

        log("kv changed externally: \(reason), \(keys.count) key(s)")
        emit?("remoteChange", ["keys": keys, "reason": reason, "provider": "icloudKV"])
    }

    @objc private func identityDidChange(_ note: Notification) {
        // The event nobody handles. A different Apple ID is now signed in, so
        // any user-scoped state the app cached belongs to the previous user.
        log("iCloud identity changed")
        accountStatusString { status in
            self.emit?("accountChange", [
                "status": status,
                "identityChanged": true,
                "provider": "icloudKV",
            ])
        }
    }

    @objc private func ckAccountDidChange(_ note: Notification) {
        accountStatusString { status in
            self.emit?("accountChange", [
                "status": status,
                "identityChanged": false,
                "provider": "cloudKit",
            ])
        }
    }

    // MARK: - Account

    private func accountStatusString(_ completion: @escaping (String) -> Void) {
        guard let container = container else {
            completion("couldNotDetermine")
            return
        }
        container.accountStatus { status, _ in
            switch status {
            case .available: completion("available")
            case .noAccount: completion("noAccount")
            case .restricted: completion("restricted")
            case .temporarilyUnavailable: completion("temporarilyUnavailable")
            case .couldNotDetermine: completion("couldNotDetermine")
            @unknown default: completion("couldNotDetermine")
            }
        }
    }

    @objc public func getAccountStatus(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        accountStatusString { resolve($0) }
    }

    @objc public func isAvailable(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        accountStatusString { resolve($0 == "available") }
    }

    // MARK: - Key-value store

    @objc public func kvGetItem(
        _ key: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        // `nil` here genuinely means absent - NSUbiquitousKeyValueStore has no
        // failure mode for a read - so returning it is not the silent-failure
        // anti-pattern this package is built to avoid.
        resolve(kvStore.string(forKey: key))
    }

    @objc public func kvSetItem(
        _ key: String,
        value: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        let bytes = value.lengthOfBytes(using: .utf8)
        // Apple's per-key ceiling is 1 MB. Enforce it here with a typed error
        // rather than letting the write vanish server-side with no signal.
        if bytes > 1024 * 1024 {
            let error = CloudSyncError.coded(
                code: CloudSyncErrorCode.payloadTooLarge,
                message: "Value is \(bytes) bytes; the iCloud key-value store allows 1048576 per key.",
                info: ["limitBytes": 1024 * 1024, "actualBytes": bytes]
            )
            reject(error.code, error.message, error.asNSError)
            return
        }

        kvStore.set(value, forKey: key)
        // Schedules an upload; it does NOT confirm one. Callers are told this in
        // the JS docs so nobody reads a resolved promise as "stored in iCloud".
        kvStore.synchronize()
        resolve(nil)
    }

    @objc public func kvRemoveItem(
        _ key: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        kvStore.removeObject(forKey: key)
        kvStore.synchronize()
        resolve(nil)
    }

    @objc public func kvGetAllKeys(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        resolve(Array(kvStore.dictionaryRepresentation.keys))
    }

    @objc public func kvSync(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        resolve(kvStore.synchronize())
    }

    // MARK: - CloudKit records

    private func requireDatabase() throws -> CKDatabase {
        guard let database = database else {
            throw CloudSyncError.coded(
                code: CloudSyncErrorCode.containerMisconfigured,
                message: "No iCloud container is configured. Add the iCloud capability and a "
                    + "CloudKit container to the app target's entitlements.",
                info: [:]
            )
        }
        return database
    }

    private func recordID(_ recordName: String, _ zoneName: String?) -> CKRecord.ID {
        guard let zoneName = zoneName else { return CKRecord.ID(recordName: recordName) }
        let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
        return CKRecord.ID(recordName: recordName, zoneID: zoneID)
    }

    @objc public func ckGetRecord(
        _ recordType: String,
        recordName: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            database.fetch(withRecordID: recordID(recordName, zoneName)) { record, error in
                if let error = error {
                    // A missing record is a normal outcome, not a failure - but
                    // it must be distinguished from every other error, which is
                    // exactly what a blanket `catch { return nil }` destroys.
                    if let ckError = error as? CKError, ckError.code == .unknownItem {
                        resolve(nil)
                        return
                    }
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                    return
                }
                resolve(record?[Self.valueField] as? String)
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    @objc public func ckSaveRecord(
        _ recordType: String,
        recordName: String,
        value: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        let bytes = value.lengthOfBytes(using: .utf8)
        if bytes > Self.maxRecordBytes {
            let error = CloudSyncError.coded(
                code: CloudSyncErrorCode.payloadTooLarge,
                message: "Value is \(bytes) bytes; CloudKit records are limited to \(Self.maxRecordBytes). "
                    + "Use the store facade with tiering enabled to route large values to a CKAsset.",
                info: ["limitBytes": Self.maxRecordBytes, "actualBytes": bytes]
            )
            reject(error.code, error.message, error.asNSError)
            return
        }

        do {
            let database = try requireDatabase()
            let id = recordID(recordName, zoneName)
            let record = CKRecord(recordType: recordType, recordID: id)
            record[Self.valueField] = value as CKRecordValue

            let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
            // Last-write-wins, matching the REST client so both platforms
            // resolve concurrent writes the same way. `.ifServerRecordUnchanged`
            // would fail routine two-device writes on a change-tag conflict.
            operation.savePolicy = .changedKeys

            operation.modifyRecordsResultBlock = { result in
                // Inspecting this result is the entire point. Discarding it -
                // which both cryptoc's module and jacobp100's library did - turns
                // every failed write into a reported success.
                switch result {
                case .success:
                    resolve(nil)
                case let .failure(error):
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
            database.add(operation)
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    @objc public func ckDeleteRecord(
        _ recordName: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            database.delete(withRecordID: recordID(recordName, zoneName)) { _, error in
                if let error = error {
                    // Already gone is the desired end state.
                    if let ckError = error as? CKError, ckError.code == .unknownItem {
                        resolve(true)
                        return
                    }
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                    return
                }
                resolve(true)
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    @objc public func ckQueryRecordNames(
        _ recordType: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            let zoneID = zoneName.map {
                CKRecordZone.ID(zoneName: $0, ownerName: CKCurrentUserDefaultName)
            }

            var names: [String] = []

            // CKQueryOperation returns one page of results and hands back a
            // cursor for the rest. Resolving on the first page silently
            // truncated getAllKeys(), and migrate() is built on getAllKeys() -
            // so it surfaced as a migration that quietly copied part of the
            // data and reported success. Follow the cursor to exhaustion.
            func run(_ operation: CKQueryOperation) {
                operation.zoneID = zoneID
                operation.desiredKeys = []
                operation.recordMatchedBlock = { recordID, result in
                    if case .success = result { names.append(recordID.recordName) }
                }
                operation.queryResultBlock = { result in
                    switch result {
                    case let .success(cursor):
                        guard let cursor = cursor else {
                            resolve(names)
                            return
                        }
                        run(CKQueryOperation(cursor: cursor))
                    case let .failure(error):
                        let mapped = CloudSyncError.from(error)
                        reject(mapped.code, mapped.message, mapped.asNSError)
                    }
                }
                database.add(operation)
            }

            let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
            run(CKQueryOperation(query: query))
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    // MARK: - Zones

    @objc public func ckCreateZone(
        _ zoneName: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            let zone = CKRecordZone(zoneName: zoneName)
            let operation = CKModifyRecordZonesOperation(recordZonesToSave: [zone], recordZoneIDsToDelete: nil)
            operation.modifyRecordZonesResultBlock = { result in
                switch result {
                case .success:
                    resolve(nil)
                case let .failure(error):
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
            database.add(operation)
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    @objc public func ckDeleteZone(
        _ zoneName: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)
            let operation = CKModifyRecordZonesOperation(recordZonesToSave: nil, recordZoneIDsToDelete: [zoneID])
            operation.modifyRecordZonesResultBlock = { result in
                switch result {
                case .success:
                    resolve(nil)
                case let .failure(error):
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
            database.add(operation)
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    // MARK: - Assets

    /// Uploads a local file as a CKAsset field.
    ///
    /// This is what makes values above the 1 MB record ceiling storable at all.
    /// No library surveyed does this: `react-native-icloud-kit` cannot store
    /// binary data (its field type is `string | number | null`), and
    /// react-native-cloud-storage left binary support open for 15 months, during
    /// which a user reported running out of memory base64-encoding files above
    /// 20 MB by hand.
    @objc public func ckSaveAsset(
        _ recordType: String,
        recordName: String,
        fieldName: String,
        fileUri: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            let fileURL = Self.fileURL(from: fileUri)

            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                let error = CloudSyncError.coded(
                    code: CloudSyncErrorCode.unknown,
                    message: "No file at \(fileURL.path)",
                    info: [:]
                )
                reject(error.code, error.message, error.asNSError)
                return
            }

            let id = recordID(recordName, zoneName)
            let record = CKRecord(recordType: recordType, recordID: id)
            record[fieldName] = CKAsset(fileURL: fileURL)

            let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
            operation.savePolicy = .changedKeys

            // Progress is per-record; forward it so callers can drive a bar
            // instead of guessing. react-native-cloud-storage reports a single
            // global number with no file identity, which cannot be attributed
            // when more than one upload is in flight.
            // Sized once, not per callback - the progress block fires often.
            let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
            let totalBytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0

            operation.perRecordProgressBlock = { [weak self] _, progress in
                self?.emit?("assetProgress", [
                    "recordName": recordName,
                    "fieldName": fieldName,
                    "bytesTransferred": Int(progress * Double(totalBytes)),
                    "bytesTotal": totalBytes,
                ])
            }

            operation.modifyRecordsResultBlock = { result in
                switch result {
                case .success:
                    resolve(nil)
                case let .failure(error):
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
            database.add(operation)
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    /// Downloads a CKAsset field and resolves the local file path it landed at,
    /// or nil when the record or field does not exist.
    @objc public func ckFetchAsset(
        _ recordName: String,
        fieldName: String,
        zoneName: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            database.fetch(withRecordID: recordID(recordName, zoneName)) { record, error in
                if let error = error {
                    if let ckError = error as? CKError, ckError.code == .unknownItem {
                        resolve(nil)
                        return
                    }
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                    return
                }
                guard let asset = record?[fieldName] as? CKAsset,
                      let url = asset.fileURL else {
                    resolve(nil)
                    return
                }

                // CloudKit stores the download in a temporary location it may
                // reclaim, so copy it somewhere the caller controls before
                // handing back a path.
                let destination = FileManager.default.temporaryDirectory
                    .appendingPathComponent("rncs-\(recordName)-\(fieldName)")
                do {
                    if FileManager.default.fileExists(atPath: destination.path) {
                        try FileManager.default.removeItem(at: destination)
                    }
                    try FileManager.default.copyItem(at: url, to: destination)
                    resolve(destination.absoluteString)
                } catch {
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    /// Accepts both `file://` URLs and bare paths, since callers pass whichever
    /// their file-system library produced.
    static func fileURL(from uri: String) -> URL {
        if uri.hasPrefix("file://"), let url = URL(string: uri) { return url }
        return URL(fileURLWithPath: uri)
    }

    @objc public func ckListZones(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            database.fetchAllRecordZones { zones, error in
                if let error = error {
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                    return
                }
                resolve((zones ?? []).map { $0.zoneID.zoneName })
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }
}
