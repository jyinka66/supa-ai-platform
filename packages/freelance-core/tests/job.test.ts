/**
 * Job entity tests — Zod validation + status transitions + Money conversion.
 *
 * Covers:
 *   - Discipline enum (12 disciplines)
 *   - JobSource (supa vs external)
 *   - JobStatus lifecycle + transitions
 *   - Money schema (amountMinor integer, currency 3 chars)
 *   - FreelanceJob validation (required fields, tenancy, clientRef)
 *   - externalRef (optional, platform enum)
 *   - skills array (max 30, each max 50 chars)
 *   - brief max 50_000 chars
 *   - title min 1, max 200
 *   - wire ↔ domain Money conversion
 */

import { describe, it, expect } from "vitest";
import {
  Discipline,
  JobSource,
  ExternalPlatform,
  JobStatus,
  Money,
  FreelanceJob,
  canTransition,
  transitionStatus,
  InvalidJobTransitionError,
  toDomainMoney,
  toWireMoney,
} from "../src/job.js";
import { fromMinor, asCurrency } from "@supa/money/money";

const NOW = new Date().toISOString();
const WS = "00000000-0000-0000-0000-000000000001";
const CLIENT = "00000000-0000-0000-0000-000000000002";

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000003",
    wsId: WS,
    source: "supa",
    title: "Logo Design for Acme",
    brief: "Need a modern logo for a tech startup. Bold colors, minimalist style.",
    discipline: "design",
    skills: ["illustrator", "branding", "logo-design"],
    budget: { value: { amountMinor: 500_000, currency: "NGN" }, type: "fixed" },
    status: "captured",
    clientRef: CLIENT,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Enums ───

describe("Discipline", () => {
  it("has 12 disciplines", () => {
    const disciplines = Discipline.options;
    expect(disciplines).toHaveLength(12);
  });

  it("includes the freelance reality", () => {
    const disciplines = Discipline.options;
    expect(disciplines).toContain("writing");
    expect(disciplines).toContain("design");
    expect(disciplines).toContain("development");
    expect(disciplines).toContain("marketing");
    expect(disciplines).toContain("video");
    expect(disciplines).toContain("translation");
  });

  it("rejects unknown discipline", () => {
    expect(Discipline.safeParse("painting").success).toBe(false);
  });
});

describe("JobSource", () => {
  it("accepts supa + external", () => {
    expect(JobSource.safeParse("supa").success).toBe(true);
    expect(JobSource.safeParse("external").success).toBe(true);
  });

  it("rejects unknown source", () => {
    expect(JobSource.safeParse("referral").success).toBe(false);
  });
});

describe("ExternalPlatform", () => {
  it("accepts upwork, fiverr, direct, other", () => {
    expect(ExternalPlatform.safeParse("upwork").success).toBe(true);
    expect(ExternalPlatform.safeParse("fiverr").success).toBe(true);
    expect(ExternalPlatform.safeParse("direct").success).toBe(true);
    expect(ExternalPlatform.safeParse("other").success).toBe(true);
  });
});

describe("JobStatus", () => {
  it("has 6 statuses", () => {
    expect(JobStatus.options).toHaveLength(6);
  });

  it("covers the full lifecycle", () => {
    const statuses = JobStatus.options;
    expect(statuses).toEqual([
      "captured", "proposing", "active", "delivered", "paid", "closed",
    ]);
  });
});

// ─── Money schema ───

describe("Money schema", () => {
  it("accepts valid money", () => {
    expect(Money.safeParse({ amountMinor: 500_000, currency: "NGN" }).success).toBe(true);
    expect(Money.safeParse({ amountMinor: 100, currency: "USD" }).success).toBe(true);
  });

  it("rejects non-integer amountMinor", () => {
    expect(Money.safeParse({ amountMinor: 500.5, currency: "NGN" }).success).toBe(false);
  });

  it("rejects negative amountMinor", () => {
    expect(Money.safeParse({ amountMinor: -100, currency: "NGN" }).success).toBe(false);
  });

  it("rejects non-3-char currency", () => {
    expect(Money.safeParse({ amountMinor: 100, currency: "N" }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 100, currency: "NIGERIA" }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 100, currency: "" }).success).toBe(false);
  });
});

// ─── FreelanceJob validation ───

