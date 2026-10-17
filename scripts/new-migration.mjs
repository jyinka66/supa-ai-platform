import { readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages", "db", "migrations");
const files = (await readdir(dir)).filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name));
const last = files.reduce((max, name) => Math.max(max, Number(name.slice(0, 4))), 0);
const rawName = process.argv.slice(2).join("_").toLowerCase() || "new_migration";
const name = rawName.replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 60) || "new_migration";
const sequence = String(last + 1).padStart(4, "0");
const output = join(dir, `${sequence}_${name}.sql`);
await writeFile(output, `-- ${sequence}_${name}.sql\n-- Add the migration SQL below, then run the local migration validator.\n\n`, { flag: "wx" });
console.log(`Created ${output}`);
