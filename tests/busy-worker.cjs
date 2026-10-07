const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const start = Date.now();
while (Date.now()-start < 350) {}
fs.writeFileSync(workerData.marker, 'late');
parentPort.postMessage('finished');
