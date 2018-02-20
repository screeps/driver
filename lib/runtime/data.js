var bulk = require('../bulk'),
    queue = require('../queue'),
    EventEmitter = require('events').EventEmitter,
    common = require('@screeps/common'),
    db = common.storage.db,
    env = common.storage.env,
    config = common.configManager.config,
    q = require('q'),
    vm = require('vm'),
    _ = require('lodash'),
    child_process = require('child_process'),
    os = require('os'),
    util = require('util'),
    zlib = require('zlib'),
    driver = require('../index'),
    accessibleRoomsCache = {
        timestamp: 0
    },
    cachedMarketOrders = {
        gameTime: 0,
        orders: {}
    };

function getCachedMarketOrders(gameTime) {
    if(gameTime == cachedMarketOrders.gameTime) {
        return q.when(cachedMarketOrders.orders);
    }
    return db['market.orders'].find({active: true})
        .then(orders => {
            var result = {all: {}};
            orders.forEach(i => {
                i.id = ""+i._id;
                delete i._id;
                result[i.resourceType] = result[i.resourceType] || {};
                result[i.resourceType][i.id] = i;
                result.all[i.id] = i;
            });
            cachedMarketOrders.orders = result;
            cachedMarketOrders.gameTime = gameTime;
            return result;
        });
}

function getAccessibleRooms() {
    if(Date.now() > accessibleRoomsCache.timestamp + 60*1000) {
        accessibleRoomsCache.timestamp = Date.now();
        return env.get(env.keys.ACCESSIBLE_ROOMS).then(data => {
            accessibleRoomsCache.data = data;
            return accessibleRoomsCache.data;
        });
    }
    return q.when(accessibleRoomsCache.data);

}

exports.getAllTerrainData = () => {
    return env.get(env.keys.TERRAIN_DATA)
        .then(compressed => {
            const buf = Buffer.from(compressed, 'base64');
            return q.ninvoke(zlib, 'inflate', buf);
        })
        .then(data => JSON.parse(data));
};

