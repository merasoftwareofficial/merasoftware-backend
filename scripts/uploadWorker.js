require('dotenv').config();
const connect = require('../config/db');
const { configuration } = require('../helpers/stagedUploads');
const { startUploadWorker } = require('../helpers/uploadWorker');
(async () => { configuration(); await connect(); startUploadWorker({ keepAlive: true }); })().catch(error => { console.error(error.message); process.exitCode = 1; });
