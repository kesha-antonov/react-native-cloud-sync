#import "RNCloudSync.h"

#if __has_include(<react_native_cloud_sync/react_native_cloud_sync-Swift.h>)
#import <react_native_cloud_sync/react_native_cloud_sync-Swift.h>
#else
#import "react_native_cloud_sync-Swift.h"
#endif

@implementation RNCloudSync {
    // Events that arrived before JS was ready to receive them.
    NSMutableArray<NSDictionary *> *_pendingEvents;
    BOOL _jsReady;
}

// Called unconditionally. Even on the New Architecture the module must remain
// reachable through NativeModules so NativeEventEmitter interop keeps working.
RCT_EXPORT_MODULE(RNCloudSync)

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (instancetype)init
{
#ifdef RCT_NEW_ARCH_ENABLED
    self = [super init];
#else
    self = [super initWithDisabledObservation];
#endif
    if (self) {
        _pendingEvents = [NSMutableArray new];
        _jsReady = NO;

        __weak RNCloudSync *weakSelf = self;
        CloudSyncImpl.shared.emit = ^(NSString *name, NSDictionary *payload) {
            [weakSelf safeEmitEvent:name value:payload];
        };
        CloudSyncImpl.shared.emitOwner = (__bridge void *)self;
        [CloudSyncImpl.shared startObserving];
    }
    return self;
}

- (void)dealloc
{
    // Only tear down if this instance is still the one wired up. Across a
    // reload the replacement module installs its own callback before this
    // dealloc runs, and clearing it here would silence every event until the
    // next reload. Pointer comparison only - the pointee may already be gone.
    if (CloudSyncImpl.shared.emitOwner == (__bridge void *)self) {
        [CloudSyncImpl.shared stopObserving];
        CloudSyncImpl.shared.emit = nil;
        CloudSyncImpl.shared.emitOwner = NULL;
    }
}

#pragma mark - Event emission

// Buffers until JS has bound its listener.
//
// This is the fix for a crash three separate people reported against
// react-native-cloud-storage (#59, #60, #63): NSUbiquityIdentityDidChange can
// fire during startup, before JS binds the emitter, and the codegen'd
// std::function is still empty at that point - calling it throws
// std::bad_function_call, which aborts the process. Timing-dependent, so it
// shows up as a rare SIGABRT rather than something you hit while developing.
- (void)safeEmitEvent:(NSString *)name value:(NSDictionary *)payload
{
    @synchronized(self) {
        if (!_jsReady) {
            [_pendingEvents addObject:@{@"name": name, @"value": payload}];
            return;
        }
    }
    [self dispatchEvent:name value:payload];
}

- (void)dispatchEvent:(NSString *)name value:(NSDictionary *)payload
{
#ifdef RCT_NEW_ARCH_ENABLED
    // Codegen names event properties `onFoo`; the legacy emitter uses the bare
    // name. The JS layer knows about this split and subscribes accordingly.
    if ([name isEqualToString:@"remoteChange"]) {
        [self emitOnRemoteChange:payload];
    } else if ([name isEqualToString:@"accountChange"]) {
        [self emitOnAccountChange:payload];
    } else if ([name isEqualToString:@"assetProgress"]) {
        [self emitOnAssetProgress:payload];
    }
#else
    [self sendEventWithName:name body:payload];
#endif
}

- (void)flushPendingEvents
{
    NSArray<NSDictionary *> *pending;
    @synchronized(self) {
        _jsReady = YES;
        pending = [_pendingEvents copy];
        [_pendingEvents removeAllObjects];
    }
    for (NSDictionary *event in pending) {
        [self dispatchEvent:event[@"name"] value:event[@"value"]];
    }
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
    [super setEventEmitterCallback:eventEmitterCallbackWrapper];
    [self flushPendingEvents];
}
#else
- (NSArray<NSString *> *)supportedEvents
{
    return @[@"remoteChange", @"accountChange", @"assetProgress"];
}

- (void)startObserving
{
    [self flushPendingEvents];
}

- (void)stopObserving
{
    @synchronized(self) {
        _jsReady = NO;
    }
}
#endif

#pragma mark - Constants

