'use strict';
/**
 * This script is a standalone test for the path finder. It runs a whole bunch of path finding
 * operations on real terrain data from a screeps server. It also verifies that the results are the
 * same as previous runs (kind of). This is also used for profile-guided optimization builds.
 */
const kWorldSize = 255;
const mod = require(`./build/${process.argv[2] || 'Release'}/native.node`);
mod.loadTerrain(require('./sample-terrain'));

function RoomPosition(x, y, roomName) {
	return { x, y, roomName };
}

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

// Generate a deterministic CostMatrix
let costMatrix = new Uint8Array(2500);
for (let ii = 0; ii < 2500; ++ii) {
	if (ii % 7 == 0) {
		costMatrix = ii % 11;
	}
}

// Various rooms around my world
let positions = [
	new RoomPosition(20, 39, 'W5N3'),
	new RoomPosition(31, 20, 'W5N4'),
	new RoomPosition(15, 30, 'W6N5'),
	new RoomPosition(14, 18, 'W7N5'),
	new RoomPosition(16, 41, 'W8N5'),
	new RoomPosition(35, 7, 'W6N2'),
	new RoomPosition(3, 25, 'W5N2'),
	new RoomPosition(4, 40, 'W4N1'),
	new RoomPosition(11, 36, 'W3N1'),
	new RoomPosition(33, 29, 'W2N2'),
	new RoomPosition(45, 5, 'W3N3'),
	new RoomPosition(31, 12, 'W4N4'),
	new RoomPosition(1, 27, 'W5N5'),
	new RoomPosition(17, 14, 'W6N6'),
	new RoomPosition(22, 14, 'W7N7'),
	new RoomPosition(21, 20, 'W8N8'),
	new RoomPosition(25, 33, 'W9N8'),
	new RoomPosition(29, 21, 'W10N10'),
	new RoomPosition(32, 26, 'W1N1'),
	new RoomPosition(32, 33, 'W2N2'),
	new RoomPosition(41, 35, 'W3N8'),
	new RoomPosition(20, 34, 'W3N7'),
	new RoomPosition(44, 33, 'W4N8'),
	new RoomPosition(44, 32, 'W3N7'),
].map(toWorldPosition);

// Find every point to every other point
let start = process.hrtime();
let checksum = 0;
for (let count = 0; count < 5; ++count) {
	for (let ii = 0; ii < positions.length; ++ii) {
		for (let jj = 0; jj < positions.length; ++jj) {
			if (ii === jj) continue;
			let ret = mod.search(
				positions[ii],
				[ { range: ii % 3, pos: positions[jj] } ],
				function() {
					if (jj % 5 == 0 && ii % 2 == 0) return false;
					return costMatrix;
				},
				1, 5,
				16, 100000, 100000,
				0,
				1.2
			);
			if (ret) {
				checksum += (ret.path ? ret.path.length : 0) + (ret.ops || 0);
			}
		}
	}
}
let time = process.hrtime(start);
if (checksum !== 11843305) {
	console.error('Incorrect results!');
	process.exit(1);
}
console.log(time[0] + time[1] / 1e9);
