var common = require('@screeps/common'),
    env = common.storage.env,
    q = require('q'),
    driver = require('./index'),
    path = require('path'),
    engine = require('@screeps/engine'),
    game = engine.game,
    utils = engine.utils,
    fakeConsole = engine.console,
    _ = require('lodash'),
    runtimeUserGlobals = require('./runtime-user-globals'),
    WorldMapGrid = require('./mapgrid'),
    vm = require('vm');

var mapGrid;

var staticTerrainData = {};

var now;

var originalPrototypes = {};

var getSandboxedFunctionWrapperScript = new vm.Script("(function sandboxedFunctionWrapper(fn) { return function() { return fn.apply(this, arguments); } })");

['Number','String','Boolean','Date','Object','Function','Buffer','RangeError','ReferenceError','SyntaxError','TypeError','Error','Array','RegExp','Map','WeakMap','Set','WeakSet','Promise'].forEach(name => {
    originalPrototypes[name] = {
        protoMethods: {},
        globalMethods: {},
        prototype: global[name].prototype
    };

    Object.getOwnPropertyNames(global[name]).forEach(method => {
        try {
            if (typeof global[name][method] != 'function') {
                return;
            }
            originalPrototypes[name].globalMethods[method] = global[name][method];
        }
        catch(e) {}
    });

    Object.getOwnPropertyNames(global[name].prototype).forEach(method => {
        try {
            if (typeof global[name].prototype[method] != 'function') {
                return;
            }
            if(name == 'Function' && method == 'constructor') {
                return;
            }
            originalPrototypes[name].protoMethods[method] = global[name].prototype[method];
        }
        catch(e) {}
    });


});

function checkOriginalPrototypes() {
    for(var name in originalPrototypes) {
        if(global[name].prototype != originalPrototypes[name].prototype) {
            return `${name}.prototype`;
        }
        for(var method in originalPrototypes[name].globalMethods) {
            if(global[name][method] !== originalPrototypes[name].globalMethods[method]) {
                return `${name}.${method}`;
            }
        }
        for(var method in originalPrototypes[name].protoMethods) {
            if(global[name].prototype[method] !== originalPrototypes[name].protoMethods[method]) {
                return `${name}.prototype.${method}`;
            }
        }
    }

    if(Object.getOwnPropertyNames(Object.prototype).some(prop => {
            return prop != '__proto__' && !originalPrototypes.Object.protoMethods.hasOwnProperty(prop);
        })) {
        return 'Object.prototype';
    }

    return false;
}


var connectPromise = driver.connect('runtime')
    .then(() => {
        now = Date.now();
        return driver.getAllTerrainData();
    })
    .then((result) => {
        driver.pathFinder.init(result);

        result.forEach(room => {
            var array = new Uint8Array(2500);
            var char;
            for(var i=0;i<2500;i++) {
                char = room.terrain.charAt(i);
                array[i] = Number(char);
            }
            staticTerrainData[room.room] = array;
        })
    });

