// Long-lived descendant started by the fake agent's background step: records
// its pid, then idles until something kills it.
import fs from 'node:fs';

fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
