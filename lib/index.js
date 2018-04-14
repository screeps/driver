var bulk = require('./bulk'),
    queue = require('./queue'),
    EventEmitter = require('events').EventEmitter,
    common = require('@screeps/common'),
    db = common.storage.db,
    env = common.storage.env,
    pubsub = common.storage.pubsub,
    config = Object.assign(common.configManager.config, {engine: new EventEmitter()}),
    q = require('q'),
    vm = require('vm'),
    _ = require('lodash'),
    child_process = require('child_process'),
    os = require('os'),
    util = require('util'),
    runtimeChild, runtimeDeferred, runtimeTimeoutSigkill, runtimeTimeoutSigint, runtimeData, runtimeRestartSignalReceived = false,
    runtimeCache = {},
    roomStatsUpdates = {},
    zlib = require('zlib'),
    worldSize;

_.extend(config.engine, {
    driver: exports,
    mainLoopMinDuration: 1000,
    mainLoopResetInterval: 5000,
    mainLoopCustomStage() {
        return q.when();
    },
    cpuMaxPerTick: 500,
    cpuBucketSize: 10000,
    customIntentTypes: {},
    historyChunkSize: 20,
    useSigintTimeout: false,
    visualCacheTicks: 20
});

config.engine.on('playerSandbox', (sandbox) => {
    sandbox.Game.shard = Object.create(null, {
        name: {
            value: os.hostname(),
            writable: true,
            enumerable: true
        },
        type: {
            value: 'normal',
            writable: true,
            enumerable: true
        },
        ptr: {
            value: false,
            enumerable: true
        }
    });
});

exports.customObjectPrototypes = [];

Object.defineProperty(config.engine, 'registerCustomObjectPrototype', {
    value: function(objectType, name, opts) {
        if(!objectType) {
            throw new Error('No object type provided!');
        }
        if(!name) {
            throw new Error('No prototype name provided!');
        }
        exports.customObjectPrototypes.push({objectType, name, opts});
    }
});

exports.config = config.engine;

function checkNotificationOnline(userId) {
    return q.when(true); // TODO
}


exports.connect = function(processType) {

    common.configManager.load();

    return common.storage._connect()
    .then(() => {

        if (processType == 'runner') {
            pubsub.subscribe(pubsub.keys.RUNTIME_RESTART, () => {
                runtimeRestartSignalReceived = true;
                console.log('runtime restart signal');
            });
        }

        if (processType == 'runtime') {
        }

        if (processType == 'processor') {
        }

        if (processType == 'main') {
        }
    })
    .then(() => db.rooms.find({}, {_id: true}))
    .then(common.calcWorldSize)
    .then(_worldSize => worldSize = _worldSize)
    .then(() => {
        config.engine.emit('init', processType);
        return true;
    });
};

exports.getUserData = function(userId) {
    var userObjects, runtimeData;

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
};


exports.getAllUsers = function() {
    return q.all([
        db.users.find({$and: [{active: {$ne: 0}}, {cpu: {$gt: 0}}]}),
        db.rooms.find({$and: [{active: true}, {sourceKeepers: true}]}),
        db['rooms.objects'].find({$and: [{type: 'creep'},{user: '2'}]})
    ])
    .then((data) => {
        data[0].sort((a,b) => (b.lastUsedDirtyTime || 0) - (a.lastUsedDirtyTime || 0));

        data[1].forEach((i) => data[0].push({_id: 'SourceKeeper:'+i._id}));
        if(data[2].length) {
            data[2] = _.pluck(data[2], 'room');
            data[2] = _.uniq(data[2]);
            data[2].forEach((i) => data[0].push({_id: 'Invader:' + i}));
        }
        return data[0];
    })
};