- (NSDictionary *)constantsToExport
{
    return [CloudSyncImpl.shared getConstants];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (NSDictionary *)getConstants
{
    return [CloudSyncImpl.shared getConstants];
}
#endif

#pragma mark - Methods
//
// Each method is a thin pair: the protocol method the New Architecture calls,
// and an RCT_EXPORT_METHOD for the legacy bridge, both forwarding to the same
// Swift implementation. Only the export macro is #ifndef-guarded - the
// protocol-shaped method is defined unconditionally so there is one code path
// to read.

- (void)getAccountStatus:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared getAccountStatusWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(getAccountStatus:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self getAccountStatus:resolve reject:reject];
}
#endif

- (void)isAvailable:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared isAvailableWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self isAvailable:resolve reject:reject];
}
#endif

- (void)kvGetItem:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvGetItem:key resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvGetItem:(NSString *)key resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvGetItem:key resolve:resolve reject:reject];
}
#endif

- (void)kvSetItem:(NSString *)key value:(NSString *)value resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvSetItem:key value:value resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvSetItem:(NSString *)key value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvSetItem:key value:value resolve:resolve reject:reject];
}
#endif

- (void)kvRemoveItem:(NSString *)key resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvRemoveItem:key resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvRemoveItem:(NSString *)key resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvRemoveItem:key resolve:resolve reject:reject];
}
#endif

- (void)kvGetAllKeys:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvGetAllKeysWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvGetAllKeys:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvGetAllKeys:resolve reject:reject];
}
#endif

- (void)kvGetAllItems:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvGetAllItemsWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvGetAllItems:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvGetAllItems:resolve reject:reject];
}
#endif

- (void)kvSync:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvSyncWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvSync:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvSync:resolve reject:reject];
}
#endif

- (void)kvGetUsage:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared kvGetUsageWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(kvGetUsage:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self kvGetUsage:resolve reject:reject];
}
#endif

- (void)ckGetRecord:(NSString *)recordType recordName:(NSString *)recordName zoneName:(NSString *)zoneName encrypted:(BOOL)encrypted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckGetRecord:recordType recordName:recordName zoneName:zoneName encrypted:encrypted resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckGetRecord:(NSString *)recordType recordName:(NSString *)recordName zoneName:(NSString *)zoneName encrypted:(BOOL)encrypted resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckGetRecord:recordType recordName:recordName zoneName:zoneName encrypted:encrypted resolve:resolve reject:reject];
}
#endif

- (void)ckSaveRecord:(NSString *)recordType recordName:(NSString *)recordName value:(NSString *)value zoneName:(NSString *)zoneName encrypted:(BOOL)encrypted resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckSaveRecord:recordType recordName:recordName value:value zoneName:zoneName encrypted:encrypted resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckSaveRecord:(NSString *)recordType recordName:(NSString *)recordName value:(NSString *)value zoneName:(NSString *)zoneName encrypted:(BOOL)encrypted resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckSaveRecord:recordType recordName:recordName value:value zoneName:zoneName encrypted:encrypted resolve:resolve reject:reject];
}
#endif

- (void)ckDeleteRecord:(NSString *)recordName zoneName:(NSString *)zoneName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckDeleteRecord:recordName zoneName:zoneName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckDeleteRecord:(NSString *)recordName zoneName:(NSString *)zoneName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckDeleteRecord:recordName zoneName:zoneName resolve:resolve reject:reject];
}
#endif

- (void)ckQueryRecordNames:(NSString *)recordType zoneName:(NSString *)zoneName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckQueryRecordNames:recordType zoneName:zoneName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckQueryRecordNames:(NSString *)recordType zoneName:(NSString *)zoneName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckQueryRecordNames:recordType zoneName:zoneName resolve:resolve reject:reject];
}
#endif

- (void)ckCreateZone:(NSString *)zoneName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckCreateZone:zoneName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckCreateZone:(NSString *)zoneName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckCreateZone:zoneName resolve:resolve reject:reject];
}
#endif

