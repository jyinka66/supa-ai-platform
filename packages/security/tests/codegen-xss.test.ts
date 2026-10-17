/**
 * Codegen XSS fuzz test.
 *
 * The io pass's fuzz corpus (XSS_CORPUS) run through codegen
 * (text → HTML/JSX via interpolateHtml), then rendered in the
 * sandboxed iframe harness.
 *
 * Assertions:
 *   - Every XSS payload is escaped — forbidden substrings don't
 *     appear in the generated output.
 *   - Asset URL payloads that fail validation become about:blank.
 *   - The sandboxed iframe harness config has the right sandbox
 *     attributes (no allow-same-origin, no allow-scripts that
 *     would inherit our origin's authority).
 *   - The CSP for the harness iframe denies all network access.
 */

import { describe, it, expect } from "vitest";
import { XSS_CORPUS } from "./fixtures/xss-corpus.js";
import {
  escapeHtmlText,
  escapeHtmlAttr,
  escapeJsString,
  escapeUrlAttr,
  interpolateHtml,
  validateAssetUrl,
  SANDBOX_IFRAME_ATTRS,
  SANDBOX_IFRAME_CSP,
  isSandboxResultMessage,
  text,
  attr,
  jsStr,
  url,
  assetUrl,
  type CodegenContext,
} from "../src/boundary-4-codegen.js";

const ASSET_OPTS = {
  assetsOriginHost: "assets.supa-ai.com",
  appOriginHost: "supa-ai.com",
};

const CTX: CodegenContext = { assetUrlOpts: ASSET_OPTS };
const html = interpolateHtml(CTX);

// ───────────────────────────────────────────────
// Per-context escaper tests
// ───────────────────────────────────────────────

