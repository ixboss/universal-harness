// Smoke-test helper: a minimal line-echo peer for transport tests.
// Reads newline-delimited JSON on stdin, echoes each frame back with type
// flipped to 'response'. Used to exercise real stdio round-trips.
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const env = JSON.parse(line);
      env.type = 'response';
      process.stdout.write(JSON.stringify(env) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ protocolVersion: 1, type: 'error', payload: { code: 'INVALID_MESSAGE' } }) + '\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