exports.makeRuntime = function(userId, onlyInRoom) {

    return exports.getUserData(userId)
    .then((_runtimeData) => {

        runtimeDeferred = q.defer();
        runtimeData = _runtimeData;

        if (!runtimeChild || !runtimeChild.connected || runtimeRestartSignalReceived) {

            runtimeRestartSignalReceived = false;

            if (runtimeChild && runtimeChild.connected) {
                runtimeChild._killRequest = true;
                runtimeChild.kill('SIGKILL');
            }

            runtimeChild = child_process.fork(__dirname + '/runtime/runtime.js');

            console.log(`New child runtime process ${runtimeChild.pid}`);

            runtimeChild.on('message', function(message) {

                switch (message.type) {
                    case 'start':

                        clearTimeout(runtimeTimeoutSigkill);
                        clearTimeout(runtimeTimeoutSigint);


                        if (runtimeData.cpu < Infinity) {

                            if(config.engine.useSigintTimeout) {
                                runtimeTimeoutSigint = setTimeout(() => {
                                    runtimeChild.kill('SIGINT');
                                }, runtimeData.cpu + 20);
                            }

                            runtimeTimeoutSigkill = setTimeout(() => {

                                runtimeDeferred.reject({
                                    type: 'error',
                                    error: 'Script execution has been interrupted with a hard reset: CPU limit reached'
                                });

                                runtimeChild._killRequest = true;
                                runtimeChild.kill('SIGKILL');
                                runtimeChild = null;

                                console.log('Runtime worker reset due to user CPU limit: ', runtimeData.user.username, runtimeData.cpu);

                                pubsub.publish(`user:${runtimeData.user._id}/cpu`, JSON.stringify({
                                    cpu: 'error'
                                }));

                                /*db.users.update({_id: runtimeData.user._id}, {$set: {
                                    skipTicksPenalty: 5
                                }});*/

                            }, 1000);
                        }
                        break;
                    case 'done':
                        clearTimeout(runtimeTimeoutSigkill);
                        clearTimeout(runtimeTimeoutSigint);

                        var $set = {
                            lastUsedCpu: message.usedTime,
                            lastUsedDirtyTime: message.usedDirtyTime
                        };
                        if(message.activeSegments) {
                            $set.activeSegments = message.activeSegments;
                        }
                        if(message.defaultPublicSegment !== undefined) {
                            $set.defaultPublicSegment = message.defaultPublicSegment;
                        }
                        if (runtimeData.cpu < Infinity) {
                            var newCpuAvailable = runtimeData.user.cpuAvailable + runtimeData.user.cpu - message.usedTime;
                            if(newCpuAvailable > config.engine.cpuBucketSize) {
                                newCpuAvailable = config.engine.cpuBucketSize;
                            }
                            $set.cpuAvailable = newCpuAvailable;
                        }
                        db.users.update({_id: runtimeData.user._id}, {$set});

                        if(message.activeForeignSegment !== undefined) {
                            if(message.activeForeignSegment === null) {
                                db.users.update({_id: runtimeData.user._id}, {$unset: {
                                    activeForeignSegment: true
                                }});
                            }
                            else {
                                if(runtimeData.user.activeForeignSegment &&
                                    message.activeForeignSegment.username == runtimeData.user.activeForeignSegment.username &&
                                    message.activeForeignSegment.id) {
                                    db.users.update({_id: runtimeData.user._id}, {$merge: {
                                        activeForeignSegment: {id: message.activeForeignSegment.id}
                                    }});
                                }
                                else {
                                    db.users.findOne({username: message.activeForeignSegment.username}, {defaultPublicSegment: true})
                                        .then(user => {
                                            message.activeForeignSegment.user_id = user._id;
                                            if(!message.activeForeignSegment.id && user.defaultPublicSegment) {
                                                message.activeForeignSegment.id = user.defaultPublicSegment;
                                            }
                                        })
                                        .finally(() => {
                                            db.users.update({_id: runtimeData.user._id}, {$set: {
                                                activeForeignSegment: message.activeForeignSegment
                                            }});
                                        })
                                }
                            }
                        }

                        pubsub.publish(`user:${runtimeData.user._id}/cpu`, JSON.stringify({
                            cpu: message.usedTime,
                            memory: message.memory.data.length
                        }));

                        message.username = runtimeData && runtimeData.user && runtimeData.user.username;

                        runtimeDeferred.resolve(message);
                        break;
                    case 'error':
                        clearTimeout(runtimeTimeoutSigkill);
                        clearTimeout(runtimeTimeoutSigint);

                        message.username = runtimeData && runtimeData.user && runtimeData.user.username;

                        runtimeDeferred.reject(message);


                        var $set = {
                            lastUsedCpu: message.usedTime,
                            lastUsedDirtyTime: message.usedDirtyTime
                        };
                        if (runtimeData.cpu < Infinity) {
                            var newCpuAvailable = runtimeData.user.cpuAvailable + runtimeData.user.cpu - message.usedTime;
                            if(newCpuAvailable > config.engine.cpuBucketSize) {
                                newCpuAvailable = config.engine.cpuBucketSize;
                            }
                            $set.cpuAvailable = newCpuAvailable;
                        }
                        db.users.update({_id: runtimeData.user._id}, {$set});

                        if (message.error == 'Script execution has been terminated: CPU limit reached') {
                            pubsub.publish(`user:${runtimeData.user._id}/cpu`, JSON.stringify({
                                cpu: 'error',
                                memory: message.memory.data.length
                            }));
                        }
                        else {
                            pubsub.publish(`user:${runtimeData.user._id}/cpu`, JSON.stringify({
                                cpu: message.usedTime,
                                memory: message.memory.data.length
                            }));
                        }
                        break;
                    case 'reject':
                        clearTimeout(runtimeTimeoutSigkill);
                        clearTimeout(runtimeTimeoutSigint);

                        message.username = runtimeData && runtimeData.user && runtimeData.user.username;
                        if(message.error) {

                            if(message.error == 'Security policy violation') {
                                runtimeChild._killRequest = true;
                                runtimeChild.kill('SIGKILL');
                                runtimeChild = null;
                            }

                            message.error = 'Script execution has been terminated due to a fatal error: '+message.error;
                        }
                        runtimeDeferred.reject(message);
                        break;
                    default:
                        break;
                }
            });

            runtimeChild.on('exit', function(code, signal) {

                clearTimeout(runtimeTimeoutSigkill);
                clearTimeout(runtimeTimeoutSigint);

                console.log(`Child runtime process ${this.pid} exited with code=${code} signal=${signal}`);

                if(this.connected) {
                    this.disconnect();
                }

                if(signal == 'SIGKILL' && this._killRequest) {
                    return;
                }

                if(runtimeChild === this) {
                    runtimeChild = null;
                    console.log(`Runtime worker reset due to child exit: code=${code} signal=${signal} user=${runtimeData.user.username} (${runtimeData.user._id}) promise pending=${runtimeDeferred.promise.isPending()}`);

                    if(runtimeDeferred.promise.isPending()) {
                        runtimeDeferred.reject({
                            type: 'error',
                            error: 'Script execution has been terminated: Unknown system error'
                        });
                    }
                }


            });
        }

        runtimeChild.send({userId, onlyInRoom});

        return runtimeDeferred.promise;
    });
};

