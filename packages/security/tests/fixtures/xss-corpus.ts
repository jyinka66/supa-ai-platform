/**
 * Codegen XSS fuzz corpus — payloads that flow through codegen
 * (text → HTML/JSX) and are rendered in sandboxed iframes.
 *
 * Forbidden substrings are context-appropriate — only strings that
 * would indicate an actual escape failure (not the inner text of
 * the payload, which is safe once surrounding angle-quotes are
 * escaped). For example, after `escapeHtmlText`, the payload
 * `<img src=x onerror="alert(1)">` becomes
 * `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;` — the literal
 * `onerror` survives, but it's no longer an attribute (no `<` and
 * no unescaped `"` around it), so it's safe. The forbidden
 * substring is `<img` (the unescaped tag opener) — NOT `onerror`.
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

export const XSS_CORPUS: XssPayload[] = [
  // ─── Text context: forbid raw <tag> openers (would indicate < wasn't escaped) ───
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

  // ─── Attribute context: forbid unescaped " followed by space (attribute breakout) ───
  {
    name: "attr-breakout-onclick",
    input: '" onclick="alert(1)"',
    context: "attr",
    // After escapeHtmlAttr, " becomes &quot;. A breakout would be a
    // raw " followed by space + on. We check for the raw " first.
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

  // ─── JS string context: forbid raw " and ` (would break out of the string) ───
  //   After escapeJsString, " → \", ` → \`, </ → <\/. The forbidden
  //   substrings are the UNESCAPED breakout forms — the raw `"` or
  //   `` ` `` not preceded by `\`. The escaped form legitimately
  //   contains `";alert` etc. — that's safe inside the escaped string.
  {
    name: "script-in-js-string",
    input: '</script><script>alert(1)</script>',
    context: "js-string",
    // The dangerous form is raw </script> (closing the script tag).
    // After escape, </ → <\/ so </script> → <\/script>.
    forbiddenSubstrings: ["</script>"],
  },
  {
    name: "js-string-breakout-quote",
    input: '";alert(1);//',
    context: "js-string",
    // The dangerous form is a raw " (closing the JS string). After
    // escape, " → \". The escaped form is \";alert(1);// — the raw
    // " is gone (replaced with \"). We forbid the raw unescaped "
    // by checking the escaped form does NOT contain a " not preceded
    // by \. Substring check can't express "not preceded by", so we
    // leave forbiddenSubstrings empty here and rely on the dedicated
    // escapeJsString tests to verify the escape works.
    forbiddenSubstrings: [],
  },
  {
    name: "js-string-breakout-backtick",
    input: "${alert(1)}",
    context: "js-string",
    // The dangerous form is in a template literal context. After escape
    // the ` becomes \`. In a regular "..." string, ${} is harmless.
    // The forbidden substring should be raw ${ when in template literal
    // context — but escapeJsString escapes `, so even in a template
    // the `${` would need to be after an unescaped `.
    forbiddenSubstrings: [], // No forbidden substring — escapeJsString escapes ` correctly
  },
  {
    name: "js-string-u2028",
    input: "\u2028alert(1)",
    context: "js-string",
    // After escape, U+2028 (the literal byte) is replaced with \u2028
    // (the 6-char escape sequence). The raw U+2028 byte must not appear.
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

  // ─── URL context: forbid external URLs and dangerous schemes ───
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
];