exports.get = function(userId, onlyInRoom) {
    var userObjects, runtimeData;

    var objectsQuery, memoryKey;

    if(onlyInRoom) {
        objectsQuery = {$and: [{user: userId}, {room: onlyInRoom}]};
        memoryKey = userId+','+onlyInRoom;
    }
    else {
        objectsQuery = {user: userId};
        memoryKey = userId;
    }

    var userIdsHash = {[userId]: true};

    return db['rooms.objects'].find(objectsQuery)
        .then((_userObjects) => {

            if(!_userObjects.length) {
                if(!onlyInRoom) {
                    db.users.update({_id: userId}, {$set: {active: 0}});
                }
                return q.reject(false);
            }

            userObjects = driver.mapById(_userObjects);

            var roomIdsHash = {}, roomIds = [];
            _userObjects.forEach((i) => {

                if(i.type == 'flag' || i.type == 'constructionSite') {
                    return;
                }
                roomIdsHash[i.room] = true;
                if(i.type == 'observer') {
                    roomIdsHash[i.observeRoom] = true;
                }
                if(i.type == 'controller' && i.sign) {
                    userIdsHash[i.sign.user] = true;
                }
            });
            for(var i in roomIdsHash) {
                roomIds.push(i);
            }

            return q.all([
                db.users.findOne({_id: userId}),
                db['users.code'].findOne({$and: [{user: userId}, {activeWorld: true}]}),
                env.get(env.keys.MEMORY+memoryKey),
                db['users.console'].find({user: userId}),
                common.getGametime(),
                db.rooms.find({_id: {$in: roomIds}}),
                db['rooms.objects'].find({$and: [{room: {$in: roomIds}}, {user: {$ne: userId}}]}),
                getAccessibleRooms(),
                db.transactions.findEx({sender: userId}, {sort: {time:-1}, limit: 100}),
                db.transactions.findEx({recipient: userId}, {sort: {time:-1}, limit: 100}),
                db['rooms.flags'].find({user: userId})
            ]);
        }).then((result) => {

            var gameTime = result[4];

            db['users.console'].removeWhere({_id: {$in: _.map(result[3], (i) => i._id)}});

            var cpu, cpuBucket;
            if(result[0].cpu) {
                cpuBucket = result[0].cpuAvailable || 0;
                if(cpuBucket < 0) {
                    cpuBucket = 0;
                }
                cpu = cpuBucket + result[0].cpu;
                if(cpu > config.engine.cpuMaxPerTick) {
                    cpu = config.engine.cpuMaxPerTick;
                }
            }
            else {
                cpu = Infinity;
                cpuBucket = Infinity;
            }

            var modules = result[1] && result[1].modules || {};
            for(var key in modules) {
                var newKey = key.replace(/\$DOT\$/g, '.');
                newKey = newKey.replace(/\$SLASH\$/g, '/');
                newKey = newKey.replace(/\$BACKSLASH\$/g, '\\');
                if(newKey != key) {
                    modules[newKey] = modules[key];
                    delete modules[key];
                }
            }

            var userIds = [];
            result[6].forEach((i) => {
                if(i.user) {
                    userIdsHash[i.user] = true;
                }
                if(i.type == 'controller' && i.reservation) {
                    userIdsHash[i.reservation.user] = true;
                }
                if(i.type == 'controller' && i.sign) {
                    userIdsHash[i.sign.user] = true;
                }
            });
            result[8].forEach(i => i.recipient && (userIdsHash[i.recipient] = true));
            result[9].forEach(i => i.sender && (userIdsHash[i.sender] = true));
            Object.getOwnPropertyNames(userIdsHash).forEach(function(i) {
                userIds.push(i);
            });

            runtimeData = {
                userObjects,
                user: result[0],
                userCode: modules,
                userCodeTimestamp: result[1] && result[1].timestamp || 0,
                userMemory: {data: result[2] || "", userId},
                consoleCommands: result[3],
                time: gameTime,
                rooms: driver.mapById(result[5]),
                roomObjects: _.extend(driver.mapById(result[6]), userObjects),
                flags: result[10],
                accessibleRooms: result[7],
                transactions: {
                    outgoing: result[8],
                    incoming: result[9]
                },
                cpu,
                cpuBucket
            };

            return q.all([
                db.users.find({_id: {$in: userIds}}),
                getCachedMarketOrders(gameTime),
                db['market.orders'].find({user: userId}),
                result[0].activeSegments && result[0].activeSegments.length > 0 ?
                    env.hmget(env.keys.MEMORY_SEGMENTS+userId, result[0].activeSegments) :
                    q.when(),
                result[0].activeForeignSegment && result[0].activeForeignSegment.user_id && result[0].activeForeignSegment.id ?
                    q.all([
                        env.hget(
                            env.keys.MEMORY_SEGMENTS+result[0].activeForeignSegment.user_id,
                            result[0].activeForeignSegment.id),
                        env.get(env.keys.PUBLIC_MEMORY_SEGMENTS+result[0].activeForeignSegment.user_id)
                    ]) :
                    q.when()
            ]);

        }).then((result) => {
            runtimeData.users = driver.mapById(result[0]);
            runtimeData.market = {
                orders: result[1],
                myOrders: result[2]
            };
            if(result[3]) {
                runtimeData.memorySegments = {};
                for(var i=0; i<runtimeData.user.activeSegments.length; i++) {
                    runtimeData.memorySegments[runtimeData.user.activeSegments[i]] = result[3][i] || "";
                }
            }
            if(result[4] && result[4][1] && result[4][1].split(',').indexOf(""+runtimeData.user.activeForeignSegment.id) != -1) {
                runtimeData.foreignMemorySegment = {
                    username: runtimeData.user.activeForeignSegment.username,
                    id: runtimeData.user.activeForeignSegment.id,
                    data: result[4][0]
                };
            }
            return runtimeData;
        })

};
