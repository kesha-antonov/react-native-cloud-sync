#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <RNCloudSyncSpec/RNCloudSyncSpec.h>
#endif

NS_ASSUME_NONNULL_BEGIN

// Two base classes, one implementation. On the New Architecture the generated
// spec base supplies the emit* plumbing; on the legacy architecture we are an
// RCTEventEmitter. Everything below the bridge is shared, and lives in Swift
// (CloudSyncImpl).
//
// This mirrors react-native-background-downloader's arrangement, which is the
// pattern in this codebase that is already proven across both architectures.
#ifdef RCT_NEW_ARCH_ENABLED
@interface RNCloudSync : NativeRNCloudSyncSpecBase <NativeRNCloudSyncSpec>
#else
@interface RNCloudSync : RCTEventEmitter <RCTBridgeModule>
#endif

@end

NS_ASSUME_NONNULL_END
