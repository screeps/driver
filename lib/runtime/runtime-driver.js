const _ = require('lodash');
const runtime = require('./runtime');

function EvalCodeError(message) {
    this.toString = () => message;
}

var runtimeCache = {};
var worldSize = global._worldSize;

exports.constants = require('@screeps/common/lib/constants');

exports.bufferFromBase64 = (base64) => {
    return Buffer.from(base64, 'base64');
};

exports.getWorldSize = function() {
    return worldSize;
};

exports.evalCode = function(module, globals, returnValue, timeout, scriptCachedData) {

    var options = {filename: module.name};

    var oldModule = globals.__module || {};

    globals.__module = module;

    if(!_.isUndefined(timeout) && timeout !== null && timeout !== 0 && timeout != Infinity) {
        options.timeout = timeout + 5;
        if(options.timeout < 30) {
            options.timeout = 30;
        }
    }

    // if(scriptCachedData) {
    //     options.produceCachedData = true;
    //     if(scriptCachedData.cachedData && scriptCachedData.cachedData[module.name]) {
    //         options.cachedData = scriptCachedData.cachedData[module.name];
    //     }
    // }

    try {

        var result;

        if(returnValue) {
            var code = '(function(code,module,exports) { return "" + eval(code); })(' + JSON.stringify(module.code) + ', __module, __module.exports)';
            result = runtime.isolate.compileScriptSync(code, options).runSync(runtime.context, options);
        }
        else {

            if (!runtimeCache[module.user] || !runtimeCache[module.user].modules[module.name] ||
                runtimeCache[module.user].modules[module.name].timestamp != module.timestamp) {

                var code = '(function __module(module,exports){ ' + module.code + "\n})(__module, __module.exports)";

                var script = runtime.isolate.compileScriptSync(code, options);

                // if(scriptCachedData) {
                //     if(script.cachedDataProduced) {
                //         scriptCachedData.cachedDataProduced = scriptCachedData.cachedDataProduced || {};
                //         scriptCachedData.cachedDataProduced[module.name] = script.cachedData;
                //         //console.log('cached data produced',module.user,module.name,script.cachedData.byteLength);
                //     }
                //     if(script.cachedDataRejected) {
                //         scriptCachedData.cachedDataRejected = true;
                //         //console.log('cached data rejected',module.user,module.name);
                //     }
                //     if(script.cachedDataRejected === false) {
                //         //console.log('cached data accepted',module.user,module.name);
                //     }
                // }

                runtimeCache[module.user] = runtimeCache[module.user] || {};
                runtimeCache[module.user].modules = runtimeCache[module.user].modules || {};
                runtimeCache[module.user].modules[module.name] = {
                    timestamp: module.timestamp,
                    script
                };
            }

            result = runtimeCache[module.user].modules[module.name].script.runSync(runtime.context, options);
        }

        globals.module = oldModule;

        return result;
    }
    catch(e) {

        if(e instanceof EvalCodeError) throw e;

        if(e.message === 'Script execution timed out.') {
            e.message = 'Script execution timed out: CPU time limit reached';
        }

        var message = '';
        if(e.stack) {
            message = e.stack;
            message = message.replace(/</g,'&lt;');
            message = message.replace(/ *at.*?$/, '');
            message = message.replace(/_console\d+:\d+/, 'console');
            message = message.replace(/at __module \((.*)\)/g, 'at $1');
        }
        else {
            message = e.message;
        }
        throw new EvalCodeError(message);
    }
};

const pathFinderFactory = require('../path-finder');
exports.pathFinder = pathFinderFactory.create(global._nativeMod);
