var q = require('q'),
    _ = require('lodash'),
    common = require('@screeps/common'),
    config = common.configManager.config,
    env = common.storage.env;

exports.saveTick = function(roomId, gameTime, data) {
    return env.hmset(env.keys.ROOM_HISTORY + roomId, {[gameTime]: data});
};

exports.upload = function(roomId, baseTime) {
    return env.get(env.keys.ROOM_HISTORY + roomId)
        .then(data => {

            if(!data || !data[""+baseTime]) {
                return;
            }

            var curTick = baseTime,
                curObjects = JSON.parse(data[""+baseTime]),
                result = {
                    timestamp: Date.now(),
                    room: roomId,
                    base: curTick,
                    ticks: {
                        [curTick]: curObjects
                    }
                };

            curTick++;
            while(data[""+curTick]) {
                var objects = JSON.parse(data[""+curTick]);
                var diff = common.getDiff(curObjects, objects);
                result.ticks[curTick] = diff;
                curObjects = objects;
                curTick++;
            }

            config.engine.emit('saveRoomHistory',roomId, baseTime, result);

            return env.del(env.keys.ROOM_HISTORY + roomId);
        });
};
