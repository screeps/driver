const systemFunctions = {
    Object: {
        create: Object.create,
        keys: Object.keys,
        setPrototypeOf: Object.setPrototypeOf
    },
    JSON: {
        stringify: JSON.stringify,
        parse: JSON.parse
    },
    Math: {
        ceil: Math.ceil
    },
    Array: {
        push: Function.call.bind(Array.prototype.push),
        join: Function.call.bind(Array.prototype.join)
    }
};

function freezeDeep(obj) {
    Object.freeze(obj);
    for(const p of Object.getOwnPropertyNames(obj)) {
        if(typeof obj[p] === 'object') {
            freezeDeep(obj[p]);
        }
    }
}
freezeDeep(systemFunctions);

Object.assign(exports, systemFunctions);