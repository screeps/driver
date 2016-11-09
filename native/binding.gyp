{
	'target_defaults': {
		'default_configuration': 'Release',
		'configurations': {
			'Release': {
				'cflags': [ '-O3' ],
				'xcode_settings': {
					'GCC_OPTIMIZATION_LEVEL': '3',
					'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
				},
				'msvs_settings': {
					'VCCLCompilerTool': {
						'Optimization': 3,
						'FavorSizeOrSpeed': 1,
					},
				},
			},
			'Debug': {
				'xcode_settings': {
					'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
				},
			},
		},
	},
	'targets': [
		{
			'target_name': 'native',
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