exports.saveUserMemory = function(userId, memory, onlyInRoom) {

    if(memory.data.length > 2*1024*1024) {
        return q.reject('Script execution has been terminated: memory allocation limit reached');
    }

    if(onlyInRoom) {
        userId += ','+onlyInRoom;
    }

    return env.set(env.keys.MEMORY+userId, memory.data);
};

exports.saveUserMemorySegments = function(userId, segments) {

    if(Object.keys(segments).length > 0) {
        return env.hmset(env.keys.MEMORY_SEGMENTS+userId, segments);
    }
    return q.when();
};

exports.saveUserIntents = function(userId, intents) {
    var updates = [];
    for(var room in intents) {

        if(room == 'notify') {
            updates.push(checkNotificationOnline(userId)
                .then(() => {

                    if (intents.notify.length > 20) {
                        intents.notify = _.take(intents.notify, 20);
                    }

                    var promises = [q.when()];

                    intents.notify.forEach((i) => {
                        if (i.groupInterval < 0) {
                            i.groupInterval = 0;
                        }
                        if (i.groupInterval > 1440) {
                            i.groupInterval = 1440;
                        }
                        i.groupInterval *= 60 * 1000;
                        i.groupInterval = Math.floor(i.groupInterval);
                        var date = i.groupInterval ?
                            new Date(Math.ceil(new Date().getTime() / i.groupInterval) * i.groupInterval) :
                            new Date();


                        var message = (""+i.message).substring(0,500);

                        promises.push(db['users.notifications'].update({
                            $and: [
                                {user: userId},
                                {message},
                                {date: date.getTime()},
                                {type: 'msg'}
                            ]
                        }, {
                            $inc: {count: 1}
                        },
                        {upsert: true}));
                    });

                    return q.all(promises);
                }));
            continue;
        }

        if(room == 'market') {
            updates.push(db['market.intents'].insert({user: userId, intents: intents[room]}));
            continue;
        }

        updates.push(
        db['rooms.intents'].update({room}, {$merge: {users: {[userId]: {objects: intents[room]}}}}, {upsert: true}));
    }

    return q.all(updates);
};

