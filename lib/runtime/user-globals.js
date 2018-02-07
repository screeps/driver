var vm = require('vm'),
    _ = require('lodash');

var globals = {};
var timestamps = {};
var timeouts = {};

exports.init = function(userId, data) {
    userId = ""+userId;

    if(!globals[userId]) {
        globals[userId] = vm.createContext(data);
        timeouts[userId] = Date.now() + 360000 + Math.floor(30000 * Math.random());
    }
    else {
        _.extend(globals[userId], data);
    }
    globals[userId].gc = undefined;
    globals[userId].Promise = undefined;
};

exports.get = function(userId) {
    userId = ""+userId;
    return globals[userId];
};

exports.checkObsolete = function(userId, timestamp) {
    if(!timestamps[userId] || timestamp > timestamps[userId] || !timeouts[userId] || timeouts[userId] < Date.now()) {
        delete globals[userId];
        delete timeouts[userId];
        globals[userId] = null;
    }
    timestamps[userId] = timestamp || 1;
};

exports.clearAll = function() {
    for(var i in globals) {
        delete globals[i];
    }
    globals = {};
    timestamps = {};
    timeouts = {};
};
