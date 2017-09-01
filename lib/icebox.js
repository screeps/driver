// Since it is difficult to sandbox JS, this is a different approach.
// It is possible and easy to get access to the prototypes of the outside
// world's primitive objects, but that alone is not dangerous. It becomes
// dangerous when the host's prototypes are modified. So lets create an 
// icebox by freezing the host's objects and prototypes.

// The primary sandboxing technique that screeps uses is changing 
// Function.prototype.constructor so that client scripts can't access the 
// host's global scope.

const originalFunctionConstructor = Function.prototype.constructor;

var functionConstructor = Function.prototype.constructor;

Object.defineProperty(Function.prototype, 'constructor', {
    configurable: false,
    enumerable: false,
    get: function() {
        return functionConstructor;
    }
})

exports.partialSandbox = function partialSandbox(vmFunction, fn) {
    // Defer freezing to the last possible moment to allow any prototype
    // hacks like polyfills to execute before freezing takes place.
    freezeIceBox();

    try {
        functionConstructor = vmFunction;

        return fn();
    } catch (e) {
        console.error('partialSandbox err: ', e);
        throw e;
    } finally {
        functionConstructor = originalFunctionConstructor;
    }
}

const globalsToFreeze = [
    'Object',
    'Function',
    'Array',
    'Number',
    'Boolean',
    'Symbol',
    'Error',
    'EvalError',
    'InternalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
    'Math',
    'Date',
    'String',
    'RegExp',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Buffer',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'Atomics',
    'DataView',
    'JSON',
    'Promise',
    'Generator',
    'GeneratorFunction',
    'AsyncFunction',
    'Reflect',
    'Proxy',
];


function hasOwnProperty(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function freezeNotChildren(name, obj) {
    // Object.freeze is close to what we want, but it prevents setting
    // properties on child objects with the same name as a parent property.
    // So instead, if a property is set and this is not the same object,
    // redirect to defining a property on that object to mimic the default
    // behavior of setting the property.

    Object.defineProperty(obj, '__host', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: true,
    });

    var propKeys = Object.getOwnPropertyNames(obj);
    for (var key of propKeys) {
        var prop = Object.getOwnPropertyDescriptor(obj, key);
        if (!prop.configurable) continue; // can't touch this

        (function(key, prop) {
            if (prop.value) {
                Object.defineProperty(obj, key, {
                    configurable: false,
                    enumerable: prop.enumerable,
                    get: function() { return prop.value },
                    set: function(newval) {
                        if (obj === this)
                            throw new TypeError("Cannot assign to read only property '"+key
                                +"' of object '" + Object.prototype.toString.call(this) + "'");

                        // if we are trying to set this object on a child, then
                        // define the property to mimic a regular property set
                        Object.defineProperty(this, key, {
                            configurable: true,
                            enumerable: true,
                            writable: true,
                            value: newval
                        });

                        return newval;
                    }
                })
            } else if (prop.get || prop.set) {
                // these getters/setters usually know how to handle child objects already
                Object.defineProperty(obj, key, {
                    configurable: false,
                    enumerable: prop.enumerable,
                    get: prop.get,
                    set: prop.set
                })
            }
        })(key, prop);
    }

    Object.preventExtensions(obj);
}
exports.freezeNotChildren = freezeNotChildren;

function freezeIceBox() {
    if (freezeIceBox.frozen) return;
    freezeIceBox.frozen = true;

    for (var key of globalsToFreeze) {
        if (!hasOwnProperty(global, key))
            continue;

        let obj = global[key];
        if (hasOwnProperty(obj, 'prototype')){
            freezeNotChildren(key+'.prototype', obj.prototype);
        }

        freezeNotChildren(obj);
    }
}

exports.freezeIceBox = freezeIceBox;