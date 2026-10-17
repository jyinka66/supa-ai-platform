import { readdir, mkdir, copyFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "packages", "db", "migrations");
const destinationDir = join(root, "supabase", "migrations");
await mkdir(destinationDir, { recursive: true });
const sourceFiles = (await readdir(sourceDir)).filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name)).sort();
if (!sourceFiles.length) throw new Error(`No numbered SQL migrations found in ${sourceDir}`);
const destinationFiles = await readdir(destinationDir);
const wanted = new Set();
for (const name of sourceFiles) {
  const match = name.match(/^(\d{4})_(.+\.sql)$/i);
  if (!match) continue;
  const sequence = Number(match[1]);
  // Supabase CLI expects timestamp-like migration versions. Keep the original
  // 4-digit sequence as the sortable suffix while retaining one source of truth.
  const version = `20261017${String(sequence).padStart(6, "0")}`;
  const outputName = `${version}_${match[2]}`;
  wanted.add(outputName);
  await copyFile(join(sourceDir, name), join(destinationDir, outputName));
}
for (const name of destinationFiles) {
  if (/^\d{14}_[a-z0-9_-]+\.sql$/i.test(name) && !wanted.has(name)) {
    await unlink(join(destinationDir, name));
  }
}
console.log(`Synchronized ${wanted.size} SQL migrations into supabase/migrations.`);
