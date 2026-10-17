// AI Content Repurposer — transforms existing content into new formats for
// different platforms.
//
// Takes one piece of content (blog post, video transcript, podcast) and
// produces platform-specific variants:
//   - Twitter/X thread (short, punchy, numbered)
//   - LinkedIn post (professional, longer, story-driven)
//   - Instagram caption (visual, emoji, hashtags)
//   - Email newsletter (structured, CTA-driven)
//   - Show notes / summary (for video/podcast)
//   - Meta description (SEO, 160 chars)
//   - Ad copy (Google Ads, 125 chars)
//
// Phase 1: rule-based transformation (no LLM call — uses templates +
// sentence extraction). This gives a working repurposer that's predictable
// and free. Phase 2: swap generateRepurposed() to call an LLM API.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type Platform =
  | "twitter_thread"
  | "linkedin_post"
  | "instagram_caption"
  | "email_newsletter"
  | "show_notes"
  | "meta_description"
  | "ad_copy";

export type SourceType = "blog_post" | "video_transcript" | "podcast_transcript" | "article" | "product_description";

export type Tone = "professional" | "casual" | "bold" | "educational" | "playful";

export interface RepurposeInput {
  sourceContent: string;
  sourceType: SourceType;
  platforms: Platform[];
  tone?: Tone;
  maxLength?: number;
  language?: string;
}

export interface RepurposedVariant {
  platform: Platform;
  content: string;
  charCount: number;
  withinLimit: boolean;
  hashtags?: string[];
  /** A short label for display in the UI (e.g. "Twitter Thread (15 tweets)"). */
  label: string;
  /** A short description of the format (e.g. "Short, punchy, numbered tweets"). */
  description: string;
}

export interface RepurposeResult {
  variants: RepurposedVariant[];
  extractedKeyPoints: string[];
}

// ───────────────────────────────────────────────
// Platform metadata
// ───────────────────────────────────────────────

export const PLATFORM_LIMITS: Record<Platform, number> = {
  twitter_thread: 280 * 15,
  linkedin_post: 3000,
  instagram_caption: 2200,
  email_newsletter: 5000,
  show_notes: 3000,
  meta_description: 160,
  ad_copy: 125,
};

export const PLATFORM_META: Record<Platform, { label: string; description: string; icon: string }> = {
  twitter_thread: { label: "Twitter / X Thread", description: "Short, punchy, numbered tweets (max 15)", icon: "🐦" },
  linkedin_post: { label: "LinkedIn Post", description: "Professional, story-driven, numbered points", icon: "💼" },
  instagram_caption: { label: "Instagram Caption", description: "Visual, emoji-heavy, hashtag-optimized", icon: "📸" },
  email_newsletter: { label: "Email Newsletter", description: "Structured, CTA-driven, subject + body", icon: "📧" },
  show_notes: { label: "Show Notes", description: "Timestamped summary for video/podcast", icon: "🎬" },
  meta_description: { label: "Meta Description", description: "SEO-optimized, 160 chars max", icon: "🔍" },
  ad_copy: { label: "Ad Copy", description: "Google Ads style, 125 chars max", icon: "📢" },
};

// ───────────────────────────────────────────────
// Tone presets — intro lines + CTA lines per tone.
// ───────────────────────────────────────────────

const TONE_INTROS: Record<Tone, string[]> = {
  professional: [
    "I want to share something I've learned:",
    "Here's an insight from recent work:",
    "A quick professional note:",
  ],
  casual: [
    "Been thinking about this:",
    "Okay so here's the thing:",
    "Real talk for a second:",
  ],
  bold: [
    "Here's something most people get wrong:",
    "Nobody talks about this, but:",
    "Hot take:",
  ],
  educational: [
    "Let me break this down for you:",
    "Here's what I've been teaching my team:",
    "A quick lesson I learned the hard way:",
  ],
  playful: [
    "So this happened 😅:",
    "Plot twist:",
    "Okay hear me out 👀:",
  ],
};

const TONE_CTAS: Record<Tone, string[]> = {
  professional: ["What's your experience? I'd value your perspective.", "Thoughts? Happy to discuss further."],
  casual: ["What do you think? Drop a comment.", "Anybody else experienced this?"],
  bold: ["Disagree? Let's talk.", "If this resonates, share it."],
  educational: ["Save this for later if it helped.", "What questions does this raise for you?"],
  playful: ["If this made you smile, share it 🙃", "Tag someone who needs to see this 👀"],
};

function pickIntro(tone: Tone): string {
  const intros = TONE_INTROS[tone] ?? TONE_INTROS.professional;
  return intros[Math.floor(Math.random() * intros.length)] ?? intros[0]!;
}

