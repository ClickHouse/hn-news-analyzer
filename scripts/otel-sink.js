// Tiny local OTel collector sink for debugging.
// Accepts POST /v1/logs (and /v1/traces, /v1/metrics) on :14318, decodes the
// JSON body, and pretty-prints the payload so we can see exactly what the
// SDK is shipping. Always returns HTTP 200 with the OTLP {"partialSuccess":{}}
// shape so the SDK is happy.

const http = require('http');

http
  .createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      const auth = req.headers['authorization'];
      console.log(`\n=== ${req.method} ${req.url} (${ct}) auth=${auth ? auth.slice(0, 8) + '…' : 'NONE'} ===`);
      if (ct.includes('application/json')) {
        try {
          console.log(JSON.stringify(JSON.parse(body), null, 2));
        } catch {
          console.log(body);
        }
      } else {
        console.log(`(non-JSON body, ${body.length} bytes — likely protobuf)`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"partialSuccess":{}}');
    });
  })
  .listen(14318, () => console.log('otel-sink listening on http://localhost:14318'));
