var common = require('@screeps/common'),
    db = common.storage.db,
    env = common.storage.env,
    pubsub = common.storage.pubsub,
    config = common.configManager.config,
    native = require('../../native/build/Release/native.node'),
    ivm = require('isolated-vm'),
    q = require('q'),
    _ = require('lodash'),
    driver = require('../index'),
    pathfinderFactory = require('../path-finder'),
    runtimeData = require('./data'),
    runtimeUserVm = require('./user-vm');

let staticTerrainData, staticTerrainDataSize = 0;

function getAllTerrainData() {
    if(staticTerrainData) {
        return;
    }
    return driver.getAllTerrainData()
        .then((result) => {

            if(staticTerrainData) {
                return;
            }

            pathfinderFactory.init(native, result);

            staticTerrainDataSize = result.length * 2500;
            let bufferConstructor = typeof SharedArrayBuffer === 'undefined' ? ArrayBuffer : SharedArrayBuffer;
            let view = new Uint8Array(new bufferConstructor(staticTerrainDataSize));
            staticTerrainData = {
                buffer: view.buffer,
                roomOffsets: {},
            };

            result.forEach((room, roomIndex) => {
                var offset = roomIndex * 2500;
                for (var i = 0; i < 2500; i++) {
                    view[i + offset] = Number(room.terrain.charAt(i));
                }
                staticTerrainData.roomOffsets[room.room] = offset;
            });

            console.log('Terrain shared buffer size:', staticTerrainDataSize);
        })
}


function getUserData(userId) {
    return db.users.findOne({_id: userId})
        .then((user) => {

            var cpu;
            if(user.cpu) {
                cpu = user.cpuAvailable || 0;
                if(user.skipTicksPenalty > 0) {
                    console.log(`Skip user execution ${user.username} (penalty ${user.skipTicksPenalty})`);
                    db.users.update({_id: user._id}, {$set: {
                        lastUsedCpu: 0,
                        lastUsedDirtyTime: 0
                    }, $inc: {skipTicksPenalty: -1}});
                    return q.reject({
                        type: 'error',
                        error: 'Your script is temporary blocked due to a hard reset inflicted to the runtime process.\nPlease try to change your code in order to prevent causing hard timeout resets.'
                    });
                }
                if(user.cpuAvailable < 0) {
                    console.log(`Skip user execution ${user.username} (${user.cpuAvailable})`);
                    db.users.update({_id: user._id}, {$set: {
                        lastUsedCpu: 0,
                        lastUsedDirtyTime: 0,
                        cpuAvailable: user.cpuAvailable < -user.cpu * 2 ? -user.cpu * 2 : user.cpuAvailable + user.cpu
                    }});
                    return q.reject({
                        type: 'error',
                        error: 'Script execution has been terminated: CPU bucket is empty'
                    });
                }
                cpu += user.cpu;
                if(cpu > config.engine.cpuMaxPerTick) {
                    cpu = config.engine.cpuMaxPerTick;
                }
            }
            else {
                cpu = Infinity;
            }

            return {user, cpu};

        });
}

