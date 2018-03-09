{
	'target_defaults': {
		'default_configuration': 'Release',
		'configurations': {
			'Release': {
				'xcode_settings': {
					'GCC_OPTIMIZATION_LEVEL': '3',
				},
			},
		},
	},
	'targets': [
		{
			'target_name': 'native',
			'cflags_cc': [ '-std=c++14', '-g' ],
			'cflags_cc!': [ '-fno-exceptions' ],
			'xcode_settings': {
				'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
				'GCC_GENERATE_DEBUGGING_SYMBOLS': 'YES',
				'CLANG_CXX_LANGUAGE_STANDARD': 'c++14',
			},
			'msvs_settings': {
				'VCCLCompilerTool': {
					'ExceptionHandling': '1',
				},
			},
			'include_dirs': [
				'<!(node -e "require(\'nan\')")',
			],
			'cflags!': [ '-fno-exceptions' ],
			'cflags_cc!': [ '-fno-exceptions' ],
			'conditions': [
				[ 'OS == "win"', { 'defines': ['NOMINMAX'] } ],
			],
			'sources': [
				'src/main.cc',
				'src/pf.cc',
			],
		},
	],
}