- (void)ckDeleteZone:(NSString *)zoneName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckDeleteZone:zoneName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckDeleteZone:(NSString *)zoneName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckDeleteZone:zoneName resolve:resolve reject:reject];
}
#endif

- (void)ckListZones:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckListZonesWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckListZones:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckListZones:resolve reject:reject];
}
#endif

- (void)ckSaveAsset:(NSString *)recordType recordName:(NSString *)recordName fieldName:(NSString *)fieldName fileUri:(NSString *)fileUri zoneName:(NSString *)zoneName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckSaveAsset:recordType recordName:recordName fieldName:fieldName fileUri:fileUri zoneName:zoneName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckSaveAsset:(NSString *)recordType recordName:(NSString *)recordName fieldName:(NSString *)fieldName fileUri:(NSString *)fileUri zoneName:(NSString *)zoneName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckSaveAsset:recordType recordName:recordName fieldName:fieldName fileUri:fileUri zoneName:zoneName resolve:resolve reject:reject];
}
#endif

- (void)ckFetchAsset:(NSString *)recordName fieldName:(NSString *)fieldName zoneName:(NSString *)zoneName destinationUri:(NSString *)destinationUri resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckFetchAsset:recordName fieldName:fieldName zoneName:zoneName destinationUri:destinationUri resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckFetchAsset:(NSString *)recordName fieldName:(NSString *)fieldName zoneName:(NSString *)zoneName destinationUri:(NSString *)destinationUri resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckFetchAsset:recordName fieldName:fieldName zoneName:zoneName destinationUri:destinationUri resolve:resolve reject:reject];
}
#endif

- (void)ckCancelAsset:(NSString *)recordName fieldName:(NSString *)fieldName resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared ckCancelAsset:recordName fieldName:fieldName resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(ckCancelAsset:(NSString *)recordName fieldName:(NSString *)fieldName resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self ckCancelAsset:recordName fieldName:fieldName resolve:resolve reject:reject];
}
#endif

- (void)docIsAvailable:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared docIsAvailableWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(docIsAvailable:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self docIsAvailable:resolve reject:reject];
}
#endif

- (void)docSave:(NSString *)fileUri name:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared docSave:fileUri name:name resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(docSave:(NSString *)fileUri name:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self docSave:fileUri name:name resolve:resolve reject:reject];
}
#endif

- (void)docFetch:(NSString *)name destinationUri:(NSString *)destinationUri timeoutMs:(double)timeoutMs resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared docFetch:name destinationUri:destinationUri timeoutMs:@(timeoutMs) resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(docFetch:(NSString *)name destinationUri:(NSString *)destinationUri timeoutMs:(double)timeoutMs resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self docFetch:name destinationUri:destinationUri timeoutMs:timeoutMs resolve:resolve reject:reject];
}
#endif

- (void)docList:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared docListWithResolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(docList:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self docList:resolve reject:reject];
}
#endif

- (void)docRemove:(NSString *)name resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
    [CloudSyncImpl.shared docRemove:name resolve:resolve reject:reject];
}

#ifndef RCT_NEW_ARCH_ENABLED
RCT_EXPORT_METHOD(docRemove:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    [self docRemove:name resolve:resolve reject:reject];
}
#endif

// The only void method here, and so the only one where both architectures want
// the exact same selector: RCT_EXPORT_METHOD(setLogsEnabled:) expands to
// `-setLogsEnabled:`, which collides with the protocol method of the same name.
// The promise methods avoid this by accident - their legacy exports use
// `resolver:`/`rejecter:` where the protocol uses `resolve:`/`reject:`.
//
// So share one implementation and give each architecture a thin wrapper, the
// same shape react-native-background-downloader uses for its void methods.
- (void)_setLogsEnabledInternal:(BOOL)enabled
{
    [CloudSyncImpl.shared setLogsEnabled:enabled];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (void)setLogsEnabled:(BOOL)enabled
{
    [self _setLogsEnabledInternal:enabled];
}
#else
RCT_EXPORT_METHOD(setLogsEnabled:(BOOL)enabled)
{
    [self _setLogsEnabledInternal:enabled];
}
#endif

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeRNCloudSyncSpecJSI>(params);
}
#endif

@end
