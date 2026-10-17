import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "packages", "db", "src", "types", "supabase.gen.ts");
await mkdir(dirname(output), { recursive: true });
const result = spawnSync("supabase", ["gen", "types", "typescript", "--local"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
  shell: process.platform === "win32",
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const { writeFile } = await import("node:fs/promises");
await writeFile(output, result.stdout, "utf8");
console.log(`Generated ${output}`);