process.on('message', (message) => {

    if(!message.userId) return;

    var startDirtyTime = process.hrtime();

    connectPromise
    .then(() => q.all([
        driver.getRuntimeData(message.userId, message.onlyInRoom),
        env.get(env.keys.SCRIPT_CACHED_DATA + message.userId)
    ]))
    .then((data) => {

        let runtimeData = data[0];
        let scriptCachedData = {};
        scriptCachedData.cachedData = _.mapValues(data[1], i => Buffer.from(i, 'base64'));

        runtimeData.staticTerrainData = staticTerrainData;

        process.send({type: 'stats', name: 'getRuntimeData'});

        var intentCpu = 0.2,
            freeMethods = {say: true};

        var intents = {
            list: {},
            cpu: 0,
            set(id, name, data) {
                this.list[id] = this.list[id] || {};
                if(!freeMethods[name] && !this.list[id][name]) {
                    this.cpu += intentCpu;
                }
                this.list[id][name] = data;
            },
            push(name, data, maxLen) {
                this.list[name] = this.list[name] || [];
                if(maxLen && this.list[name].length >= maxLen) {
                    return false;
                }
                this.list[name].push(data);
                this.cpu += intentCpu;
                return true;
            },
            pushByName(id, name, data, maxLen) {
                this.list[id] = this.list[id] || {};
                this.list[id][name] = this.list[id][name] || [];
                if(maxLen && this.list[id][name].length >= maxLen) {
                    return false;
                }
                this.list[id][name].push(data);
                this.cpu += intentCpu;
                return true;
            },
            remove(id, name) {
                if(this.list[id] && this.list[id][name]) {
                    delete this.list[id][name];
                    return true;
                }
                return false;
            }
        };

        runtimeUserGlobals.checkObsolete(message.userId, runtimeData.userCodeTimestamp);
        runtimeUserGlobals.init(message.userId);

        var startTime = process.hrtime();

        var rawMemory = Object.create(null, {
            get: {
                value: function() {
                    return runtimeData.userMemory.data;
                }
            },
            set: {
                value: function (value) {
                    if (!_.isString(value)) {
                        throw new Error('Raw memory value is not a string');
                    }
                    if (value.length > 2 * 1024 * 1024) {
                        throw new Error('Raw memory length exceeded 2 MB limit');
                    }
                    if (this._parsed) {
                        delete this._parsed;
                    }
                    runtimeData.userMemory.data = value;
                }
            }
        });

        var getUsedCpu = function () {
            var elapsed = process.hrtime(startTime);
            elapsed = elapsed[0] * 1e3 + elapsed[1] / 1e6 + intents.cpu;
            return elapsed;
        };

        if(!mapGrid) {
            mapGrid = new WorldMapGrid(
                runtimeData.accessibleRooms,
                runtimeData.staticTerrainData);
        }
        runtimeData.mapGrid = mapGrid;

        var outMessage;

        try {

            var globals = runtimeUserGlobals.get(message.userId);
            var sandboxedFunctionWrapper = getSandboxedFunctionWrapperScript.runInContext(globals);

            Function.prototype.constructor = sandboxedFunctionWrapper().__proto__.constructor;

            game.runCode(
                runtimeUserGlobals.get(message.userId),
                sandboxedFunctionWrapper,
                runtimeData.userCode,
                runtimeData,
                intents,
                rawMemory,
                fakeConsole.makeConsole(runtimeData.user._id, sandboxedFunctionWrapper),
                runtimeData.consoleCommands,
                runtimeData.cpu,
                getUsedCpu,
                function () {
                    startTime = process.hrtime();
                    process.send({type: 'start'});
                },
                function(name) {
                    process.send({type: 'stats', name});
                },
                scriptCachedData);

            Function.prototype.constructor = Function;

            outMessage = {
                type: 'done'
            };

        }
        catch (e) {
            outMessage = {
                type: 'error',
                error: _.isObject(e) && e.stack || e.toString()
            };
        }

        var checkOriginalPrototypesResult = checkOriginalPrototypes();
        if(checkOriginalPrototypesResult) {
            return q.reject('Security policy violation');
        }



        if(scriptCachedData.cachedDataProduced) {
            env.hmset(
                env.keys.SCRIPT_CACHED_DATA + message.userId,
                _.mapValues(scriptCachedData.cachedDataProduced, i => i.toString('base64')))
            .then(() => env.expire(env.keys.SCRIPT_CACHED_DATA + message.userId, 3*3600));

        }
        if(scriptCachedData.cachedDataRejected) {
            env.del(env.keys.SCRIPT_CACHED_DATA + message.userId);
        }

        outMessage.usedTime = process.hrtime(startTime);
        outMessage.usedTime = Math.ceil(outMessage.usedTime[0] * 1e3 + outMessage.usedTime[1] / 1e6 + intents.cpu);

        outMessage.usedDirtyTime = process.hrtime(startDirtyTime);
        outMessage.usedDirtyTime = Math.ceil(outMessage.usedDirtyTime[0] * 1e3 + outMessage.usedDirtyTime[1] / 1e6);

        outMessage.intents = utils.storeIntents(message.userId, intents.list, runtimeData);
        outMessage.intentsCpu = intents.cpu;

        if(rawMemory._parsed) {
            runtimeData.userMemory.data = JSON.stringify(rawMemory._parsed);
        }
        outMessage.memory = runtimeData.userMemory;

        outMessage.console = {
            log: fakeConsole.getMessages(runtimeData.user._id),
            results: fakeConsole.getCommandResults(runtimeData.user._id)
        };

        process.send(outMessage);
    })
    .catch((e) => {
        if(e !== false) {
            console.log('Runtime getRuntimeData error:', e.stack || e);
        }
        process.send({type: 'reject', error: e !== false ? e.toString() : undefined})
    });
});


process.on('disconnect', () => process.exit());
