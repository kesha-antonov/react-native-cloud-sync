#!/usr/bin/env bash
# Compiles this pod's Swift sources for every Apple destination the podspec
# claims, including Mac Catalyst.
#
# Scope, deliberately: this proves OUR sources are clean for each target triple.
# It does not prove an arbitrary React Native app links for Mac Catalyst - React
# Native does not officially support Catalyst, and apps that ship it carry their
# own Podfile repairs for other pods. What this package can be responsible for
# is that its own code compiles, and that is what this checks.
#
# macOS only. Run with: yarn check:catalyst
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$HERE/ios"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "check-catalyst: needs Xcode command line tools; skipping." >&2
  exit 0
fi

IOS_SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
MAC_SDK="$(xcrun --sdk macosx --show-sdk-path)"

failed=0

check () {
  local label="$1" sdk="$2" target="$3"
  if xcrun swiftc -typecheck -sdk "$sdk" -target "$target" "$IOS"/*.swift 2>/tmp/catalyst-$$.log; then
    echo "  ok  $label  ($target)"
  else
    echo "  FAILED  $label  ($target)" >&2
    head -20 /tmp/catalyst-$$.log >&2
    failed=1
  fi
  rm -f /tmp/catalyst-$$.log
}

check "iOS simulator" "$IOS_SDK" "arm64-apple-ios15.1-simulator"
check "iOS device"    "$(xcrun --sdk iphoneos --show-sdk-path)" "arm64-apple-ios15.1"
check "Mac Catalyst"  "$MAC_SDK" "arm64-apple-ios15.1-macabi"

if [ "$failed" -ne 0 ]; then
  echo "catalyst/platform check FAILED" >&2
  exit 1
fi

echo "platform compile check passed"
