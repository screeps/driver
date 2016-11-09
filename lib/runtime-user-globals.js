var vm = require('vm'),
    _ = require('lodash');

var globals = {};
var timestamps = {};

exports.init = function(userId, data) {
    userId = ""+userId;

    if(!globals[userId]) {
        globals[userId] = vm.createContext(data);
    }
    else {
        _.extend(globals[userId], data);
    }
    globals[userId].gc = undefined;
};

exports.get = function(userId) {
    userId = ""+userId;
    return globals[userId];
};

exports.checkObsolete = function(userId, timestamp) {
    if(!timestamps[userId] || timestamp > timestamps[userId]) {
        delete globals[userId];
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
};