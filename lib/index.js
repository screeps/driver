var bulk = require('./bulk'),
    queue = require('./queue'),
    EventEmitter = require('events').EventEmitter,
    common = require('@screeps/common'),
    db = common.storage.db,
    env = common.storage.env,
    pubsub = common.storage.pubsub,
    config = Object.assign(common.configManager.config, {engine: new EventEmitter()}),
    q = require('q'),
    _ = require('lodash'),
    os = require('os'),
    zlib = require('zlib'),
    runtimeUserVm = require('./runtime/user-vm'),
    roomStatsUpdates = {},
    genericPool = require('generic-pool'),
    worldSize;

_.extend(config.engine, {
    driver: exports,
    mainLoopMinDuration: 200,
    mainLoopResetInterval: 5000,
    mainLoopCustomStage() {
        return q.when();
    },
    cpuMaxPerTick: 500,
    cpuBucketSize: 10000,
    customIntentTypes: {},
    historyChunkSize: 20,
    useSigintTimeout: false,
    reportMemoryUsageInterval: 0,
    enableInspector: false,
});

config.engine.on('playerSandbox', (sandbox) => {
    sandbox.run(`Game.shard = Object.create(null, {
        name: {
            value: "${os.hostname()}",
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
    });`);
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

function getAllTerrainData() {
    return env.get(env.keys.TERRAIN_DATA)
        .then(compressed => {
            const buf = Buffer.from(compressed, 'base64');
            return q.ninvoke(zlib, 'inflate', buf);
        })
        .then(data => JSON.parse(data));
}

exports.getAllTerrainData = getAllTerrainData;

const pathFinderFactory = require('./path-finder');
exports.pathFinder = pathFinderFactory.create(require('../native/build/Release/native'));

exports.connect = function(processType) {

    common.configManager.load();

    return common.storage._connect()
    .then(() => {

        if (processType == 'runner') {
            runtimeUserVm.init();
            pubsub.subscribe(pubsub.keys.RUNTIME_RESTART, () => {
                console.log('runtime restart signal');
                runtimeUserVm.clearAll();
            });
        }

        if (processType == 'runtime') {
        }

        if (processType == 'processor') {
            getAllTerrainData()
                .then(rooms => pathFinderFactory.init(require('../native/build/Release/native'), rooms));
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

exports.getAllUsers = function() {
    return db.users.find({$and: [{active: {$ne: 0}}, {cpu: {$gt: 0}}]})
    .then((data) => {
        data.sort((a,b) => (b.lastUsedDirtyTime || 0) - (a.lastUsedDirtyTime || 0));

        return data;
    })
};

exports.saveUserMemory = function(userId, memory) {

    if(memory.data.length > 2*1024*1024) {
        return q.reject('Script execution has been terminated: memory allocation limit reached');
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

        if(room == 'global') {
            updates.push(db['users.intents'].insert({user: userId, intents: intents[room]}));
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

exports.bulkMarketIntershardOrders = function() {
    return bulk('market.orders');
};

exports.bulkUsersMoney = function() {
    return bulk('users.money');
};

exports.bulkUsersResources = function() {
    return bulk('users.resources');
};

exports.bulkUsersPowerCreeps = function() {
    return bulk('users.power_creeps');
};

exports.clearRoomIntents = function(roomId) {
    return db['rooms.intents'].removeWhere({room: roomId});
};

exports.clearGlobalIntents = function() {
    return db['users.intents'].clear();
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
        db['rooms.objects'].find({$and: [{type: {$in: ['creep','powerCreep']}}, {interRoom: {$ne: null}}]}),
        db.rooms.find({status: 'normal'})
            .then((rooms) => exports.mapById(_.filter(rooms, i => !i.openTime || i.openTime < Date.now()))),
        db['rooms.objects'].find({type: {$in: ['terminal', 'powerSpawn', 'powerCreep']}}),
        q.all([
            db['market.orders'].find(),
            db['users.power_creeps'].find(),
            db['users.intents'].find()
        ]).then(result => db.users.find({_id: {$in: _.map(_.flatten(result), 'user')}})
            .then(users => ({
                users,
                orders: result[0],
                userPowerCreeps: result[1],
                userIntents: result[2],
                shardName: ''
            })))
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

exports.startLoop = function(name, fn) {

    let counter = 0;

    const pool = genericPool.createPool({
        create() { return {name: name + (counter++)} },
        destroy() {}
    }, {
        max: process.env.RUNNER_THREADS || 2,
        min: 0
    });


    function loop() {
        pool.acquire().then(poolItem => {
            setTimeout(loop, 0);
            return fn().finally(() => {
                pool.release(poolItem);
            });
        });
    }

    loop();
};

exports.saveRoomEventLog = function saveRoomEventLog(roomId, eventLog) {
    return env.hset(env.keys.ROOM_EVENT_LOG, roomId, JSON.stringify(eventLog));
};

exports.makeRuntime = require('./runtime/make');

exports.history = require('./history');

exports.queue = queue;

exports.constants = config.common.constants;

exports.strongholds = common.configManager.config.common.strongholds;

process.on('disconnect', () => process.exit());
