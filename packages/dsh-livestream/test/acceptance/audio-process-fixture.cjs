/** Node-only replacement for audio encoder/probe in the isolated standard fixture. */
const { writeFileSync } = require('node:fs');
const [operation, output] = process.argv.slice(2);
if (operation === 'encode' && output) {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const frame = Buffer.concat([header, Buffer.alloc(417 - header.length)]);
  writeFileSync(output, Buffer.concat(Array.from({ length: 20 }, () => frame)));
} else if (operation === 'probe') {
  process.stdout.write('0.52\n');
} else {
  process.exitCode = 1;
}
