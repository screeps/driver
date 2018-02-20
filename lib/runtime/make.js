var common = require('@screeps/common'),
    db = common.storage.db,
    env = common.storage.env,
    pubsub = common.storage.pubsub,
    config = common.configManager.config,
    native = require('../../native/build/Release/native.node'),
    ivm = require('isolated-vm'),
    q = require('q'),
    _ = require('lodash'),
    runtimeData = require('./data'),
    runtimeUserVm = require('./user-vm');

let staticTerrainData;


// Convert a room name to/from usable coordinates
// "E1N1" -> { xx: 129, yy: 126 }
let kWorldSize = 255; // Talk to marcel before growing world larger than W127N127 :: E127S127
function parseRoomName(roomName) {
    let room = /^([WE])([0-9]+)([NS])([0-9]+)$/.exec(roomName);
    if (!room) {
        throw new Error('Invalid room name '+roomName);
    }
    let rx = (kWorldSize >> 1) + (room[1] === 'W' ? -Number(room[2]) : Number(room[2]) + 1);
    let ry = (kWorldSize >> 1) + (room[3] === 'N' ? -Number(room[4]) : Number(room[4]) + 1);
    if (!(rx >=0 && rx <= kWorldSize && ry >= 0 && ry <= kWorldSize)) {
        throw new Error('Invalid room name '+roomName);
    }
    return { xx: rx, yy: ry };
}

function initPathFinder(rooms) {

    let terrainData = [];
    rooms.forEach(function(room) {
        let pack = new Uint8Array(50 * 50 / 4);
        let terrain = room.terrain;
        for (let xx = 0; xx < 50; ++xx) {
            for (let yy = 0; yy < 50; ++yy) {
                let ii = xx * 50 + yy;
                let bit = Number(terrain[yy * 50 + xx]);
                pack[ii / 4 | 0] = pack[ii / 4 | 0] & ~(0x03 << ii % 4 * 2) | bit << ii % 4 * 2;
            }
        }
        terrainData.push({
            room: parseRoomName(room.room),
            bits: pack,
        });
    });

    native.loadTerrain(terrainData);
}


function getAllTerrainData() {
    if(staticTerrainData) {
        return;
    }
    return runtimeData.getAllTerrainData()
        .then((result) => {

            initPathFinder(result);

            staticTerrainData = {};

            result.forEach(room => {
                var array = new Uint8Array(2500);
                var char;
                for (var i = 0; i < 2500; i++) {
                    char = room.terrain.charAt(i);
                    array[i] = Number(char);
                }
                staticTerrainData[room.room] = array;
            });
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

async function make (scope, userId, onlyInRoom) {

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

        let data = await runtimeData.get(userId, onlyInRoom);
        let dataRef = new ivm.ExternalCopy(data);

        if(scope.abort) {
            throw 'aborted';
        }

        await runtimeUserVm.create({
            userId,
            staticTerrainData,
            codeTimestamp: data.userCodeTimestamp
        });

        let vm = runtimeUserVm.get(userId);

        let run = await vm.start.apply(undefined, [dataRef.copyInto()]);

        if(scope.abort) {
            throw 'aborted';
        }

        runResult = await run.apply(undefined, [], {timeout: data.timeout});

        run.dispose();
        dataRef.dispose();

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
            env.set(env.keys.PUBLIC_MEMORY_SEGMENTS+userData.user._id, runResult.publicSegments.join(','));
        }

        if(runResult.visual) {
            for (var roomName in runResult.visual) {
                env.setex(
                    env.keys.ROOM_VISUAL + userData.user._id + ',' + roomName + ',' + data.time,
                    config.mainLoopResetInterval / 1000,
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

module.exports = function(userId, onlyInRoom) {
    const scope = {abort: false};
    let timeout;
    return new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            scope.abort = true;
            reject({error: 'Script execution timed out ungracefully, restarting virtual machine'});
            runtimeUserVm.clear(userId);
            console.error('isolated-vm timeout', userId);
            pubsub.publish(`user:${userId}/cpu`, JSON.stringify({cpu: 'error'}));
        }, 5000);
        make(scope, userId, onlyInRoom).then(resolve).catch(reject);
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