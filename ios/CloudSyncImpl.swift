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

    /// Where an asset's byte count is stashed alongside it, so a download can
    /// learn the total size before the transfer starts. `CKAsset` itself
    /// exposes no size until its bytes have already landed locally.
    static func sizeField(_ fieldName: String) -> String { "\(fieldName)__size" }

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

    /// Apple's three documented ceilings for `NSUbiquitousKeyValueStore`.
    ///
    /// All three are enforced before the write, not discovered after it. The
    /// per-key one is the obvious one; the other two are the ones that actually
    /// bite in practice, and neither produces an error at the call site - the
    /// store simply stops accepting data and reports a
    /// `NSUbiquitousKeyValueStoreQuotaViolationChange` notification later, by
    /// which point the caller has long since been told the write succeeded.
    static let kvMaxBytesPerKey = 1024 * 1024
    static let kvMaxTotalBytes = 1024 * 1024
    static let kvMaxKeys = 1024

    /// UTF-8 size of everything currently in the store, and how many keys.
    ///
    /// Only string and data values are measured; the store also accepts numbers
    /// and booleans, whose contribution is negligible next to a payload and
    /// which have no meaningful byte length to ask for.
    private func kvUsage(excluding key: String?) -> (bytes: Int, keys: Int) {
        var bytes = 0
        let all = kvStore.dictionaryRepresentation
        for (existingKey, existingValue) in all {
            if existingKey == key { continue }
            if let text = existingValue as? String {
                bytes += text.lengthOfBytes(using: .utf8)
            } else if let data = existingValue as? Data {
                bytes += data.count
            }
        }
        return (bytes, all.count)
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
        if bytes > Self.kvMaxBytesPerKey {
            let error = CloudSyncError.coded(
                code: CloudSyncErrorCode.payloadTooLarge,
                message: "Value is \(bytes) bytes; the iCloud key-value store allows "
                    + "\(Self.kvMaxBytesPerKey) per key.",
                info: ["limitBytes": Self.kvMaxBytesPerKey, "actualBytes": bytes]
            )
            reject(error.code, error.message, error.asNSError)
            return
        }

        let isNewKey = kvStore.object(forKey: key) == nil
        let usage = kvUsage(excluding: key)

        // The 1 MB *total* is the limit that actually bites: a handful of large
        // values silently starves every other key, and the only signal is a
        // quota-violation notification that arrives long after the write was
        // reported as successful.
        let projected = usage.bytes + bytes
        if projected > Self.kvMaxTotalBytes {
            let error = CloudSyncError.coded(
                code: CloudSyncErrorCode.quotaExceeded,
                message: "This write would put the iCloud key-value store at \(projected) bytes, "
                    + "over its \(Self.kvMaxTotalBytes)-byte total. Route larger values to "
                    + "CloudKit or Drive - the store facade's tiering does this for you.",
                info: ["limitBytes": Self.kvMaxTotalBytes, "actualBytes": projected]
            )
            reject(error.code, error.message, error.asNSError)
            return
        }

        if isNewKey && usage.keys >= Self.kvMaxKeys {
            let error = CloudSyncError.coded(
                code: CloudSyncErrorCode.quotaExceeded,
                message: "The iCloud key-value store already holds \(usage.keys) keys, its "
                    + "documented maximum of \(Self.kvMaxKeys).",
                info: ["limitBytes": Self.kvMaxKeys, "actualBytes": usage.keys + 1]
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

    /// Every key and value in one call.
    ///
    /// `dictionaryRepresentation` is already in memory, so this is one bridge
    /// hop where `kvGetAllKeys` + N `kvGetItem` calls would be N+1. Non-string
    /// values are skipped rather than coerced: the store accepts numbers, dates
    /// and data, and stringifying those would hand back something that does not
    /// round-trip through `kvSetItem`.
    @objc public func kvGetAllItems(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        var items: [String: String] = [:]
        for (key, value) in kvStore.dictionaryRepresentation {
            if let text = value as? String { items[key] = text }
        }
        resolve(items)
    }

    @objc public func kvSync(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        resolve(kvStore.synchronize())
    }

    /// How full the key-value store is, against its documented ceilings.
    ///
    /// Apple exposes no usage API, so this is measured from
    /// `dictionaryRepresentation` - which is a local plist, not a network call,
    /// so it is cheap enough to read on demand. Without it an app can only find
    /// out it is near the 1 MB total by hitting it, and hitting it is silent.
    @objc public func kvGetUsage(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        let usage = kvUsage(excluding: nil)
        resolve([
            "usedBytes": usage.bytes,
            "totalBytes": Self.kvMaxTotalBytes,
            "keyCount": usage.keys,
            "maxKeys": Self.kvMaxKeys,
        ])
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

    /// Reads the value field, from the encrypted or the plain side of the record.
    ///
    /// A field is one or the other, never both: CloudKit records encryption in
    /// the schema, so a field written through `encryptedValues` is invisible to
    /// the plain subscript and vice versa. Reading the wrong side returns nil,
    /// which would look exactly like a missing record - hence the flag rather
    /// than trying both and hoping.
    private static func readValue(_ record: CKRecord?, encrypted: Bool) -> String? {
        guard let record = record else { return nil }
        return encrypted
            ? record.encryptedValues[Self.valueField] as? String
            : record[Self.valueField] as? String
    }

    @objc public func ckGetRecord(
        _ recordType: String,
        recordName: String,
        zoneName: String?,
        encrypted: Bool,
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
                resolve(Self.readValue(record, encrypted: encrypted))
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    /// - Parameter encrypted: write through `CKRecord.encryptedValues`, so the
    ///   value is end-to-end encrypted by CloudKit itself. The key lives in the
    ///   user's iCloud Keychain and never reaches Apple's servers, which also
    ///   means no server-side path - including CloudKit Web Services, and so
    ///   this package's Android and web support - can ever read it back.
    @objc public func ckSaveRecord(
        _ recordType: String,
        recordName: String,
        value: String,
        zoneName: String?,
        encrypted: Bool,
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
            if encrypted {
                record.encryptedValues[Self.valueField] = value as CKRecordValue
            } else {
                record[Self.valueField] = value as CKRecordValue
            }

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

    /// In-flight asset transfers, keyed by record+field, so one can be
    /// cancelled by name.
    ///
    /// A `CKOperation` is cancellable, but only if someone kept a reference to
    /// it. Without this the `ERR_CANCELLED` code in the shared error vocabulary
    /// had no way of ever being produced, and a user who started a 500 MB
    /// backup by mistake had to wait it out or kill the app.
    private var activeAssetOperations: [String: CKOperation] = [:]
    private let assetOperationLock = NSLock()

    private static func transferKey(_ recordName: String, _ fieldName: String) -> String {
        return "\(recordName)\u{0}\(fieldName)"
    }

    private func trackOperation(_ operation: CKOperation, recordName: String, fieldName: String) {
        assetOperationLock.lock()
        activeAssetOperations[Self.transferKey(recordName, fieldName)] = operation
        assetOperationLock.unlock()
    }

    private func untrackOperation(recordName: String, fieldName: String) {
        assetOperationLock.lock()
        activeAssetOperations.removeValue(forKey: Self.transferKey(recordName, fieldName))
        assetOperationLock.unlock()
    }

    /// Cancels an in-flight `ckSaveAsset`/`ckFetchAsset`.
    ///
    /// Resolves true when there was something to cancel. The cancelled
    /// operation's own promise rejects with `ERR_CANCELLED`, since CloudKit
    /// surfaces the cancellation as `CKError.operationCancelled`, which the
    /// error mapper already recognises.
    @objc public func ckCancelAsset(
        _ recordName: String,
        fieldName: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        assetOperationLock.lock()
        let operation = activeAssetOperations.removeValue(forKey: Self.transferKey(recordName, fieldName))
        assetOperationLock.unlock()

        guard let operation = operation else {
            resolve(false)
            return
        }
        operation.cancel()
        resolve(true)
    }

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

            // Sized once, not per callback - the progress block fires often.
            let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
            let totalBytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0

            // Stored alongside the asset so `ckFetchAsset` can learn the size
            // before it starts downloading, and report real progress from the
            // first callback instead of only once the transfer completes -
            // CKAsset itself exposes no size until its bytes have landed.
            record[Self.sizeField(fieldName)] = totalBytes as CKRecordValue

            let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
            operation.savePolicy = .changedKeys

            // Progress is per-record; forward it so callers can drive a bar
            // instead of guessing. react-native-cloud-storage reports a single
            // global number with no file identity, which cannot be attributed
            // when more than one upload is in flight.
            operation.perRecordProgressBlock = { [weak self] _, progress in
                self?.emit?("assetProgress", [
                    "recordName": recordName,
                    "fieldName": fieldName,
                    "bytesTransferred": Int(progress * Double(totalBytes)),
                    "bytesTotal": totalBytes,
                ])
            }

            operation.modifyRecordsResultBlock = { [weak self] result in
                self?.untrackOperation(recordName: recordName, fieldName: fieldName)
                switch result {
                case .success:
                    resolve(nil)
                case let .failure(error):
                    // A cancelled operation arrives here as
                    // CKError.operationCancelled, which the mapper turns into
                    // ERR_CANCELLED - so `ckCancelAsset` needs no special case.
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            }
            trackOperation(operation, recordName: recordName, fieldName: fieldName)
            database.add(operation)
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    /// Downloads a CKAsset field and resolves the local file path it landed at,
    /// or nil when the record or field does not exist.
    ///
    /// Uses `CKFetchRecordsOperation` rather than `database.fetch(withRecordID:)`
    /// so the download reports progress the same way `ckSaveAsset` does - a
    /// plain completion-handler fetch gives no callback until the whole asset
    /// (which may be hundreds of MB) has already landed on disk. It first makes
    /// a cheap metadata-only request for the size field `ckSaveAsset` stashes
    /// next to the asset, so progress is reported in real bytes from the very
    /// first callback rather than jumping from 0 to 100% at the end - `CKAsset`
    /// itself exposes no size until its bytes have already landed.
    /// - Parameter destinationUri: where to put the downloaded bytes. Pass nil
    ///   for a temporary path this module chooses.
    ///
    ///   Worth passing for anything the user is going to keep or hand to a
    ///   share sheet: the default lands in `NSTemporaryDirectory`, which iOS
    ///   may reclaim at any time, under a name the caller did not choose. That
    ///   is fine for "restore straight back into the app" and wrong for
    ///   "export my data", which is the case that needs a real path.
    @objc public func ckFetchAsset(
        _ recordName: String,
        fieldName: String,
        zoneName: String?,
        destinationUri: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        do {
            let database = try requireDatabase()
            let id = recordID(recordName, zoneName)

            fetchKnownSize(database: database, id: id, fieldName: fieldName) { [weak self] knownSize in
                self?.fetchAsset(
                    database: database, id: id, recordName: recordName, fieldName: fieldName,
                    knownSize: knownSize, destinationUri: destinationUri,
                    resolve: resolve, reject: reject
                )
            }
        } catch {
            let mapped = CloudSyncError.from(error)
            reject(mapped.code, mapped.message, mapped.asNSError)
        }
    }

    /// Best-effort lookup of the size `ckSaveAsset` stored alongside the asset.
    /// Never fails the caller - a missing size (an asset saved before this
    /// field existed, or any other error) just means progress falls back to
    /// reporting 0 until the transfer completes.
    private func fetchKnownSize(
        database: CKDatabase,
        id: CKRecord.ID,
        fieldName: String,
        completion: @escaping (Int) -> Void
    ) {
        let operation = CKFetchRecordsOperation(recordIDs: [id])
        operation.desiredKeys = [Self.sizeField(fieldName)]

        // Best-effort means exactly one call to `completion`, from whichever
        // block actually fires - never zero. Only `perRecordResultBlock` was
        // wired here, but CloudKit does not always get that far: a failure at
        // the OPERATION level (no signed-in account, before evaluating a
        // single record) fires the operation-level completion block instead
        // and never touches `perRecordResultBlock` at all. Without a fallback
        // there, `completion` was silently never called - which means
        // `ckFetchAsset`'s continuation into `fetchAsset` never runs, and the
        // whole promise hangs forever with no error, no timeout, and no way
        // for the caller to tell a stuck restore from a slow one.
        var settled = false
        let settle = { (size: Int) in
            if settled { return }
            settled = true
            completion(size)
        }

        operation.perRecordResultBlock = { _, result in
            guard case let .success(record) = result,
                  let size = record[Self.sizeField(fieldName)] as? Int else {
                settle(0)
                return
            }
            settle(size)
        }
        operation.fetchRecordsResultBlock = { _ in
            // Only reaches here without having settled when no per-record
            // block fired at all - the operation-level failure case.
            settle(0)
        }
        database.add(operation)
    }

    private func fetchAsset(
        database: CKDatabase,
        id: CKRecord.ID,
        recordName: String,
        fieldName: String,
        knownSize: Int,
        destinationUri: String?,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        let operation = CKFetchRecordsOperation(recordIDs: [id])
        var totalBytes = knownSize

        operation.perRecordProgressBlock = { [weak self] _, progress in
            guard let self = self, progress > 0 else { return }
            self.emit?("assetProgress", [
                "recordName": recordName,
                "fieldName": fieldName,
                "bytesTransferred": Int(progress * Double(totalBytes)),
                "bytesTotal": totalBytes,
            ])
        }

        operation.perRecordResultBlock = { [weak self] _, result in
            switch result {
            case let .success(record):
                guard let asset = record[fieldName] as? CKAsset,
                      let url = asset.fileURL else {
                    resolve(nil)
                    return
                }

                if totalBytes == 0 {
                    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
                    totalBytes = (attributes?[.size] as? NSNumber)?.intValue ?? 0
                }
                self?.emit?("assetProgress", [
                    "recordName": recordName,
                    "fieldName": fieldName,
                    "bytesTransferred": totalBytes,
                    "bytesTotal": totalBytes,
                ])

                // CloudKit stores the download in a temporary location it
                // may reclaim, so copy it somewhere the caller controls
                // before handing back a path.
                let destination = destinationUri.map { Self.fileURL(from: $0) }
                    ?? FileManager.default.temporaryDirectory
                        .appendingPathComponent("rncs-\(recordName)-\(fieldName)")
                do {
                    // Create the parent directory when the caller named a path
                    // inside one that does not exist yet - a copy into a missing
                    // directory fails, and making them create it first would be
                    // a pointless extra step in every export flow.
                    let parent = destination.deletingLastPathComponent()
                    if !FileManager.default.fileExists(atPath: parent.path) {
                        try FileManager.default.createDirectory(
                            at: parent, withIntermediateDirectories: true
                        )
                    }
                    if FileManager.default.fileExists(atPath: destination.path) {
                        try FileManager.default.removeItem(at: destination)
                    }
                    try FileManager.default.copyItem(at: url, to: destination)
                    resolve(destination.absoluteString)
                } catch {
                    let mapped = CloudSyncError.from(error)
                    reject(mapped.code, mapped.message, mapped.asNSError)
                }
            case let .failure(error):
                if let ckError = error as? CKError, ckError.code == .unknownItem {
                    resolve(nil)
                    return
                }
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }

        operation.fetchRecordsResultBlock = { [weak self] result in
            self?.untrackOperation(recordName: recordName, fieldName: fieldName)
            if case let .failure(error) = result {
                // A per-record failure already resolved/rejected above; this
                // only fires for operation-level failures (e.g. the record
                // simply not existing surfaces here rather than per-record
                // on some CloudKit versions), so guard against double-resolving.
                if let ckError = error as? CKError, ckError.code == .unknownItem {
                    resolve(nil)
                    return
                }
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }

        trackOperation(operation, recordName: recordName, fieldName: fieldName)
        database.add(operation)
    }

    /// Accepts both `file://` URLs and bare paths, since callers pass whichever
    /// their file-system library produced.
    static func fileURL(from uri: String) -> URL {
        if uri.hasPrefix("file://"), let url = URL(string: uri) { return url }
        return URL(fileURLWithPath: uri)
    }

    // MARK: - iCloud Drive documents
    //
    // The ubiquity container's `Documents` directory: real files, in the user's
    // own iCloud Drive, visible in Files.app when the app declares
    // `NSUbiquitousContainers` with `NSUbiquitousContainerIsDocumentScopePublic`.
    //
    // Distinct from everything else in this file, and worth being clear about
    // why both exist. A `CKAsset` lives in the app's private CloudKit database:
    // the user cannot see it, open it, or hand it to another app. That is right
    // for an internal backup blob and wrong for an export the user asked for.
    // "Save my file where I can find it" is the single most common iCloud
    // request in mobile apps and no `CKRecord` API can answer it.

    /// The container root. Blocking - Apple documents this as slow enough that
    /// it must not be called on the main thread, so every caller here hops to a
    /// background queue first.
    private func ubiquityContainerURL() -> URL? {
        return FileManager.default.url(
            forUbiquityContainerIdentifier: Self.resolveContainerIdentifier()
        )
    }

    /// The user-visible subdirectory. Only `Documents` is ever exposed in
    /// Files.app; anything written beside it stays hidden from the user, which
    /// would defeat the point of this API.
    private func documentsURL() throws -> URL {
        guard let container = ubiquityContainerURL() else {
            throw CloudSyncError.coded(
                code: CloudSyncErrorCode.containerMisconfigured,
                message: "No iCloud Drive container is available. Check the iCloud capability, "
                    + "the iCloud Documents service, and that the user is signed in.",
                info: [:]
            )
        }
        let documents = container.appendingPathComponent("Documents", isDirectory: true)
        if !FileManager.default.fileExists(atPath: documents.path) {
            try FileManager.default.createDirectory(
                at: documents, withIntermediateDirectories: true
            )
        }
        return documents
    }

    /// True when the device has a usable iCloud Drive container right now.
    @objc public func docIsAvailable(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            resolve(self?.ubiquityContainerURL() != nil)
        }
    }

    /// Copies a local file into iCloud Drive under `name`, replacing whatever
    /// was there, and resolves the resulting iCloud path.
    ///
    /// Upload happens in the background, managed by the system: once the file is
    /// in the container, iOS syncs it whether or not the app is running. So a
    /// resolved promise means "handed to iCloud", not "in the cloud" - the same
    /// distinction `kvSync` carries, and callers are told so in the JS docs.
    @objc public func docSave(
        _ fileUri: String,
        name: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let source = Self.fileURL(from: fileUri)
                guard FileManager.default.fileExists(atPath: source.path) else {
                    throw CloudSyncError.coded(
                        code: CloudSyncErrorCode.unknown,
                        message: "No file at \(source.path)",
                        info: [:]
                    )
                }

                let destination = try self.documentsURL().appendingPathComponent(name)

                // Coordinated, because iCloud Drive files are shared with the
                // system daemon and with other processes. An uncoordinated write
                // can be interleaved with a sync and produce a corrupt file.
                var coordinationError: NSError?
                var writeError: Error?
                NSFileCoordinator().coordinate(
                    writingItemAt: destination,
                    options: .forReplacing,
                    error: &coordinationError
                ) { url in
                    do {
                        if FileManager.default.fileExists(atPath: url.path) {
                            try FileManager.default.removeItem(at: url)
                        }
                        try FileManager.default.copyItem(at: source, to: url)
                    } catch {
                        writeError = error
                    }
                }

                if let error = coordinationError ?? writeError { throw error }
                resolve(destination.absoluteString)
            } catch {
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }
    }

    /// Ensures `name` is downloaded locally and resolves its path, or nil when
    /// there is no such file.
    ///
    /// A file in iCloud Drive may exist as a placeholder with no local bytes -
    /// the user has it, this device does not. Reading it without downloading
    /// first yields an empty or missing file, which is the trap this method
    /// exists to close: it asks for the download, then waits for the status to
    /// become `.current` before answering.
    @objc public func docFetch(
        _ name: String,
        destinationUri: String?,
        timeoutMs: NSNumber,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let source = try self.documentsURL().appendingPathComponent(name)

                guard FileManager.default.fileExists(atPath: source.path)
                    || self.placeholderExists(for: source) else {
                    resolve(nil)
                    return
                }

                try FileManager.default.startDownloadingUbiquitousItem(at: source)

                let deadline = Date().addingTimeInterval(timeoutMs.doubleValue / 1000)
                while !self.isDownloaded(source) {
                    if Date() >= deadline {
                        throw CloudSyncError.coded(
                            code: CloudSyncErrorCode.timeout,
                            message: "'\(name)' did not finish downloading from iCloud Drive in "
                                + "\(timeoutMs.intValue)ms. It is still downloading in the "
                                + "background; try again shortly.",
                            info: [:]
                        )
                    }
                    // Polled rather than driven by NSMetadataQuery: a query needs
                    // a live run loop, and this method is deliberately callable
                    // from a background queue. The cost is that progress is not
                    // reported byte by byte - see the JS docs, which say so
                    // rather than inventing a number.
                    Thread.sleep(forTimeInterval: 0.25)
                }

                guard let destinationUri = destinationUri else {
                    resolve(source.absoluteString)
                    return
                }

                // Copy out of the container when the caller named a destination,
                // so they get a file the system will not later evict.
                let destination = Self.fileURL(from: destinationUri)
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }

                var coordinationError: NSError?
                var copyError: Error?
                NSFileCoordinator().coordinate(
                    readingItemAt: source, options: [], error: &coordinationError
                ) { url in
                    do {
                        try FileManager.default.copyItem(at: url, to: destination)
                    } catch {
                        copyError = error
                    }
                }
                if let error = coordinationError ?? copyError { throw error }

                resolve(destination.absoluteString)
            } catch {
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }
    }

    /// Whether the local copy is current, i.e. safe to read.
    private func isDownloaded(_ url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
        guard let status = values?.ubiquitousItemDownloadingStatus else {
            // Not a ubiquitous item at all - a plain local file, already usable.
            return FileManager.default.fileExists(atPath: url.path)
        }
        return status == .current
    }

    /// A not-yet-downloaded item is on disk as a hidden `.name.icloud` stub, so
    /// "the file does not exist" and "the file exists but is not here yet" have
    /// to be told apart before reporting an absence.
    private func placeholderExists(for url: URL) -> Bool {
        let placeholder = url
            .deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).icloud")
        return FileManager.default.fileExists(atPath: placeholder.path)
    }

    /// Everything in the app's iCloud Drive folder, including items that exist
    /// in the account but have no local copy on this device yet.
    @objc public func docList(
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let documents = try self.documentsURL()
                let entries = try FileManager.default.contentsOfDirectory(
                    at: documents,
                    includingPropertiesForKeys: [
                        .fileSizeKey,
                        .ubiquitousItemDownloadingStatusKey,
                        .ubiquitousItemIsDownloadingKey,
                    ],
                    options: []
                )

                var seen = Set<String>()
                var result: [[String: Any]] = []

                for url in entries {
                    // Fold the hidden placeholder back onto the name it stands
                    // for, so a caller sees one entry per file rather than two
                    // and never sees a `.icloud` name it cannot ask for.
                    let name = Self.displayName(for: url)
                    if seen.contains(name) { continue }
                    seen.insert(name)

                    let values = try? url.resourceValues(forKeys: [
                        .fileSizeKey,
                        .ubiquitousItemDownloadingStatusKey,
                        .ubiquitousItemIsDownloadingKey,
                    ])
                    let status = values?.ubiquitousItemDownloadingStatus
                    result.append([
                        "name": name,
                        "sizeBytes": values?.fileSize ?? 0,
                        "isDownloaded": status == nil || status == .current,
                        "isDownloading": values?.ubiquitousItemIsDownloading ?? false,
                    ])
                }

                resolve(result)
            } catch {
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }
    }

    /// `.Report.pdf.icloud` -> `Report.pdf`; anything else unchanged.
    static func displayName(for url: URL) -> String {
        let last = url.lastPathComponent
        guard last.hasPrefix("."), last.hasSuffix(".icloud") else { return last }
        return String(last.dropFirst().dropLast(".icloud".count))
    }

    /// Deletes a file from iCloud Drive, on every device.
    @objc public func docRemove(
        _ name: String,
        resolve: @escaping (Any?) -> Void,
        reject: @escaping (String, String, NSError?) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let target = try self.documentsURL().appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: target.path)
                    || self.placeholderExists(for: target) else {
                    // Already gone is the end state the caller asked for.
                    resolve(false)
                    return
                }

                var coordinationError: NSError?
                var removeError: Error?
                NSFileCoordinator().coordinate(
                    writingItemAt: target, options: .forDeleting, error: &coordinationError
                ) { url in
                    do {
                        try FileManager.default.removeItem(at: url)
                    } catch {
                        removeError = error
                    }
                }
                if let error = coordinationError ?? removeError { throw error }

                resolve(true)
            } catch {
                let mapped = CloudSyncError.from(error)
                reject(mapped.code, mapped.message, mapped.asNSError)
            }
        }
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
