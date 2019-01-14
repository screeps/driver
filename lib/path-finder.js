'use strict';

let _ = require('lodash');
let globals;

//
// Convert a room name to/from usable coordinates
// "E1N1" -> { xx: 129, yy: 126 }
let kWorldSize = 255; // Talk to marcel before growing world larger than W127N127 :: E127S127
function parseRoomName(roomName) {
    let room = /^([WE])([0-9]+)([NS])([0-9]+)$/.exec(roomName);
    if (!room) {
        throw new Error('Invalid room name');
    }
    let rx = (kWorldSize >> 1) + (room[1] === 'W' ? -Number(room[2]) : Number(room[2]) + 1);
    let ry = (kWorldSize >> 1) + (room[3] === 'N' ? -Number(room[4]) : Number(room[4]) + 1);
    if (!(rx >=0 && rx <= kWorldSize && ry >= 0 && ry <= kWorldSize)) {
        throw new Error('Invalid room name');
    }
    return { xx: rx, yy: ry };
}

exports.init = function init(mod, rooms) {

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

    if (mod.version !== 11) {
        throw new Error('Invalid pathfinder binary');
    }
    mod.loadTerrain(terrainData);
};

module.exports.create = function create(mod) {
//
// Converts return value of `parseRoomName` back into a normal room name
    function generateRoomName(xx, yy) {
        return (
            (xx <= kWorldSize >> 1 ? 'W'+ ((kWorldSize >> 1) - xx) : 'E'+ (xx - (kWorldSize >> 1) - 1))+
            (yy <= kWorldSize >> 1 ? 'N'+ ((kWorldSize >> 1) - yy) : 'S'+ (yy - (kWorldSize >> 1) - 1))
        );
    }
//
// Helper function to convert RoomPosition objects into global coordinate objects
    function toWorldPosition(rp) {

        let xx = rp.x | 0, yy = rp.y | 0;
        if (!(xx >=0 && xx < 50 && yy >= 0 && yy < 50)) {
            throw new Error('Invalid room position');
        }
        let offset = parseRoomName(rp.roomName);
        return {
            xx: xx + offset.xx * 50,
            yy: yy + offset.yy * 50,
        };
    }

//
// Converts back to a RoomPosition
    function fromWorldPosition(wp) {
        return new globals.RoomPosition(
            wp[0] % 50,
            wp[1] % 50,
            generateRoomName(Math.floor(wp[0] / 50), Math.floor(wp[1] / 50))
        );
    }

    const make = function (_globals) {
        globals = _globals;
    };

    const search = function (origin, goal, options) {

        // Options
        options = options || {};
        let plainCost = Math.min(254, Math.max(1, (options.plainCost | 0) || 1));
        let swampCost = Math.min(254, Math.max(1, (options.swampCost | 0) || 5));
        let heuristicWeight = Math.min(9, Math.max(1, options.heuristicWeight || 1));
        let maxOps = Math.max(1, (options.maxOps | 0) || 2000);
        let maxCost = Math.max(1, (options.maxCost | 0) || 0xffffffff);
        let maxRooms = Math.min(64, Math.max(1, (options.maxRooms | 0) || 16));
        let flee = !!options.flee;

        // Convert one-or-many goal into standard format for native extension
        let goals = _.map(Array.isArray(goal) ? goal : [ goal ], function(goal) {
            if (goal.x !== undefined && goal.y !== undefined && goal.roomName !== undefined) {
                return {
                    range: 0,
                    pos: toWorldPosition(goal),
                };
            } else {
                let range = Math.max(0, goal.range | 0);
                return {
                    range: range,
                    pos: toWorldPosition(goal.pos),
                };
            }
        });

        // Setup room callback
        let cb = options.roomCallback;
        if (cb) {
            if (typeof cb !== 'function') {
                cb = undefined;
            } else {
                cb = function(cb) {
                    return function(xx, yy) {
                        let ret = cb(generateRoomName(xx, yy));
                        if (ret === false) {
                            return ret;
                        } else if (ret) {
                            return ret._bits;
                        }
                    };
                }(cb);
            }
        }

        // Invoke native code
        let ret = mod.search(toWorldPosition(origin), goals, cb, plainCost, swampCost, maxRooms, maxOps, maxCost, flee, heuristicWeight);
        if (ret === undefined) {
            return { path: [], ops: 0, cost: 0, incomplete: false };
        } else if (ret === -1) {
            return { path: [], ops: 0, cost: 0, incomplete: true };
        }
        ret.path = ret.path.map(fromWorldPosition).reverse();
        return ret;
    };

    return {make, search};
};