async function make (scope, userId) {

    let userData;

    try {

        await getAllTerrainData();

        if(scope.abort) {
            throw 'aborted';
        }

        userData = await getUserData(userId);

        if(scope.abort) {
            throw 'aborted';
        }

    }
    catch(error) {
        console.error(error);
        if(_.isObject(error)) {
            throw error;
        }
        throw {error};
    }

    let runResult;

    try {

        let data = await runtimeData.get(userId);
        let dataRef = new ivm.ExternalCopy(data);

        if(scope.abort) {
            throw 'aborted';
        }

        await runtimeUserVm.create({
            userId,
            staticTerrainData,
            staticTerrainDataSize,
            codeTimestamp: data.userCodeTimestamp
        });

        let vm = runtimeUserVm.get(userId);

        let run = await vm.start.apply(undefined, [dataRef.copyInto()]);

        if(scope.abort) {
            throw 'aborted';
        }

        config.engine.emit('playerSandbox', {
            run(code) {
                return vm.isolate.compileScriptSync(code).runSync(vm.context);
            },
            set(name, value) {
                return vm.context.global.setSync(name, new ivm.ExternalCopy(value).copyInto());
            },
            get(name) {
                return vm.context.global.getSync(name).copySync();
            },
            getIsolate() {
                return vm.isolate;
            },
            getContext() {
                return vm.context;
            },
            getGlobal() {
                return vm.jail;
            }
        }, userId);

        runResult = await run.apply(undefined, [], {timeout: data.timeout});

        run.release();
        dataRef.release();

        var $set = {
            lastUsedCpu: runResult.usedTime,
            lastUsedDirtyTime: runResult.usedDirtyTime
        };
        if (runResult.activeSegments) {
            $set.activeSegments = runResult.activeSegments;
        }
        if (runResult.defaultPublicSegment !== undefined) {
            $set.defaultPublicSegment = runResult.defaultPublicSegment;
        }
        if (userData.cpu < Infinity) {
            var newCpuAvailable = userData.user.cpuAvailable + userData.user.cpu - runResult.usedTime;
            if(newCpuAvailable > config.engine.cpuBucketSize) {
                newCpuAvailable = config.engine.cpuBucketSize;
            }
            $set.cpuAvailable = newCpuAvailable;
        }

        db.users.update({_id: userData.user._id}, {$set});

        if (runResult.activeForeignSegment !== undefined) {
            if (runResult.activeForeignSegment === null) {
                db.users.update({_id: userData.user._id}, {
                    $unset: {
                        activeForeignSegment: true
                    }
                });
            }
            else {
                if (userData.user.activeForeignSegment &&
                    runResult.activeForeignSegment.username == userData.user.activeForeignSegment.username &&
                    runResult.activeForeignSegment.id) {
                    db.users.update({_id: userData.user._id}, {$merge: {
                        activeForeignSegment: {id: runResult.activeForeignSegment.id}
                    }});
                }
                else {
                    db.users.findOne({username: runResult.activeForeignSegment.username}, {defaultPublicSegment: true})
                        .then(user => {
                            runResult.activeForeignSegment.user_id = user._id;
                            if(!runResult.activeForeignSegment.id && user.defaultPublicSegment) {
                                runResult.activeForeignSegment.id = user.defaultPublicSegment;
                            }
                        })
                        .finally(() => {
                            db.users.update({_id: userData.user._id}, {$set: {
                                activeForeignSegment: runResult.activeForeignSegment
                            }});
                        })
                }
            }
        }

        if(runResult.publicSegments) {
            env.set(env.keys.PUBLIC_MEMORY_SEGMENTS+userData.user._id, runResult.publicSegments);
        }

        if(runResult.visual) {
            for (var roomName in runResult.visual) {
                env.setex(
                    env.keys.ROOM_VISUAL + userData.user._id + ',' + roomName + ',' + data.time,
                    config.engine.mainLoopResetInterval / 1000,
                    runResult.visual[roomName]);
            }
        }

        if (/CPU limit reached/.test(runResult.error)) {
            pubsub.publish(`user:${userData.user._id}/cpu`, JSON.stringify({
                cpu: 'error',
                memory: runResult.memory.data.length
            }));
        }
        else {
            pubsub.publish(`user:${userData.user._id}/cpu`, JSON.stringify({
                cpu: runResult.usedTime,
                memory: runResult.memory.data.length
            }));
        }

        runResult.username = userData && userData.user && userData.user.username;

        return runResult;
    }
    catch (error) {
        let vm = runtimeUserVm.get(userId);
        if (vm && vm.didHaltByUserRequest) {
            runtimeUserVm.clear(userId);
            throw { error: "CPU halted" };
        }
        if(/Isolate is disposed/.test(""+error) ||
            /Isolate has exhausted v8 heap space/.test(""+error)) {
            runtimeUserVm.clear(userId);
        }
        if(/Array buffer allocation failed/.test(""+error) && !runResult) {
            runtimeUserVm.clear(userId);
            throw { error: "Script execution has been terminated: unable to allocate memory, restarting virtual machine"};
        }
        throw {error: error.stack || error};
    }
}

module.exports = function(userId) {
    const scope = {abort: false};
    let timeout;
    return new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            scope.abort = true;
            reject({error: 'Script execution timed out ungracefully, restarting virtual machine'});
            runtimeUserVm.clear(userId);
            console.error('isolated-vm timeout', userId);
            pubsub.publish(`user:${userId}/cpu`, JSON.stringify({cpu: 'error'}));
        }, Math.max(5000, config.engine.mainLoopResetInterval));
        make(scope, userId).then(resolve).catch(reject);
    })
        .then(result => {
            clearTimeout(timeout);
            return result;
        })
        .catch(error => {
            clearTimeout(timeout);
            return Promise.reject(error);
        })
};
