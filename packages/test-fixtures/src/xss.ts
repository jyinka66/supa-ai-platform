/**
 * @supa/test-fixtures/xss
 * ----------------------------------------------------------------
 * The codegen XSS fuzz corpus, consolidated from @supa/security's
 * tests/fixtures/xss-corpus.ts. Payloads across text/attr/url/
 * js-string/asset-url contexts with context-appropriate forbidden
 * substrings (only strings that would indicate an actual escape
 * failure, not inner text that's safe once surrounding angle-quotes
 * are escaped).
 *
 * Frozen readonly — tests can't accidentally mutate the shared
 * corpus.
 * ----------------------------------------------------------------
 */

export interface XssPayload {
  name: string;
  /** Untrusted input that flows into a codegen slot. */
  input: string;
  /** Slot context: where in the HTML/JSX the input is interpolated. */
  context: "text" | "attr" | "url" | "js-string" | "asset-url";
  /** Substrings that MUST NOT appear unescaped in the output. */
  forbiddenSubstrings: string[];
}

export const XSS_CORPUS: readonly XssPayload[] = Object.freeze([
  // ─── Text context: forbid raw <tag> openers ───
  {
    name: "script-in-text",
    input: "<script>alert(1)</script>",
    context: "text",
    forbiddenSubstrings: ["<script>", "</script>"],
  },
  {
    name: "doc-named-img-onerror",
    input: '<img src=x onerror="alert(1)">',
    context: "text",
    forbiddenSubstrings: ["<img", "<img "],
  },
  {
    name: "iframe-in-text",
    input: '<iframe src="https://attacker.example.com"></iframe>',
    context: "text",
    forbiddenSubstrings: ["<iframe", "<iframe "],
  },
  {
    name: "style-injection",
    input: '</style><style>body{background:url(javascript:alert(1))}</style>',
    context: "text",
    forbiddenSubstrings: ["</style>", "<style>"],
  },
  {
    name: "svg-inline-xss",
    input: '<svg><script>alert(1)</script></svg>',
    context: "text",
    forbiddenSubstrings: ["<svg>", "<script>"],
  },
  {
    name: "svg-onload",
    input: '<svg onload="alert(1)"></svg>',
    context: "text",
    forbiddenSubstrings: ["<svg", "<svg>"],
  },

  // ─── Attribute context: forbid raw " followed by space + on* ───
  {
    name: "attr-breakout-onclick",
    input: '" onclick="alert(1)"',
    context: "attr",
    forbiddenSubstrings: ['" onclick', '" onclick="'],
  },
  {
    name: "attr-breakout-onerror",
    input: '" onerror="alert(1)"',
    context: "attr",
    forbiddenSubstrings: ['" onerror', '" onerror="'],
  },
  {
    name: "attr-breakout-onload",
    input: '" onload="alert(1)"',
    context: "attr",
    forbiddenSubstrings: ['" onload', '" onload="'],
  },
  {
    name: "attr-script-tag",
    input: '"><script>alert(1)</script>',
    context: "attr",
    forbiddenSubstrings: ['"><script>', "<script>"],
  },

  // ─── JS string context: forbid raw </script> (closing tag breakout) ───
  {
    name: "script-in-js-string",
    input: '</script><script>alert(1)</script>',
    context: "js-string",
    forbiddenSubstrings: ["</script>"],
  },
  {
    name: "js-string-u2028",
    input: "\u2028alert(1)",
    context: "js-string",
    forbiddenSubstrings: ["\u2028"],
  },
  {
    name: "js-string-u2029",
    input: "\u2029alert(1)",
    context: "js-string",
    forbiddenSubstrings: ["\u2029"],
  },
  {
    name: "js-string-closing-tag",
    input: "</script>",
    context: "js-string",
    forbiddenSubstrings: ["</script>"],
  },

  // ─── URL context: forbid external URLs + dangerous schemes ───
  {
    name: "javascript-url",
    input: "javascript:alert(1)",
    context: "url",
    forbiddenSubstrings: ["javascript:alert", "javascript:"],
  },
  {
    name: "data-url-html",
    input: "data:text/html,<script>alert(1)</script>",
    context: "url",
    forbiddenSubstrings: ["data:text/html", "<script>"],
  },
  {
    name: "external-url-attacker",
    input: "https://attacker.example.com/track.png",
    context: "url",
    forbiddenSubstrings: ["attacker.example.com"],
  },

  // ─── Asset URL context: forbid non-validated asset URLs ───
  {
    name: "asset-url-wrong-format",
    input: "/asset/not-a-real-hash",
    context: "asset-url",
    forbiddenSubstrings: ["/asset/not-a-real-hash"],
  },
  {
    name: "asset-url-external",
    input: "https://attacker.example.com/asset/fakehash",
    context: "asset-url",
    forbiddenSubstrings: ["attacker.example.com"],
  },
  {
    name: "asset-url-javascript",
    input: "javascript:alert(1)",
    context: "asset-url",
    forbiddenSubstrings: ["javascript:alert"],
  },
]);
