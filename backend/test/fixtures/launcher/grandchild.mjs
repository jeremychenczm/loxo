// A long-lived descendant: records its pid, then idles until killed.
import fs from 'node:fs';

fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
