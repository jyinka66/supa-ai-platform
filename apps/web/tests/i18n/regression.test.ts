import { describe, it, expect } from "vitest";
import { assemblePrompt } from "@/lib/chat/assemble-prompt";
import { LOCALES } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import responses from "./fixtures/responses.json";

/**
 * I18N regression suite — asserts structural invariants per language.
 *
 * Uses recorded provider responses (no live LLM calls) so the test is:
 *   - Fast (<100ms per case)
 *   - Deterministic (no flaky network)
 *   - Free (no API costs)
 *
 * The test checks:
 *   1. The assembled prompt has the correct version + language fields
 *   2. The prompt text contains the injection-defense suffix
 *   3. The recorded response for the language doesn't contain placeholder text
 *   4. The recorded response matches the expected section headers
 *
 * When adding a new locale:
 *   1. Add fixture responses to `fixtures/responses.json`
 *   2. Add the locale to `EXPECTATIONS` below
 *   3. The test auto-runs for all locales in `LOCALES`
 */

interface FixtureExpectation {
  /** Input text (what the user would send). */
  input: string;
  /** Regex that the recorded response should match. */
  expectSections?: RegExp;
}

const EXPECTATIONS: Record<Locale, FixtureExpectation[]> = {
  en: [
    { input: "Summarize this article", expectSections: /\b(Overview|Details)\b/ },
    { input: "Write a short essay about cats", expectSections: /(conclusion|Cats)/i },
  ],
  es: [
    { input: "Resume este artículo", expectSections: /(Resumen|Detalles)/ },
    { input: "Escribe un ensayo corto sobre gatos", expectSections: /(conclusión|mascotas)/i },
  ],
  pt: [
    { input: "Resuma este artigo", expectSections: /(Resumo|Detalhes)/ },
    { input: "Escreva um ensaio curto sobre gatos", expectSections: /(conclusão|mascotas)/i },
  ],
  fr: [
    { input: "Résume cet article", expectSections: /(Résumé|Détails)/ },
    { input: "Écris un court essai sur les chats", expectSections: /(conclusion|animaux)/i },
  ],
  de: [
    { input: "Fasse diesen Artikel zusammen", expectSections: /(Zusammenfassung|Details)/ },
    { input: "Schreibe einen kurzen Aufsatz über Katzen", expectSections: /(Zusammenfassend|Haustiere)/i },
  ],
  ar: [
    { input: "لخص هذا المقال", expectSections: /(ملخص|التفاصيل)/ },
    { input: "اكتب مقالاً قصيراً عن القطط", expectSections: /(الختام|أليفة)/ },
  ],
  zh: [
    { input: "总结这篇文章", expectSections: /(概述|详情)/ },
    { input: "写一篇关于猫的短文", expectSections: /(总之|宠物)/ },
  ],
  ja: [
    { input: "この記事を要約して", expectSections: /(概要|詳細)/ },
    { input: "猫について短いエッセイを書いて", expectSections: /(結論|ペット)/ },
  ],
  ko: [
    { input: "이 기사를 요약해 주세요", expectSections: /(요약|세부 정보)/ },
    { input: "고양이에 대한 짧은 에세이를 써주세요", expectSections: /(결론|반려동물)/ },
  ],
  hi: [
    { input: "इस लेख का सारांश दें", expectSections: /(सारांश|विवरण)/ },
    { input: "बिल्लियों के बारे में एक छोटा निबंध लिखें", expectSections: /(निष्कर्ष|पालतू)/ },
  ],
};

/**
 * Replays a recorded provider response for a given (language, input) pair.
 *
 * In a real setup, this would load from fixtures/responses.json.
 * Returns null if no fixture exists (test skips that case).
 */
function replayFixture(lang: Locale, input: string): string | null {
  const langFixtures = (responses as Record<string, Record<string, string>>)[lang];
  if (!langFixtures) return null;
  return langFixtures[input] ?? null;
}

describe("i18n regression: prompt assembly", () => {
  // Test that assemblePrompt works for every supported locale.
  for (const lang of LOCALES) {
    it(`assembles a prompt for ${lang} with correct metadata`, async () => {
      const prompt = await assemblePrompt("chat", {
        language: lang,
        locale: lang,
        vars: {},
      });

      // The prompt should have a version string (from the prompt library).
      expect(prompt.version).toMatch(/^chat-v/);
      expect(prompt.language).toBe(lang);

      // The prompt text should contain the injection-defense suffix.
      expect(prompt.text).toContain("<user_content>");

      // The prompt text should be non-empty.
      expect(prompt.text.length).toBeGreaterThan(50);
    });
  }
});

describe("i18n regression: recorded response structure", () => {
  // Test that recorded responses for each language match structural expectations.
  for (const [lang, cases] of Object.entries(EXPECTATIONS) as Array<[Locale, FixtureExpectation[]]>) {
    it(`prompt outputs remain structured for ${lang}`, async () => {
      for (const c of cases) {
        // Assemble the prompt (verifies the prompt library works for this lang).
        const prompt = await assemblePrompt("chat", {
          language: lang,
          locale: lang,
          vars: {},
        });
        expect(prompt.version).toBeTruthy();

        // Replay the recorded response (no live LLM call).
        const output = replayFixture(lang, c.input);

        // Skip if no fixture — this allows incremental locale addition.
        if (!output) {
          console.log(`No fixture for ${lang} / "${c.input}" — skipping`);
          continue;
        }

        // Assert structural invariants (NOT content quality).
        if (c.expectSections) {
          expect(output).toMatch(c.expectSections);
        }

        // Assert no placeholder text leaked into the output.
        expect(output).not.toMatch(/\b(lorem|TODO|placeholder|FIXME|XXX)\b/i);

        // Assert no template slot leaked (would indicate fillSlots() failed).
        expect(output).not.toMatch(/\{\{(\w+)\}\}/);
      }
    }, 30000);
  }
});

describe("i18n regression: slot files", () => {
  // Test that every locale has a slot file with all required keys.
  it("every locale has all required slot keys", async () => {
    const { loadSlots } = await import("@/lib/i18n/slots");

    for (const lang of LOCALES) {
      const slots = await loadSlots(lang);

      const requiredKeys = [
        "greeting",
        "disclaimer",
        "followUp",
        "clarify",
        "summarizing",
        "translating",
        "writing",
        "coding",
        "planning",
        "error",
        "rateLimited",
        "budgetExceeded",
      ] as const;

      for (const key of requiredKeys) {
        expect(slots[key], `${lang}.${key} is missing`).toBeTruthy();
        expect(slots[key].length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("English slots are the canonical fallback", async () => {
    const { loadSlots } = await import("@/lib/i18n/slots");

    const enSlots = await loadSlots("en");

    // Every non-English locale should have a different value for at least
    // one slot (otherwise the translation is just a copy of English).
    for (const lang of LOCALES) {
      if (lang === "en") continue;
      const slots = await loadSlots(lang);
      const hasTranslation = slots.greeting !== enSlots.greeting;
      expect(hasTranslation, `${lang} appears untranslated`).toBe(true);
    }
  });
});
