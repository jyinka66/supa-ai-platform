import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(process.cwd(), "../../packages/db/migrations");
const read = (name: string) => readFileSync(resolve(migrations, name), "utf8");

describe("marketplace security migrations", () => {
  it("restricts marketplace listing reads to published items and isolates review records", () => {
    const sql = read("0070_supa_os_marketplace_security.sql");
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/using \(status = 'published'\)/i);
    expect(sql).toMatch(/for select to supa_system using \(true\)/i);
    expect(sql).not.toMatch(/for select to anon, authenticated using \(exists \(select 1 from supa_os_marketplace_items/i);
  });

  it("persists automated checks under system-only row-level security", () => {
    const sql = read("0071_supa_os_marketplace_checks.sql");
    expect(sql).toMatch(/create table if not exists supa_os_marketplace_item_checks/i);
    expect(sql).toMatch(/checks jsonb not null/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/for insert to supa_system/i);
  });
});