exports.getAllRooms = function() {
    return db.rooms.find({active: true});
};

exports.getRoomIntents = function(roomId) {
    return db['rooms.intents'].findOne({room: roomId});
};

exports.getRoomObjects = function(roomId) {
    var result = {};
    return db['rooms.objects'].find({room: roomId})
        .then((objects) => {
            var users = {};
            result.objects = exports.mapById(objects, obj => {
                if(obj.user) {
                    users[obj.user] = true;
                }
            });
            users = Object.keys(users);
            if(users.length) {
                return db['users'].find({_id: {$in: users}})
            }
            else {
                return [];
            }
        })
        .then(users => {
            result.users = exports.mapById(users);
            return result;
        });
};

exports.getRoomFlags = function(roomId) {
    return db['rooms.flags'].find({room: roomId});
};

exports.getRoomTerrain = function(roomId) {
    return db['rooms.terrain'].find({room: roomId})
    .then((result) => exports.mapById(result));
};

exports.bulkObjectsWrite = function() {
    return bulk('rooms.objects');
};

exports.bulkFlagsWrite = function() {
    return bulk('rooms.flags');
};

exports.bulkUsersWrite = function() {
    return bulk('users');
};

exports.bulkRoomsWrite = function() {
    return bulk('rooms');
};

exports.bulkTransactionsWrite = function() {
    return bulk('transactions');
};

exports.bulkMarketOrders = function() {
    return bulk('market.orders');
};

exports.bulkUsersMoney = function() {
    return bulk('users.money');
};

exports.bulkUsersResources = function() {
    return bulk('users.resources');
};

exports.clearRoomIntents = function(roomId) {
    return db['rooms.intents'].removeWhere({room: roomId});
};

exports.clearMarketIntents = function(roomId) {
    return db['market.intents'].clear();
};


exports.mapById = function(array, fn) {
    return _.reduce(array, (result, i) => {
        result[i._id.toString()] = i;
        fn && fn(i);
        return result;
    }, {});
};

exports.notifyTickStarted = function() {
    return env.get(env.keys.MAIN_LOOP_PAUSED)
        .then(paused => {
            if(+paused) {
                return q.reject('Simulation paused');
            }
            return pubsub.publish(pubsub.keys.TICK_STARTED, "1");
        });
};


exports.notifyRoomsDone = function(gameTime) {
    return pubsub.publish(pubsub.keys.ROOMS_DONE, gameTime);
};

exports.sendConsoleMessages = function(userId, messages) {
    if(userId == '3') {
        if(messages.log.length) {
            console.log("Source Keeper console", messages.log);
        }
        return q.when();
    }
    if(userId == '2') {
        if(messages.log.length) {
            console.log("Invader console", messages.log);
        }
        return q.when();
    }
    return pubsub.publish(`user:${userId}/console`, JSON.stringify({messages, userId}));
};

