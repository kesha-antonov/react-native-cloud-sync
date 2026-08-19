#!/usr/bin/env ruby
# frozen_string_literal: true

# Evaluates the podspec the way CocoaPods does, without needing a macOS runner
# or a full `pod install`.
#
# `ruby -c` only parses; it will happily accept a podspec that throws the moment
# CocoaPods evaluates it. That gap shipped a real bug once already:
# `pod_target_xcconfig` is a writer with no matching reader, so reading it back
# to merge into raised "undefined method" and broke every iOS build.
#
# Run with: yarn validate:podspec

require 'cocoapods-core'

# Provided by React Native's scripts/react_native_pods.rb, which is only loaded
# inside a consuming app's Podfile context.
module Pod
  def self.install_modules_dependencies(spec); end
end

def install_modules_dependencies(spec); end

def folly_compiler_flags
  '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1'
end

PODSPEC = File.expand_path('../react-native-cloud-storage.podspec', __dir__)

failures = []

# Evaluate under both architectures - the new-arch branch sets extra flags and
# is the half that is easy to get wrong.
['1', '0'].each do |new_arch|
  ENV['RCT_NEW_ARCH_ENABLED'] = new_arch
  label = new_arch == '1' ? 'new architecture' : 'legacy architecture'

  begin
    spec = Pod::Specification.from_file(PODSPEC)
  rescue StandardError => e
    failures << "#{label}: #{e.message.lines.first(4).join.strip}"
    next
  end

  attrs = spec.attributes_hash

  failures << "#{label}: name is empty" if spec.name.to_s.empty?
  failures << "#{label}: version is empty" if spec.version.to_s.empty?
  failures << "#{label}: no source_files" if attrs['source_files'].to_s.empty?

  unless Array(attrs['frameworks']).include?('CloudKit')
    failures << "#{label}: CloudKit framework is not linked"
  end

  xcconfig = attrs['pod_target_xcconfig'] || {}
  unless xcconfig['DEFINES_MODULE'] == 'YES'
    # Without this the generated -Swift.h does not exist and the Objective-C++
    # bridge cannot import the Swift implementation.
    failures << "#{label}: DEFINES_MODULE must be YES for the Swift/ObjC++ bridge"
  end

  if new_arch == '1' && !attrs['compiler_flags'].to_s.include?('-DRCT_NEW_ARCH_ENABLED=1')
    failures << 'new architecture: RCT_NEW_ARCH_ENABLED=1 is not defined'
  end

  puts "  ok  #{label}: #{spec.name} #{spec.version} (iOS #{spec.deployment_target('ios')})"
end

if failures.empty?
  puts 'podspec validates'
  exit 0
end

warn 'podspec validation failed:'
failures.each { |f| warn "  - #{f}" }
exit 1
