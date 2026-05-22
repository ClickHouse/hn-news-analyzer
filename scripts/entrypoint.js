// Tiny shim that loads our compiled server *after* triggering HyperDX's
// `require('console')` hook so that calls to global console.{log,info,warn,
// error,debug} are captured and shipped as OTel log records.
//
// Why this exists:
//   The HyperDX console-capture instrumentation hooks `require('console')`
//   (via require-in-the-middle). Modern apps almost never call that
//   explicitly — they use the global `console` directly — so the hook never
//   fires and no logs are emitted. Calling `require('console')` once forces
//   the hook to run, and because `require('console') === global.console` in
//   Node.js, the global console is wrapped from then on.
//
// This file is invoked by `opentelemetry-instrument` in the AFTER toggle of
// run.sh. `opentelemetry-instrument` first awaits the HyperDX tracing init
// (which installs the hook) and then `require()`s whatever path we pass —
// so by the time the line below runs, the hook is ready to catch the call.
//
// In the BEFORE toggle (plain `node scripts/entrypoint.js`), no hook is
// installed, so `require('console')` is a harmless no-op.

require('console');
require('../dist/server/index.js');