describe("FreelanceJob validation", () => {
  it("accepts a valid job", () => {
    const result = FreelanceJob.safeParse(makeJob());
    expect(result.success).toBe(true);
  });

  it("requires wsId (tenancy — non-nullable, no default)", () => {
    const result = FreelanceJob.safeParse(makeJob({ wsId: undefined }));
    expect(result.success).toBe(false);
  });

  it("requires clientRef (CRM is reuse, not rebuild)", () => {
    const result = FreelanceJob.safeParse(makeJob({ clientRef: undefined }));
    expect(result.success).toBe(false);
  });

  it("title min 1 char", () => {
    expect(FreelanceJob.safeParse(makeJob({ title: "" })).success).toBe(false);
    expect(FreelanceJob.safeParse(makeJob({ title: "X" })).success).toBe(true);
  });

  it("title max 200 chars", () => {
    expect(FreelanceJob.safeParse(makeJob({ title: "x".repeat(201) })).success).toBe(false);
    expect(FreelanceJob.safeParse(makeJob({ title: "x".repeat(200) })).success).toBe(true);
  });

  it("brief max 50_000 chars", () => {
    expect(FreelanceJob.safeParse(makeJob({ brief: "x".repeat(50_001) })).success).toBe(false);
    expect(FreelanceJob.safeParse(makeJob({ brief: "x".repeat(50_000) })).success).toBe(true);
  });

  it("skills max 30 items", () => {
    const skills = Array.from({ length: 31 }, (_, i) => `skill-${i}`);
    expect(FreelanceJob.safeParse(makeJob({ skills })).success).toBe(false);
  });

  it("skills each max 50 chars", () => {
    expect(FreelanceJob.safeParse(makeJob({ skills: ["x".repeat(51)] })).success).toBe(false);
    expect(FreelanceJob.safeParse(makeJob({ skills: ["x".repeat(50)] })).success).toBe(true);
  });

  it("deadline is optional", () => {
    expect(FreelanceJob.safeParse(makeJob({ deadline: undefined })).success).toBe(true);
    expect(FreelanceJob.safeParse(makeJob({ deadline: NOW })).success).toBe(true);
  });

  it("externalRef is optional", () => {
    expect(FreelanceJob.safeParse(makeJob({ externalRef: undefined })).success).toBe(true);
  });

  it("externalRef with platform + url", () => {
    expect(FreelanceJob.safeParse(makeJob({
      externalRef: { platform: "upwork", url: "https://upwork.com/jobs/123" },
    })).success).toBe(true);
  });

  it("externalRef rejects invalid platform", () => {
    expect(FreelanceJob.safeParse(makeJob({
      externalRef: { platform: "toptal" },
    })).success).toBe(false);
  });

  it("externalRef url must be valid URL", () => {
    expect(FreelanceJob.safeParse(makeJob({
      externalRef: { platform: "upwork", url: "not-a-url" },
    })).success).toBe(false);
  });

  it("budget type is hourly or fixed", () => {
    expect(FreelanceJob.safeParse(makeJob({
      budget: { value: { amountMinor: 5000, currency: "NGN" }, type: "hourly" },
    })).success).toBe(true);
    expect(FreelanceJob.safeParse(makeJob({
      budget: { value: { amountMinor: 5000, currency: "NGN" }, type: "monthly" },
    })).success).toBe(false);
  });
});

// ─── Status transitions ───

describe("canTransition — the lifecycle", () => {
  it("captured → proposing", () => {
    expect(canTransition("captured", "proposing")).toBe(true);
  });

  it("proposing → active", () => {
    expect(canTransition("proposing", "active")).toBe(true);
  });

  it("active → delivered", () => {
    expect(canTransition("active", "delivered")).toBe(true);
  });

  it("delivered → paid", () => {
    expect(canTransition("delivered", "paid")).toBe(true);
  });

  it("paid → closed", () => {
    expect(canTransition("paid", "closed")).toBe(true);
  });

  it("any status → closed (early close)", () => {
    expect(canTransition("captured", "closed")).toBe(true);
    expect(canTransition("proposing", "closed")).toBe(true);
    expect(canTransition("active", "closed")).toBe(true);
    expect(canTransition("delivered", "closed")).toBe(true);
  });

  it("closed is terminal", () => {
    expect(canTransition("closed", "captured")).toBe(false);
    expect(canTransition("closed", "active")).toBe(false);
  });

  it("captured → active is valid (store allows skip)", () => {
    // The store's LEGAL table allows captured → active (skip proposing).
    expect(canTransition("captured", "active")).toBe(true);
  });
});

describe("transitionStatus", () => {
  it("updates status + updatedAt", () => {
    const job = FreelanceJob.parse(makeJob());
    const updated = transitionStatus(job, "proposing", NOW);
    expect(updated.status).toBe("proposing");
    expect(updated.updatedAt).toBe(NOW);
  });

  it("throws on invalid transition (captured → delivered)", () => {
    const job = FreelanceJob.parse(makeJob());
    expect(() => transitionStatus(job, "delivered")).toThrow(InvalidJobTransitionError);
  });

  it("throws on transition from terminal", () => {
    const closed = FreelanceJob.parse(makeJob({ status: "closed" }));
    expect(() => transitionStatus(closed, "active")).toThrow(InvalidJobTransitionError);
  });
});

// ─── Wire ↔ domain Money conversion ───

describe("toDomainMoney + toWireMoney", () => {
  it("converts wire → domain (number → bigint)", () => {
    const wire = { amountMinor: 500_000, currency: "NGN" };
    const domain = toDomainMoney(wire);
    expect(domain.minor).toBe(500_000n);
    expect(domain.currency).toBe("NGN");
  });

  it("converts domain → wire (bigint → number)", () => {
    const domain = fromMinor(500_000n, asCurrency("NGN"));
    const wire = toWireMoney(domain);
    expect(wire.amountMinor).toBe(500_000);
    expect(wire.currency).toBe("NGN");
  });

  it("round-trips wire → domain → wire", () => {
    const original = { amountMinor: 1_000_000, currency: "USD" };
    const domain = toDomainMoney(original);
    const wire = toWireMoney(domain);
    expect(wire).toEqual(original);
  });

  it("uppercase currency on conversion", () => {
    const wire = { amountMinor: 100, currency: "ngn" };
    const domain = toDomainMoney(wire);
    expect(domain.currency).toBe("NGN"); // uppercased
  });
});
