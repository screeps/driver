const _ = require('lodash'),
    ivm = require('isolated-vm'),
    fs = require('fs'),
    index = require('../index'),
    nativeModPath = '../../native/build/Release/native.node',
    native = require(nativeModPath),
    nativeMod = new ivm.NativeModule(require.resolve(nativeModPath)),
    common = require('@screeps/common'),
    config = common.configManager.config;

let vms = {}, snapshot;

exports.create = async function({userId, staticTerrainData, codeTimestamp}) {
    userId = ""+userId;

    if(vms[userId]) {
        if(vms[userId].isolate.isDisposed) {
            exports.clear(userId);
            throw 'Script execution has been terminated: your isolate disposed unexpectedly, restarting virtual machine';
        }
        if(codeTimestamp > vms[userId].codeTimestamp) {
            exports.clear(userId);
        }
    }

    if(!vms[userId]) {
        console.log('creating isolate', userId);
        let isolate = new ivm.Isolate({snapshot, memoryLimit: 256});
        let context = await isolate.createContext();
        let jail = context.globalReference();
        await jail.set('global', jail.derefInto());
        await jail.set('_ivm', ivm);
        await jail.set('_isolate', isolate);
        await jail.set('_context', context);
        await jail.set('_worldSize', index.getWorldSize());

        let nativeModInstance = await nativeMod.create(context);
        await jail.set('_nativeMod', nativeModInstance.derefInto());

        await (await isolate.compileScript('_init();')).run(context);

        let evalFn = await jail.get('_evalFn');
        let start = await jail.get('_start');

        await Promise.all(Object.keys(staticTerrainData).map(async (room) => {
            await (await jail.get('_setStaticTerrainData')).apply(undefined,
                [room, new ivm.ExternalCopy(staticTerrainData[room]).copyInto()]);
        }));

        await (await isolate.compileScript('new ' + function () {
            delete global._ivm;
            delete global._isolate;
            delete global._context;
            delete global._init;
            delete global._evalFn;
            delete global._start;
            delete global._setStaticTerrainData;
            delete global._worldSize;
            delete global._nativeMod;
        })).run(context);

        vms[userId] = {
            isolate,
            context,
            jail,
            start,
            evalFn,
            nativeModInstance,
            codeTimestamp
        };
    }

    vms[userId].lastUsed = Date.now();
};

exports.get = function(userId) {
    userId = ""+userId;
    return vms[userId];
};
exports.clear = function(userId) {
    userId = ""+userId;
    if(vms[userId]) {
        try {
            console.log('releasing isolate', userId);
            vms[userId].start.dispose();
            vms[userId].evalFn.dispose();
            vms[userId].nativeModInstance.dispose();
            vms[userId].jail.dispose();
            vms[userId].context.release();
            if(!vms[userId].isolate.isDisposed) {
                vms[userId].isolate.dispose();
            }
        }
        catch (e) {
            console.error('release isolate error', userId, e);
        }
        delete vms[userId];
        vms[userId] = null;
    }
};

exports.clearAll = function() {
    for(var userId in vms) {
        exports.clear(userId);
    }
    vms = {};
};

exports.getMetrics = function() {
    return Object.keys(vms).reduce((accum, userId) => {
        if(vms[userId]) {
            var result = {
                userId,
                codeTimestamp: vms[userId].codeTimestamp,
                lastUsed: vms[userId].lastUsed,
                heap: {}
            };
            if (!vms[userId].isolate.isDisposed) {
                result.heap = vms[userId].isolate.getHeapStatisticsSync();
            }
            accum.push(result);
        }
        return accum;
    }, []);
};

exports.init = function() {

    snapshot = new ivm.ExternalCopy(fs.readFileSync(require.resolve('../../build/runtime.snapshot.bin')).buffer);

    setInterval(() => {
        for (let userId in vms) {
            if (vms[userId] && vms[userId].lastUsed < Date.now() - 3 * 60 * 1000) {
                exports.clear(userId);
            }
        }
    }, 60 * 1000);

    if (config.engine.reportMemoryUsageInterval) {
        setInterval(() => {
            console.log('---');
            let heap = require('v8').getHeapStatistics();
            console.log(`# Main heap: ${heap.total_heap_size}`);
            console.log(`# ExternalCopy.totalExternalSize: ${ivm.ExternalCopy.totalExternalSize}`);

            exports.getMetrics().forEach(user => {
                console.log(`# User ${user.userId} heap: ${user.heap.total_heap_size + user.heap.externally_allocated_size}`);
            });
            console.log('---');
        }, config.engine.reportMemoryUsageInterval);
    }
};