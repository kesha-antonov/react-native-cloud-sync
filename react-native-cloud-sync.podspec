require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'

Pod::Spec.new do |s|
  s.name         = package['name'].split('/').last
  s.version      = package['version']
  s.summary      = package['description']
  s.description  = package['description']
  s.homepage     = package['repository']['url']
  s.license      = package['license']
  s.author       = package['author']
  s.source       = { git: 'https://github.com/kesha-antonov/react-native-cloud-sync.git', tag: "v#{s.version}" }

  # iOS only as a declared platform - Mac Catalyst builds from this same slice
  # (SUPPORTS_MACCATALYST), it is not a separate platform entry. 15.1 matches
  # the floor the consuming apps already use.
  s.platform     = :ios, '15.1'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'

  # CloudKit for records/assets/zones; Foundation carries
  # NSUbiquitousKeyValueStore. Both are available under Mac Catalyst.
  s.frameworks = 'CloudKit', 'Foundation'

  # Built up locally and assigned once: `pod_target_xcconfig` is a writer on
  # Pod::Specification with no matching reader, so it cannot be read back and
  # merged into.
  xcconfig = {
    # Required so the generated `react_native_cloud_sync-Swift.h` exists for
    # the Objective-C++ bridge to import.
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.0'
  }

  if ENV['RCT_NEW_ARCH_ENABLED'] == '1'
    s.compiler_flags = folly_compiler_flags + ' -DRCT_NEW_ARCH_ENABLED=1'
    xcconfig['HEADER_SEARCH_PATHS'] = "\"$(PODS_ROOT)/boost\""
    xcconfig['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
  end

  s.pod_target_xcconfig = xcconfig

  # React Native core dependency, codegen wiring and the new-arch flags.
  #
  # Must come LAST. It reads the spec's current `compiler_flags` and
  # `pod_target_xcconfig` back out of `spec.to_hash` and merges React Native's
  # header search paths, C++ standard and folly flags into them. Called before
  # the assignments above, it had all of that overwritten - leaving the pod on
  # c++17 with none of React Native's header paths, which breaks the
  # new-architecture build on any React Native that requires C++20 (0.73+).
  install_modules_dependencies(s)
end
