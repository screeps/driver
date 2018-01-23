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
			'include_dirs': [
				'<!(node -e "require(\'nan\')")',
			],
			'cflags_cc!': [ '-fno-exceptions' ],
			'xcode_settings': {
				'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
			},
			'msvs_settings': {
				'VCCLCompilerTool': {
					'ExceptionHandling': '1',
				},
			},
			'conditions': [
				[ 'OS == "win"', { 'defines': [ 'NOMINMAX' ] } ],
				[ 'OS == "win"',
					{ 'defines': [ 'IVM_DLLEXPORT=__declspec(dllexport)' ] },
					{ 'defines': [ 'IVM_DLLEXPORT=' ] },
				],
			],
			'sources': [
				'src/main.cc',
				'src/pf.cc',
			],
		},
	],
}
