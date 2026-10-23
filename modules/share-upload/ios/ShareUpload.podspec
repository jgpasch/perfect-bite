Pod::Spec.new do |s|
  s.name           = 'ShareUpload'
  s.version        = '1.0.0'
  s.summary        = 'Finishes the share extension’s background upload when iOS wakes the app'
  s.description    = 'An AppDelegate subscriber for the com.jgp.perfectbite.share.upload background URLSession (spec 4.10).'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
