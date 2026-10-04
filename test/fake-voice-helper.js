'use strict';

// Stands in for the PowerShell voice helper in tests: same line protocol.
// "fail" answers with an error, "crash" exits, anything else returns the
// UTF-8 text itself as the "audio" so tests can check the round trip.

process.stdout.write('ready\r\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const [id, b64] = line.split(' ');
    const text = Buffer.from(b64, 'base64').toString('utf8');
    if (text === 'crash') process.exit(1);
    if (text === 'fail') process.stdout.write(`${id} err ${Buffer.from('No voice installed').toString('base64')}\r\n`);
    else process.stdout.write(`${id} ok ${Buffer.from(text, 'utf8').toString('base64')}\r\n`);
  }
});
