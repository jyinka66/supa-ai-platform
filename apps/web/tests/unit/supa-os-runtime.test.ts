import { describe, expect, it } from "vitest";
import { executeCommand, RUNTIME_ENVIRONMENTS } from "@/lib/supa-os/wasm-runtime-engine";

describe("isolated command runtime", () => {
  it("advertises the actual Docker-backed runtime providers", () => {
    expect(RUNTIME_ENVIRONMENTS.every((runtime) => runtime.runtimeProvider === "docker-sandbox" && runtime.implemented)).toBe(true);
    expect(RUNTIME_ENVIRONMENTS.some((runtime) => runtime.language === "postgres")).toBe(true);
  });

  it("rejects empty commands without attempting host execution", async () => {
    const result = await executeCommand({ command: "" });
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join(" ")).toMatch(/command must be/i);
  });

  it("rejects workspace traversal before starting a container", async () => {
    const result = await executeCommand({ command: "cat /etc/passwd", files: [{ path: "../outside.txt", content: "nope" }] });
    expect(result.status).toBe("error");
    expect(result.stderr.join(" ")).toMatch(/invalid workspace file path/i);
  });
});