function pickCTA(tone: Tone): string {
  const ctas = TONE_CTAS[tone] ?? TONE_CTAS.professional;
  return ctas[Math.floor(Math.random() * ctas.length)] ?? ctas[0]!;
}

// ───────────────────────────────────────────────
// Sentence extraction
// ───────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}

/**
 * Extract the key sentences from a piece of content.
 * Scores each sentence by length + position (first/last = intro/conclusion).
 */
function extractKeyPoints(text: string, maxPoints: number = 6): string[] {
  const sentences = splitSentences(text);
  if (sentences.length <= maxPoints) return sentences;

  const scored = sentences.map((s, i) => {
    let score = s.length;
    if (i === 0) score += 100;           // intro — highest priority
    if (i === 1) score += 50;              // second sentence — often thesis
    if (i === sentences.length - 1) score += 60;  // conclusion
    if (i === sentences.length - 2) score += 20;  // second-to-last
    // Bonus for sentences with numbers (data points).
    if (/\d+%|\$\d|\d+x|\d+ \w+/.test(s)) score += 30;
    // Bonus for sentences with action verbs.
    if (/\b(built|created|launched|shipped|designed|implemented|integrated)\b/i.test(s)) score += 25;
    return { sentence: s, score, index: i };
  });

  const top = scored.sort((a, b) => b.score - a.score).slice(0, maxPoints);
  return top.sort((a, b) => a.index - b.index).map((s) => s.sentence);
}

/** Extract a title from the content (first line or first sentence). */
function extractTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim();
  if (firstLine && firstLine.length < 120) return firstLine;
  const firstSentence = splitSentences(text)[0] ?? "Untitled";
  return firstSentence.slice(0, 120);
}

// ───────────────────────────────────────────────
// Hashtag extraction
// ───────────────────────────────────────────────

function extractHashtags(text: string, sourceType: SourceType): string[] {
  const tags = new Set<string>();
  // Existing hashtags in the text.
  const matches = text.match(/#[a-zA-Z][a-zA-Z0-9]*/g);
  if (matches) matches.forEach((t) => tags.add(t.toLowerCase()));
  // Generated from capitalized words (proper nouns, tech terms).
  const caps = text.match(/\b[A-Z][a-z]{3,}\b/g);
  if (caps) {
    const freq = new Map<string, number>();
    caps.forEach((c) => freq.set(c, (freq.get(c) ?? 0) + 1));
    // Pick the most frequent capitalized words.
    Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([word]) => tags.add(`#${word.toLowerCase()}`));
  }
  // Source-type-specific tags.
  switch (sourceType) {
    case "blog_post": tags.add("#blog"); tags.add("#content"); break;
    case "video_transcript": tags.add("#video"); tags.add("#youtube"); break;
    case "podcast_transcript": tags.add("#podcast"); tags.add("#audio"); break;
    case "article": tags.add("#article"); break;
    case "product_description": tags.add("#product"); tags.add("#new"); break;
  }
  return Array.from(tags).slice(0, 10);
}

// ───────────────────────────────────────────────
// Platform-specific generators
// ───────────────────────────────────────────────

function generateTwitterThread(keyPoints: string[], tone: Tone): string {
  const tweets: string[] = [];
  const hook = keyPoints[0] ?? "Thread incoming";
  const introEmoji = tone === "bold" ? "🔥" : tone === "playful" ? "👀" : "🧵";
  tweets.push(`${introEmoji} ${hook.slice(0, 250)}`);
  for (let i = 1; i < keyPoints.length && tweets.length < 14; i++) {
    const point = keyPoints[i]!.slice(0, 270);
    tweets.push(`${i + 1}/ ${point}`);
  }
  const cta = pickCTA(tone);
  tweets.push(`${tweets.length + 1}/ ${cta}`);
  return tweets.join("\n\n---\n\n");
}

function generateLinkedInPost(keyPoints: string[], tone: Tone): string {
  const intro = pickIntro(tone);
  const body = keyPoints.slice(0, 5).map((p, i) => {
    // Add bullet formatting for readability.
    const cleaned = p.replace(/\.$/, "");
    return `${i === 0 ? "" : "\n"}${i + 1}. ${cleaned}`;
  }).join("\n");
  const cta = pickCTA(tone);
  return `${intro}\n\n${body}\n\n${cta}`;
}

function generateInstagramCaption(keyPoints: string[], hashtags: string[], tone: Tone): string {
  const emojiMap: Record<Tone, string[]> = {
    professional: ["💡", "📊", "🎯"],
    casual: ["✨", "🙌", "💭"],
    bold: ["🔥", "⚡", "💪"],
    educational: ["📚", "🧠", "✏️"],
    playful: ["😄", "🎈", "🌈"],
  };
  const emojis = emojiMap[tone] ?? emojiMap.professional;
  const hook = keyPoints[0]?.slice(0, 150) ?? "New post";
  const body = keyPoints.slice(1, 3).map((p, i) => `${emojis[i] ?? "✨"} ${p.slice(0, 200)}`).join("\n\n");
  const tagStr = hashtags.slice(0, 10).join(" ");
  return `${hook}\n\n${body}\n\n.\n.\n.\n${tagStr}`;
}