exports.sendConsoleError = function(userId, error) {

    if(!error) {
        return q.when();
    }

    if(userId == '3') {
        console.log("Source Keeper error", _.isObject(error) && error.stack || error);
        return q.when();
    }

    if(userId == '2') {
        console.log("Invader error", _.isObject(error) && error.stack || error);
        return q.when();
    }

    error = error.toString();

    var user;

    db.users.findOne({_id: userId})
    .then((_user) => {
        user = _user;
        return checkNotificationOnline(user);
    })
    .then(() => {
        var interval = 30*60*1000;
        if(user.notifyPrefs && user.notifyPrefs.errorsInterval) {
            interval = user.notifyPrefs.errorsInterval * 60*1000;
        }
        var date = new Date(Math.ceil(new Date().getTime() / interval) * interval);

        db['users.notifications'].update({$and: [{user: userId}, {message: error}, {type: 'error'}, {date: {$lte: date.getTime()}}]},
        {$set: {user: userId, message: error, type: 'error', date: date.getTime()}, $inc: {count: 1}},
        {upsert: true});
    });


    return pubsub.publish(`user:${userId}/console`, JSON.stringify({userId, error}));
};

exports.getGameTime = function() {
    return common.getGametime();
};

exports.incrementGameTime = function() {
    return common.getGametime()
    .then(gameTime => env.set(env.keys.GAMETIME, gameTime+1));
};

exports.getRoomInfo = function(roomId) {
    return db.rooms.findOne({_id: roomId});
};

exports.saveRoomInfo = function(roomId, roomInfo) {
    return db.rooms.update({_id: roomId}, {$set: roomInfo});
};

exports.getInterRoom = () => {
    return q.all([
        common.getGametime(),
        db['rooms.objects'].find({$and: [{type: 'creep'}, {interRoom: {$ne: null}}]}),
        db.rooms.find({status: 'normal'})
            .then((rooms) => exports.mapById(_.filter(rooms, i => !i.openTime || i.openTime < Date.now()))),
        db['rooms.objects'].find({type: 'terminal'}),
        q.all([
            db['market.orders'].find(),
            db['market.intents'].find()
        ]).then(result => db.users.find({_id: {$in: _.map(result[0].concat(result[1]), 'user')}})
            .then(users => ({orders: result[0], intents: result[1], users})))
    ]);
};

exports.setRoomStatus = (roomId, status) => {
    return db.rooms.update({_id: roomId}, {$set: {status}});
};

exports.sendNotification = (userId, message) => {
    return checkNotificationOnline(userId)
    .then(() => db['users.notifications'].update({
        user: userId,
        message,
        date: {$lte: Date.now()},
        type: 'msg'
    }, {
        $set: {
            user: userId,
            message,
            date: Date.now(),
            type: 'msg'
        },
        $inc: {count: 1}
    }, {upsert: true}));
};

exports.getRoomStatsUpdater = (room) => {
    return {
        inc(name, userId, amount) {
            roomStatsUpdates[room] = roomStatsUpdates[room] || {};
            roomStatsUpdates[room][userId] = roomStatsUpdates[room][userId] || {};
            roomStatsUpdates[room][userId][name] = roomStatsUpdates[room][userId][name] || 0;
            roomStatsUpdates[room][userId][name] += amount;
        }
    }
};

exports.roomsStatsSave = () => {
    // TODO
    return q.when();
};


exports.updateAccessibleRoomsList = () => {
    return db.rooms.find({status: 'normal'})
    .then((rooms) => {
        var list = _(rooms).filter(i => !i.openTime || i.openTime < Date.now()).map('_id').value();
        return env.set(env.keys.ACCESSIBLE_ROOMS, JSON.stringify(list));
    });
};

exports.saveIdleTime = (name, time) => {
    return q.when();
};

exports.mapViewSave = (roomId, mapView) => {
    return env.set(env.keys.MAP_VIEW+roomId, JSON.stringify(mapView));
};

exports.commitDbBulk = () => {
    return q.when();
};

exports.getWorldSize = () => {
    return worldSize;
};

exports.addRoomToUser = (roomId, user, bulk) => {
    if(!user.rooms || user.rooms.indexOf(roomId) == -1) {
        bulk.addToSet(user, 'rooms', roomId);
    }
};

