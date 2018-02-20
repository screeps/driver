var pathfinding = require('@screeps/pathfinding'),
    driver = require('./runtime-driver'),
    C = driver.constants;

function roomNameToXY(name) {

    name = name.toUpperCase();

    var match = name.match(/^(\w)(\d+)(\w)(\d+)$/);
    if(!match) {
        return [undefined, undefined];
    }
    var [,hor,x,ver,y] = match;

    if(hor == 'W') {
        x = -x-1;
    }
    else {
        //x--;
        x = +x;
    }
    if(ver == 'N') {
        y = -y-1;
    }
    else {
        //y--;
        y = +y;
    }
    return [x,y];
};

/**
 * The Grid class, which serves as the encapsulation of the layout of the nodes.
 * @constructor
 * @param {number} width Number of columns of the grid.
 * @param {number} height Number of rows of the grid.
 * @param {Array.<Array.<(number|boolean)>>} [matrix] - A 0-1 matrix
 *     representing the walkable status of the nodes(0 or false for walkable).
 *     If the matrix is not supplied, all the nodes will be walkable.  */
function WorldMapGrid(accessibleRooms, staticTerrainData) {
    /**
     * The size of the grid.
     * @type number
     */
    this.width = this.height = driver.getWorldSize();

    /**
     * A 2D array of nodes.
     */
    this.nodes = this._buildNodes(this.width, this.height, accessibleRooms);

    /**
     * Number of exits in each direction for every room.
     */
    this.gridData = this._buildGridData(
            accessibleRooms, staticTerrainData);
}

/**
 * Build and return the grid data.
 * @private
 * @param {Array.<string>} accessibleRooms List of room names.
 * @param {Object.<string, Array.<number>>} staticTerrainData Terrain data for
 *     each room.
 * @return {Object.<string, Object.<string, number>>} The number of exits in
 *     each direction for every room, if any.
 */
WorldMapGrid.prototype._buildGridData = function(
        accessibleRooms, staticTerrainData) {
    if (!accessibleRooms) return {};
    const dirs = {
        t: {
            startx: 0,
            starty: 0,
            dx: 1,
            dy: 0,
        },
        r: {
            startx: 49,
            starty: 0,
            dx: 0,
            dy: 1,
        },
        b: {
            startx: 0,
            starty: 49,
            dx: 1,
            dy: 0,
        },
        l: {
            startx: 0,
            starty: 0,
            dx: 0,
            dy: 1,
        },
    };
    let gridData = {};
    for (let roomName of accessibleRooms) {
        let [x, y] = roomNameToXY(roomName);
        let terrain = staticTerrainData[roomName];
        let roomData = {};
        for (let dirName in dirs) {
            let {startx, starty, dx, dy} = dirs[dirName];
            let curx = startx;
            let cury = starty;
            let numExits = 0;
            for (let i = 0; i < 50; ++i) {
                if (terrain[cury * 50 + curx] == 0) {
                    numExits++;
                }
                curx += dx;
                cury += dy;
            }
            if (numExits > 0) {
                roomData[dirName] = numExits;
            }
        }
        gridData[`${x},${y}`] =  roomData;
    }
    return gridData;
}

/**
 * Build and return the nodes.
 * @private
 * @param {number} width
 * @param {number} height
 * @param {Array.<Array.<number|boolean>>} [accessibleRooms] - A 0-1 matrix representing
 *     the walkable status of the nodes.
 * @see Grid
 */
WorldMapGrid.prototype._buildNodes = function(width, height, accessibleRooms) {
    var i, j,
    nodes = {};

    for (i = -height/2; i < height/2; ++i) {
        nodes[i] = {};
        for (j = -width/2; j < width/2; ++j) {
            nodes[i][j] = new pathfinding.Node(j, i);
        }
    }
    if(accessibleRooms) {
        accessibleRooms.forEach((i) => {
            var [x,y] = roomNameToXY(i);
            if (nodes[y] && nodes[y][x]) {
                nodes[y][x].weight = 1;
            }
        });
    }

    return nodes;
};


