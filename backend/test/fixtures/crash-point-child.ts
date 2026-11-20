import fs from 'node:fs';
import { crashPoint } from '../../src/modules/ownership/crash-points';

// Passes the same point three times and reports each pass on fd 1, which is
// written synchronously, so nothing buffered can be lost to the kill.
const say = (line: string) => fs.writeSync(1, `${line}\n`);

process.on('exit', () => say('exit-hook'));
try {
  for (let i = 1; i <= 3; i += 1) {
    const t0 = performance.now();
    crashPoint('wake.before_start');
    say(`passed ${i} ${Math.round(performance.now() - t0)}`);
  }
} finally {
  say('finally');
}
