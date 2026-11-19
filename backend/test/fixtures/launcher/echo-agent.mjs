// Prints its arguments as JSON, then echoes stdin lines; "bye" exits with code 3.
import readline from 'node:readline';

process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line === 'bye') process.exit(3);
  process.stdout.write(`echo:${line}\n`);
});