WorldMapGrid.prototype.getNodeAt = function(x, y) {
    return this.nodes[y][x];
};


/**
 * Determine whether the node at the given position is walkable.
 * (Also returns false if the position is outside the grid.)
 * @param {number} x - The x coordinate of the node.
 * @param {number} y - The y coordinate of the node.
 * @return {boolean} - The walkability of the node.
 */
WorldMapGrid.prototype.isWalkableAt = function(x, y) {
    return this.isInside(x, y) && this.nodes[y][x].weight > 0;
};


/**
 * Determine whether the position is inside the grid.
 * XXX: `grid.isInside(x, y)` is wierd to read.
 * It should be `(x, y) is inside grid`, but I failed to find a better
 * name for this method.
 * @param {number} x
 * @param {number} y
 * @return {boolean}
 */
WorldMapGrid.prototype.isInside = function(x, y) {
    return (x >= -this.width/2 && x < this.width/2) && (y >= -this.height/2 && y < this.height/2);
};


/**
 * Set whether the node on the given position is walkable.
 * NOTE: throws exception if the coordinate is not inside the grid.
 * @param {number} x - The x coordinate of the node.
 * @param {number} y - The y coordinate of the node.
 * @param {boolean} walkable - Whether the position is walkable.
 */
WorldMapGrid.prototype.setWalkableAt = function(x, y, walkable) {

};


/**
 * Get the neighbors of the given node.
 *
 *     offsets      diagonalOffsets:
 *  +---+---+---+    +---+---+---+
 *  |   | 0 |   |    | 0 |   | 1 |
 *  +---+---+---+    +---+---+---+
 *  | 3 |   | 1 |    |   |   |   |
 *  +---+---+---+    +---+---+---+
 *  |   | 2 |   |    | 3 |   | 2 |
 *  +---+---+---+    +---+---+---+
 *
 *  When allowDiagonal is true, if offsets[i] is valid, then
 *  diagonalOffsets[i] and
 *  diagonalOffsets[(i + 1) % 4] is valid.
 * @param {Node} node
 * @param {DiagonalMovement} diagonalMovement
 */
WorldMapGrid.prototype.getNeighbors = function(node, diagonalMovement) {
    var x = node.x,
    y = node.y,
    neighbors = [],
    nodes = this.nodes;


    var gridNodeData = this.gridData[`${x},${y}`];

    if(!gridNodeData) {
        return [];
    }

    // ?
    if (gridNodeData.t && this.isWalkableAt(x,y-1)) {
        neighbors.push(nodes[y - 1][x]);
    }
    // ?
    if (gridNodeData.r && this.isWalkableAt(x+1,y)) {
        neighbors.push(nodes[y][x + 1]);
    }
    // ?
    if (gridNodeData.b && this.isWalkableAt(x,y+1)) {
        neighbors.push(nodes[y + 1][x]);
    }
    // ?
    if (gridNodeData.l && this.isWalkableAt(x-1,y)) {
        neighbors.push(nodes[y][x - 1]);
    }

    return neighbors;
};


/**
 * Get a clone of this grid.
 * @return {WorldMapGrid} Cloned grid.
 */
WorldMapGrid.prototype.clone = function() {
    var i, j,

    width = this.width,
    height = this.height,
    thisNodes = this.nodes,

    newGrid = new WorldMapGrid(),
    newNodes = {},
    row;

    for (i = -height/2; i < height/2; ++i) {
        newNodes[i] = {};
        for (j = -width/2; j < width/2; ++j) {
            newNodes[i][j] = new pathfinding.Node(j, i, thisNodes[i][j].walkable, thisNodes[i][j].weight);
        }
    }

    newGrid.nodes = newNodes;

    return newGrid;
};

module.exports = WorldMapGrid;
