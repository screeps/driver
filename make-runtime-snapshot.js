const path = require('path');
const ivm = require('isolated-vm');
const fs = require('fs');
let code = fs.readFileSync(path.resolve(__dirname, './build/runtime.bundle.js'), {encoding: 'utf8'});
let snapshot = ivm.Isolate.createSnapshot([ { code, filename: '<runtime>' } ]);
let buffer = Buffer.from(snapshot.copy());
fs.writeFileSync(path.resolve(__dirname, './build/runtime.snapshot.bin'), buffer);
console.log(`Runtime snapshot created (${buffer.length} bytes)`);
process.exit();
