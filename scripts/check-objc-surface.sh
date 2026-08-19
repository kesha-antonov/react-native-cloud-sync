#!/usr/bin/env bash
# Verifies that every Swift member ios/RNCloudStorage.mm calls is actually
# exposed to Objective-C.
#
# Swift does not export members to Objective-C just because the class is @objc
# and inherits NSObject - each member needs its own @objc. Forgetting one
# compiles fine in Swift and fails only when the bridge is compiled, which
# needs a full pod install and an Xcode build. This catches it in seconds.
#
# macOS only (needs swiftc). Run with: yarn check:objc
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$HERE/ios"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

if ! command -v xcrun >/dev/null 2>&1; then
  echo "check-objc-surface: needs Xcode command line tools; skipping." >&2
  exit 0
fi

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

xcrun swiftc -emit-objc-header \
  -emit-objc-header-path "$OUT/gen-Swift.h" \
  -emit-module -emit-module-path "$OUT/mod.swiftmodule" \
  -sdk "$SDK" \
  -target arm64-apple-ios15.1-simulator \
  -module-name react_native_cloud_storage \
  "$IOS"/*.swift

# Every `[CloudStorageImpl.shared <selector>` and `CloudStorageImpl.shared.<prop>`
# the bridge uses.
SELECTORS=$(grep -oE '\[CloudStorageImpl\.shared [a-zA-Z]+' "$IOS/RNCloudStorage.mm" \
  | awk '{print $2}' | sort -u)
PROPERTIES=$(grep -oE 'CloudStorageImpl\.shared\.[a-zA-Z]+' "$IOS/RNCloudStorage.mm" \
  | sed 's/.*\.//' | sort -u)

missing=0

for sel in $SELECTORS; do
  # Selector may be followed by ":" (has arguments), ";" (none) or a space.
  if grep -qE "\)${sel}[:; ]" "$OUT/gen-Swift.h"; then
    echo "  ok  method   $sel"
  else
    echo "  MISSING method   $sel  - add @objc to it in Swift" >&2
    missing=1
  fi
done

for prop in $PROPERTIES; do
  if grep -qE "\b${prop}\b" "$OUT/gen-Swift.h"; then
    echo "  ok  property $prop"
  else
    echo "  MISSING property $prop  - add @objc to it in Swift" >&2
    missing=1
  fi
done

if ! grep -q "shared" "$OUT/gen-Swift.h"; then
  echo "  MISSING CloudStorageImpl.shared is not exposed to Objective-C" >&2
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "objc surface check FAILED" >&2
  exit 1
fi

echo "objc surface check passed"
