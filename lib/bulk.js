var q = require('q'),
    _ = require('lodash'),
    common = require('@screeps/common');


function removeHidden(obj) {
    for(var i in obj) {
        if(i[0] == '_') {
            delete obj[i];
            continue;
        }
        if(_.isArray(obj[i])) {
            obj[i].forEach(removeHidden);
            continue;
        }
        if(_.isObject(obj[i])) {
            removeHidden(obj[i]);
        }
    }
    if(obj.$loki) {
        delete obj.$loki;
    }
}

module.exports = function(collectionName) {

    var bulk = [],
        opsCnt = 0,
        updates = {};

    return {
        update(id, data) {
            if(!id) {
                return;
            }
            opsCnt++;
            data = _.cloneDeep(data);

            _.forEach(data, (value, key) => {
                if(_.isObject(value)) {
                    if (!_.isObject(id)) {
                        throw new Error(`can not update an object diff property '${key}' without object reference`);
                    }
                    var originalValue = id[key] || {};
                    _.merge(originalValue, value);
                    data[key] = originalValue;
                }
            });
            if(_.isObject(id)) {
                _.merge(id, data);
                id = id._id;
            }

            removeHidden(data);

            updates[id] = updates[id] || {};
            _.extend(updates[id], data);
        },
        insert(data, id) {
            data = _.cloneDeep(data);
            removeHidden(data);

            if(id) {
                data._id = id;
            }

            opsCnt++;
            bulk.push({op: 'insert', data});
        },
        remove(id) {
            if(!id) {
                return;
            }
            opsCnt++;
            bulk.push({op: 'remove', id});
        },
        inc(id, key, amount) {
            if(!id) {
                return;
            }
            if (_.isObject(id)) {
                id[key] = (id[key] || 0) + amount;
                id = id._id;
            }
            opsCnt++;
            bulk.push({op: 'update', id, update: {$inc: {[key]: amount}}});
        },
        addToSet(id, key, value) {
            if(!id) {
                return;
            }
            if (_.isObject(id)) {
                id = id._id;
            }
            opsCnt++;
            bulk.push({op: 'update', id, update: {$addToSet: {[key]: value}}});
        },
        pull(id, key, value) {
            if(!id) {
                return;
            }
            if (_.isObject(id)) {
                id = id._id;
            }
            opsCnt++;
            bulk.push({op: 'update', id, update: {$pull: {[key]: value}}});
        },
        execute() {
            if(!opsCnt) return q.when({});
            for(var id in updates) {
                bulk.push({op: 'update', id, update: {$set: updates[id]}});
            }
            return common.storage.db[collectionName].bulk(bulk);
        }
    }

};