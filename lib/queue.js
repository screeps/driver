var q = require('q'),
    _ = require('lodash'),
    register = {},
    common = require('@screeps/common'),
    queue = common.storage.queue,
    pubsub = common.storage.pubsub;

var terminated = false;

process.on('SIGTERM', () => {
    console.log('Got SIGTERM, disabling queue fetching');
    terminated = true;
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

exports.create = function (name) {

    if(name == 'users') {
        name = 'usersIvm';
    }

    if(!register[name]) {

        register[name] = {

            fetch() {
                if(terminated) {
                    return q.defer().promise;
                }
                return queue.fetch(name);
            },

            markDone(id) {
                return queue.markDone(name, id);
            },

            add(id) {
                return queue.add(name, id);
            },

            addMulti(array) {
                if (!array.length) {
                    return q.when();
                }
                return queue.addMulti(name, array);
            },

            whenAllDone() {
                return queue.whenAllDone(name);
            },

            reset() {
                return queue.reset(name);
            }
        };
    }

    return register[name];
};

exports.resetAll = function() {
    return q.all(Object.keys(register).map(i => queue.reset(i)));
};

exports.createDoneListener = function(name, fn) {
    pubsub.subscribe(pubsub.keys.QUEUE_DONE+name, fn);
};