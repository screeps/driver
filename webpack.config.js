const path = require('path');
const webpack = require('webpack');
const WebbackShellPlugin = require('webpack-shell-plugin');

module.exports = {
    entry: './lib/runtime/runtime.js',
    output: {
        filename: 'runtime.bundle.js',
        path: path.resolve(__dirname, './build'),
    },
    resolve: {
        alias: {
            '~runtime-driver': require.resolve('./lib/runtime/runtime-driver')
        }
    },
    plugins: [
        new WebbackShellPlugin({
            dev: false,
            onBuildEnd: ['node --nolazy make-runtime-snapshot']
        }),
        new webpack.IgnorePlugin(/\.\/core\/index/)
    ]
};