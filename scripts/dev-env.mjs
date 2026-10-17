import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "apps", "web", ".env.local");
const rootOutput = join(root, ".env");
const force = process.argv.includes("--force");
let existing = "";
let existingRoot = "";
try { existing = await readFile(output, "utf8"); } catch { /* first setup */ }
try { existingRoot = await readFile(rootOutput, "utf8"); } catch { /* first setup */ }
if (existing && existingRoot && !force) {
  console.log("Local .env files already exist; leaving them unchanged (pass --force to refresh Supabase values).");
  process.exit(0);
}
if (existing && !existingRoot && !force) {
  await writeFile(rootOutput, existing, { mode: 0o600 });
  console.log(`Copied existing app environment to ${rootOutput} for workspace tooling.`);
  process.exit(0);
}
const status = execSync("supabase status -o env", { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
const values = {};
for (const line of status.split(/\r?\n/)) {
  const match = line.match(/^(?:export\s+)?([A-Z_]+)=(.*)$/);
  if (!match) continue;
  values[match[1]] = match[2].replace(/^"|"$/g, "");
}
const priorKey = (existing.match(/^SENSITIVE_DATA_ENCRYPTION_KEY=(.+)$/m)?.[1] ?? existingRoot.match(/^SENSITIVE_DATA_ENCRYPTION_KEY=(.+)$/m)?.[1]);
const encryptionKey = priorKey && /^[a-f0-9]{64}$/i.test(priorKey) ? priorKey : randomBytes(32).toString("hex");
const apiUrl = values.API_URL ?? "http://127.0.0.1:54321";
const anonKey = values.ANON_KEY;
const serviceKey = values.SERVICE_ROLE_KEY;
const dbUrl = values.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const jwtSecret = values.JWT_SECRET;
if (!anonKey || !serviceKey || !jwtSecret) throw new Error("Could not read local Supabase keys. Ensure `supabase start` has completed.");
await mkdir(dirname(output), { recursive: true });
const envText = [
  "# Generated from `supabase status -o env`; do not commit this file.",
  "NEXT_PUBLIC_APP_URL=http://localhost:3000",
  `NEXT_PUBLIC_SUPABASE_URL=${apiUrl}`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
  `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
  `SUPABASE_URL=${apiUrl}`,
  `SUPABASE_ANON_KEY=${anonKey}`,
  `DATABASE_URL=${dbUrl}`,
  `SUPABASE_JWT_SECRET=${jwtSecret}`,
  `SENSITIVE_DATA_ENCRYPTION_KEY=${encryptionKey}`,
  "UPSTASH_REDIS_REST_URL=",
  "UPSTASH_REDIS_REST_TOKEN=",
  "",
].join("\n");
await writeFile(output, envText, { mode: 0o600 });
await writeFile(rootOutput, envText, { mode: 0o600 });
console.log(`Wrote local app and workspace environments to ${output} and ${rootOutput}.`);
