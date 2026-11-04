import fs from "node:fs";
import path from "node:path";
const root=path.resolve("src/migrations/meta");
const snapshots=fs.readdirSync(root).filter(name=>/^\d+_snapshot\.json$/.test(name)).sort().reverse();
for(const name of snapshots.slice(5))fs.unlinkSync(path.join(root,name));