function generateEmailNewsletter(keyPoints: string[], sourceType: SourceType, title: string): string {
  const subject = title.slice(0, 60);
  const sourceLabel: Record<SourceType, string> = {
    blog_post: "I just published a new blog post",
    video_transcript: "I just released a new video",
    podcast_transcript: "I just dropped a new podcast episode",
    article: "I just wrote something I want to share",
    product_description: "I just launched something new",
  };
  const intro = `Hi there,\n\n${sourceLabel[sourceType]} and wanted to share the key takeaways with you.\n`;
  const body = keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
  const cta = `\n\nRead the full version → [link]\n\nIf you found this valuable, forward it to a friend.\n\n— [Your name]`;
  return `Subject: ${subject}\n\n${intro}\n${body}${cta}`;
}

function generateShowNotes(keyPoints: string[], sourceType: SourceType): string {
  const timestamps = keyPoints.map((p, i) => {
    const totalSeconds = Math.floor((i + 1) * 47); // ~47s per point (realistic)
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")} — ${p.slice(0, 100)}`;
  });
  const summary = keyPoints.slice(0, 3).join(" ");
  const sourceTag: Record<SourceType, string> = {
    blog_post: "Blog Post",
    video_transcript: "Video",
    podcast_transcript: "Podcast Episode",
    article: "Article",
    product_description: "Product",
  };
  return `## ${sourceTag[sourceType]} — Show Notes\n\n${timestamps.join("\n")}\n\n## Summary\n\n${summary}`;
}

function generateMetaDescription(keyPoints: string[]): string {
  // SEO best practice: 150-160 chars, include the main keyword.
  const combined = keyPoints.slice(0, 2).join(" ");
  // Trim to last complete word within 160 chars.
  if (combined.length <= 160) return combined;
  const trimmed = combined.slice(0, 157);
  const lastSpace = trimmed.lastIndexOf(" ");
  return trimmed.slice(0, lastSpace > 100 ? lastSpace : 157) + "...";
}

function generateAdCopy(keyPoints: string[], tone: Tone): string {
  const hook = keyPoints[0] ?? "Learn more";
  // Ad copy best practice: problem → solution → CTA, within 125 chars.
  const cta: Record<Tone, string> = {
    professional: "Learn more →",
    casual: "Check it out →",
    bold: "Get started now →",
    educational: "Discover how →",
    playful: "Try it today! →",
  };
  const ctaText = cta[tone] ?? cta.professional;
  const available = 125 - ctaText.length - 1; // -1 for space
  const hookTrimmed = hook.slice(0, available);
  return `${hookTrimmed} ${ctaText}`;
}

// ───────────────────────────────────────────────
// Main entry point
// ───────────────────────────────────────────────

export function repurposeContent(input: RepurposeInput): RepurposeResult {
  const { sourceContent, sourceType, platforms, tone = "professional" } = input;
  const keyPoints = extractKeyPoints(sourceContent, 6);
  const hashtags = extractHashtags(sourceContent, sourceType);
  const title = extractTitle(sourceContent);

  const variants: RepurposedVariant[] = platforms.map((platform) => {
    let content: string;
    switch (platform) {
      case "twitter_thread":
        content = generateTwitterThread(keyPoints, tone);
        break;
      case "linkedin_post":
        content = generateLinkedInPost(keyPoints, tone);
        break;
      case "instagram_caption":
        content = generateInstagramCaption(keyPoints, hashtags, tone);
        break;
      case "email_newsletter":
        content = generateEmailNewsletter(keyPoints, sourceType, title);
        break;
      case "show_notes":
        content = generateShowNotes(keyPoints, sourceType);
        break;
      case "meta_description":
        content = generateMetaDescription(keyPoints);
        break;
      case "ad_copy":
        content = generateAdCopy(keyPoints, tone);
        break;
      default:
        content = keyPoints.join(" ");
    }

    const limit = PLATFORM_LIMITS[platform];
    const charCount = content.length;
    const meta = PLATFORM_META[platform];
    return {
      platform,
      content,
      charCount,
      withinLimit: charCount <= limit,
      hashtags: ["instagram_caption", "twitter_thread", "linkedin_post"].includes(platform) ? hashtags : undefined,
      label: meta.label,
      description: meta.description,
    };
  });

  return { variants, extractedKeyPoints: keyPoints };
}
