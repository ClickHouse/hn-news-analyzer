// Deployment-only adapter. Local BEFORE/AFTER still runs through run.sh.
module.exports = require('../deploy/vercel/handler.cjs');