exports.removeRoomFromUser = (roomId, user, bulk) => {
    if(user.rooms && user.rooms.indexOf(roomId) != -1) {
        bulk.pull(user, 'rooms', roomId);
    }
};

exports.bufferFromBase64 = (base64) => {
    return Buffer.from(base64, 'base64');
};


function EvalCodeError(message) {
    this.toString = () => message;
}

var stripErrors = [
    'ContextifyScript.Script.runInNewContext',
    'engine\\dist',
    'engine/dist',
    'Object.exports.runInNewContext',
    'Object.exports.evalCode',
    'Object.exports.runCode',
    'process.EventEmitter.emit',
    'process.emit',
    'process.\&lt;anonymous>',
    'handleMessage',
    'requireFn',
    'Pipe.channel.onread',
    'Object.exports.makeRuntime',
    '_fulfilled',
    'self.promiseDispatch.done',
    'Promise.promise.promiseDispatch',
    'runner.js:'
];

exports.evalCode = function(module, globals, returnValue, timeout, scriptCachedData) {

    var options = {filename: module.name, breakOnSigint: true};

    var oldModule = globals.__module || {};

    globals.__module = module;

    if(!_.isUndefined(timeout) && timeout !== null && timeout !== 0 && timeout != Infinity) {
        options.timeout = timeout + 5;
        if(options.timeout < 30) {
            options.timeout = 30;
        }
    }

    if(scriptCachedData) {
        options.produceCachedData = true;
        if(scriptCachedData.cachedData && scriptCachedData.cachedData[module.name]) {
            options.cachedData = scriptCachedData.cachedData[module.name];
        }
    }

    try {

        if(!runtimeCache[module.user] || !runtimeCache[module.user].modules[module.name] ||
        runtimeCache[module.user].modules[module.name].timestamp != module.timestamp) {

            runtimeCache[module.user] = runtimeCache[module.user] || {};
            runtimeCache[module.user].modules = runtimeCache[module.user].modules || {};

            var code = module.code;

            if (!returnValue) {
                code = '(function __module(module,exports){ ' + module.code + "\n})(__module, __module.exports)";
            }
            var script = new vm.Script(code, options);

            if(scriptCachedData) {
                if(script.cachedDataProduced) {
                    scriptCachedData.cachedDataProduced = scriptCachedData.cachedDataProduced || {};
                    scriptCachedData.cachedDataProduced[module.name] = script.cachedData;
                }
                if(script.cachedDataRejected) {
                    scriptCachedData.cachedDataRejected = true;
                }
            }

            runtimeCache[module.user].modules[module.name] = {
                timestamp: module.timestamp,
                script
            };
        }

        globals.global = globals;

        var result = runtimeCache[module.user].modules[module.name].script.runInContext(globals, options);

        globals.module = oldModule;

        return result;
    }
    catch(e) {

        if(e.message == 'Script execution timed out.') {
            throw new EvalCodeError('Script execution timed out: CPU limit reached');
        }

        if(e.message == 'Script execution interrupted.') {
            throw new EvalCodeError('Script execution has been interrupted: CPU limit reached');
        }

        if(e instanceof EvalCodeError) throw e;

        var message = '';
        if(e.stack) {
            message = e.stack;
            message = message.replace(/</g,'&lt;');

            message = _.filter(message.split(/\n/), (i) => !_.any(stripErrors, s => i.indexOf(s) !== -1)).join("\n");

            message = message.replace(/ *at.*?$/, '');
            message = message.replace(/_console\d+:\d+/, 'console');

            message = _.filter(message.split(/\n/), (i) => !/ at /.test(i) || /\(/.test(i)).join("\n");

            message = message.replace(/at __module \((.*)\)/g, 'at $1');
        }
        else {
            message = e.message;
        }
        throw new EvalCodeError(message);
    }
};

exports.history = require('./history');

exports.native = require('../native/build/Release/native');

exports.pathFinder = require('./path-finder');

exports.queue = queue;

exports.constants = config.common.constants;

process.on('disconnect', () => process.exit());