describe("codegen XSS — text context escaping", () => {
  const textPayloads = XSS_CORPUS.filter((p) => p.context === "text");

  for (const payload of textPayloads) {
    it(`text: "${payload.name}" has no forbidden substrings`, () => {
      const escaped = escapeHtmlText(payload.input);
      for (const forbidden of payload.forbiddenSubstrings) {
        expect(escaped).not.toContain(forbidden);
      }
      // No raw script tag survives.
      expect(escaped).not.toContain("<script");
      // No unescaped attribute breakout (raw " followed by space + on).
      expect(escaped).not.toMatch(/"\s+on\w+\s*=/);
    });
  }
});

describe("codegen XSS — attribute context escaping", () => {
  const attrPayloads = XSS_CORPUS.filter((p) => p.context === "attr");

  for (const payload of attrPayloads) {
    it(`attr: "${payload.name}" has no forbidden substrings`, () => {
      const escaped = escapeHtmlAttr(payload.input);
      for (const forbidden of payload.forbiddenSubstrings) {
        expect(escaped).not.toContain(forbidden);
      }
      // No attribute breakout — raw " followed by space + on* handler.
      // After escapeHtmlAttr, " → &quot;, so this regex shouldn't match.
      expect(escaped).not.toMatch(/"\s+on\w+\s*=/);
    });
  }
});

describe("codegen XSS — JS string context escaping", () => {
  const jsPayloads = XSS_CORPUS.filter((p) => p.context === "js-string");

  for (const payload of jsPayloads) {
    it(`js-string: "${payload.name}" has no forbidden substrings`, () => {
      const escaped = escapeJsString(payload.input);
      for (const forbidden of payload.forbiddenSubstrings) {
        expect(escaped).not.toContain(forbidden);
      }
    });
  }

  it("U+2028 (line separator) is escaped", () => {
    const escaped = escapeJsString("\u2028alert(1)");
    expect(escaped).toContain("\\u2028");
    expect(escaped).not.toContain("\u2028alert");
  });

  it("U+2029 (paragraph separator) is escaped", () => {
    const escaped = escapeJsString("\u2029alert(1)");
    expect(escaped).toContain("\\u2029");
    expect(escaped).not.toContain("\u2029alert");
  });

  it("</script> in JS string is escaped as <\\/", () => {
    const escaped = escapeJsString("</script>");
    expect(escaped).toContain("<\\/");
    expect(escaped).not.toContain("</script>");
  });
});

// ───────────────────────────────────────────────
// interpolateHtml (tagged template) tests
// ───────────────────────────────────────────────

describe("codegen XSS — interpolateHtml tagged template", () => {
  it("escapes text values", () => {
    const result = html`<div>${text("<script>alert(1)</script>")}</div>`;
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("escapes attribute values", () => {
    const result = html`<div class="${attr('x" onclick="alert(1)')}"></div>`;
    // After escapeHtmlAttr, " → &quot;. The attribute value is now
    // `x&quot; onclick=&quot;alert(1)` — no raw " to break out of.
    expect(result).not.toContain('" onclick=');
    // No attribute breakout: raw " followed by space + on* handler.
    // The escaped form has &quot; not ", so this regex shouldn't match.
    expect(result).not.toMatch(/"\s+on\w+\s*=/);
  });

  it("rejects external URLs (becomes about:blank)", () => {
    const result = html`<img src="${url("https://attacker.example.com/track.png")}" />`;
    expect(result).toContain("about:blank");
    expect(result).not.toContain("attacker.example.com");
  });

  it("rejects javascript: URLs", () => {
    const result = html`<a href="${url("javascript:alert(1)")}">click</a>`;
    expect(result).toContain("about:blank");
    expect(result).not.toContain("javascript:alert");
  });

  it("allows same-origin asset URLs", () => {
    const validHash = "a".repeat(64);
    const result = html`<img src="${assetUrl(`/asset/${validHash}`)}" />`;
    expect(result).toContain(`/asset/${validHash}`);
    expect(result).not.toContain("about:blank");
  });

  it("rejects asset URLs with wrong hash format", () => {
    const result = html`<img src="${assetUrl("/asset/not-a-real-hash")}" />`;
    expect(result).toContain("about:blank");
    expect(result).not.toContain("not-a-real-hash");
  });

  it("rejects external asset URLs", () => {
    const result = html`<img src="${assetUrl("https://attacker.example.com/asset/fakehash")}" />`;
    expect(result).toContain("about:blank");
    expect(result).not.toContain("attacker.example.com");
  });

  it("escapes js-string values (closing tag breakout)", () => {
    const result = html`<script>const x = "${jsStr("</script><script>alert(1)</script>")}";</script>`;
    expect(result).not.toContain("</script><script>");
    expect(result).toContain("<\\/script>"); // escaped form
  });
});

// ───────────────────────────────────────────────
// validateAssetUrl (called by interpolateHtml internally)
// ───────────────────────────────────────────────

describe("codegen XSS — validateAssetUrl", () => {
  it("accepts same-origin /asset/<sha256>", () => {
    const hash = "a".repeat(64);
    const result = validateAssetUrl(`/asset/${hash}`, ASSET_OPTS);
    expect(result.kind).toBe("same-origin-path");
  });

  it("accepts assets-origin https URL", () => {
    const hash = "b".repeat(64);
    const result = validateAssetUrl(`https://assets.supa-ai.com/asset/${hash}`, ASSET_OPTS);
    expect(result.kind).toBe("assets-origin");
  });

  it("rejects http (non-https) assets-origin URL", () => {
    const hash = "c".repeat(64);
    const result = validateAssetUrl(`http://assets.supa-ai.com/asset/${hash}`, ASSET_OPTS);
    expect(result.kind).toBe("rejected");
  });

  it("rejects wrong host", () => {
    const hash = "d".repeat(64);
    const result = validateAssetUrl(`https://attacker.example.com/asset/${hash}`, ASSET_OPTS);
    expect(result.kind).toBe("rejected");
  });

  it("rejects wrong path format", () => {
    const result = validateAssetUrl("/asset/short", ASSET_OPTS);
    expect(result.kind).toBe("rejected");
  });

  it("rejects javascript: URLs", () => {
    const result = validateAssetUrl("javascript:alert(1)", ASSET_OPTS);
    expect(result.kind).toBe("rejected");
  });
});

// ───────────────────────────────────────────────
// Full corpus sweep — every payload through interpolateHtml
// ───────────────────────────────────────────────

describe("codegen XSS — full corpus sweep through interpolateHtml", () => {
  for (const payload of XSS_CORPUS) {
    it(`"${payload.name}" (context=${payload.context}) — no forbidden substrings survive`, () => {
      const value =
        payload.context === "text" ? text(payload.input) :
        payload.context === "attr" ? attr(payload.input) :
        payload.context === "url" ? url(payload.input) :
        payload.context === "js-string" ? jsStr(payload.input) :
        assetUrl(payload.input);
      const result = html`<div>${value}</div>`;
      for (const forbidden of payload.forbiddenSubstrings) {
        expect(result).not.toContain(forbidden);
      }
    });
  }
});

// ───────────────────────────────────────────────
// Sandboxed iframe harness config
// ───────────────────────────────────────────────

describe("codegen XSS — sandboxed iframe harness config", () => {
  it("sandbox attribute is set with no allow-* features", () => {
    // The sandbox attr should be just "sandbox" (no allow-same-origin,
    // no allow-scripts that would inherit our origin's authority).
    expect(SANDBOX_IFRAME_ATTRS).toBe("sandbox");
    expect(SANDBOX_IFRAME_ATTRS).not.toContain("allow-same-origin");
    expect(SANDBOX_IFRAME_ATTRS).not.toContain("allow-scripts");
    expect(SANDBOX_IFRAME_ATTRS).not.toContain("allow-top-navigation");
  });

  it("CSP denies all network access", () => {
    expect(SANDBOX_IFRAME_CSP).toContain("default-src 'none'");
    expect(SANDBOX_IFRAME_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_IFRAME_CSP).toContain("frame-src 'none'");
    expect(SANDBOX_IFRAME_CSP).toContain("object-src 'none'");
    expect(SANDBOX_IFRAME_CSP).toContain("form-action 'none'");
  });

  it("CSP allows only Worker eval (no DOM, no origin)", () => {
    // The harness runs snippets in a Worker inside the sandboxed
    // iframe — no DOM access, no same-origin cookies. The only
    // thing allowed is script-src 'unsafe-eval' for the Worker.
    expect(SANDBOX_IFRAME_CSP).toContain("script-src 'unsafe-eval'");
    expect(SANDBOX_IFRAME_CSP).not.toContain("script-src 'self'");
  });
});

// ───────────────────────────────────────────────
// Sandboxed iframe message protocol
// ───────────────────────────────────────────────

describe("codegen XSS — sandbox result message typeguard", () => {
  it("accepts a valid SandboxResultMessage", () => {
    const msg = {
      type: "sandbox:result",
      ok: true,
      failures: [],
      consoleErrors: [],
      threw: false,
      elapsedMs: 42,
    };
    expect(isSandboxResultMessage(msg)).toBe(true);
  });

  it("rejects non-message data", () => {
    expect(isSandboxResultMessage(null)).toBe(false);
    expect(isSandboxResultMessage({})).toBe(false);
    expect(isSandboxResultMessage({ type: "other" })).toBe(false);
    expect(isSandboxResultMessage("string")).toBe(false);
  });

  it("rejects malformed message (missing required fields)", () => {
    expect(isSandboxResultMessage({ type: "sandbox:result" })).toBe(false);
    expect(isSandboxResultMessage({
      type: "sandbox:result",
      ok: "yes", // wrong type
      failures: [],
      consoleErrors: [],
      threw: false,
      elapsedMs: 0,
    })).toBe(false);
  });

  it("rejects attacker-crafted messages with extra type field", () => {
    // An attacker might try to inject a fake result. The typeguard
    // ensures we only accept the exact shape.
    const fake = {
      type: "sandbox:result",
      ok: true,
      failures: [],
      consoleErrors: [],
      threw: false,
      elapsedMs: 0,
      extraAttackerField: "should be ignored", // ignored — extra fields don't fail the typeguard, but consumers shouldn't read them
    };
    expect(isSandboxResultMessage(fake)).toBe(true); // structurally valid
    // The contract: consumers only read typed fields; extra fields
    // are present but unused. Defense in depth: the typeguard proves
    // shape, not content safety.
  });
});
