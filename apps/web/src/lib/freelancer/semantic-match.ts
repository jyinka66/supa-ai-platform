// Semantic job match — vector-embedding-based relevance scoring.
//
// Replaces the keyword-based matchOpportunities() in freelance-ai/market.ts
// with a pgvector-backed semantic search. Job descriptions + portfolio items
// are embedded as vectors; cosine similarity produces a 0-100% match score.
//
// Phase 1: we use a lightweight TF-IDF + cosine similarity implementation
// that runs in-process (no external embedding API needed). This gives us
// "semantic-ish" matching that's better than keyword matching but doesn't
// require an LLM API call for every job.
//
// Phase 2: swap the embed() function to call OpenAI's text-embedding-3-small
// or Supabase's pgvector + a hosted embedding model. The interface stays
// the same — only the embed() implementation changes.

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export interface JobEmbedding {
  jobId: string;
  /** The embedding vector (TF-IDF weights in Phase 1, dense vector in Phase 2). */
  vector: Float32Array;
  /** The original text that was embedded (for debugging + re-embedding). */
  sourceText: string;
}

export interface PortfolioEmbedding {
  portfolioId: string;
  vector: Float32Array;
  sourceText: string;
  /** Metadata for display in the match results. */
  title: string;
  tags: string[];
}

export interface SemanticMatchResult {
  jobId: string;
  /** 0-100 match score (cosine similarity × 100, clamped). */
  score: number;
  /** Which portfolio items matched (top 3, for the proposal generator). */
  matchedPortfolio: Array<{
    portfolioId: string;
    title: string;
    similarity: number;
  }>;
  /** Why this matched (top contributing terms). */
  matchReasons: string[];
}

export interface ClientQualityFilter {
  minClientRating?: number;        // e.g. 4.5
  requireVerifiedPayment?: boolean;
  minBudget?: number;
  maxBudget?: number;
  currencies?: string[];           // ["USD", "EUR", "NGN"]
  locations?: string[];            // ["US", "EU", "NG"]
}

export interface JobWithClientInfo {
  jobId: string;
  title: string;
  description: string;
  budget: { amount: number; currency: string };
  clientRating?: number;
  clientVerifiedPayment?: boolean;
  clientLocation?: string;
  platform: "upwork" | "fiverr" | "direct" | "other";
}

// ───────────────────────────────────────────────
// TF-IDF embedding (Phase 1 — no external API needed)
// ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "shall", "can", "need",
  "this", "that", "these", "those", "i", "you", "he", "she", "it", "we",
  "they", "what", "which", "who", "when", "where", "why", "how", "all",
  "each", "every", "some", "any", "no", "not", "as", "if", "than", "too",
  "very", "just", "also", "only", "up", "out", "about", "into", "over",
  "after", "before", "between", "under", "above", "below", "off", "down",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Build a TF-IDF vector from text, using a shared vocabulary. */
export function embed(text: string, vocabulary: Map<string, number>): Float32Array {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Normalize by total tokens (term frequency).
  const total = tokens.length || 1;
  const vector = new Float32Array(vocabulary.size);
  for (const [term, count] of tf) {
    const idx = vocabulary.get(term);
    if (idx !== undefined) {
      vector[idx] = count / total;
    }
  }
  return vector;
}

/** Build a shared vocabulary from a corpus of texts. */
export function buildVocabulary(texts: string[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (const token of tokenize(text)) {
      if (!seen.has(token)) {
        seen.add(token);
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }
  }
  // Sort by frequency descending — most common terms get lower indices.
  const sorted = Array.from(docFreq.entries()).sort((a, b) => b[1] - a[1]);
  const vocab = new Map<string, number>();
  sorted.forEach(([term], i) => vocab.set(term, i));
  return vocab;
}

// ───────────────────────────────────────────────
// Cosine similarity
// ───────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ───────────────────────────────────────────────
// Semantic job match — the main entry point.
//
// Takes a set of jobs + the freelancer's portfolio, embeds them all against
// a shared vocabulary, and returns ranked matches with score + matched
// portfolio items.
// ───────────────────────────────────────────────

export function semanticMatchJobs(
  jobs: JobWithClientInfo[],
  portfolio: Array<Omit<PortfolioEmbedding, "vector">>,
  filters?: ClientQualityFilter,
): SemanticMatchResult[] {
  // Apply client quality filters first.
  const filtered = jobs.filter((job) => {
    if (filters?.minClientRating != null && (job.clientRating ?? 0) < filters.minClientRating) return false;
    if (filters?.requireVerifiedPayment && !job.clientVerifiedPayment) return false;
    if (filters?.minBudget != null && job.budget.amount < filters.minBudget) return false;
    if (filters?.maxBudget != null && job.budget.amount > filters.maxBudget) return false;
    if (filters?.currencies && !filters.currencies.includes(job.budget.currency)) return false;
    if (filters?.locations && job.clientLocation && !filters.locations.includes(job.clientLocation)) return false;
    return true;
  });

  // Build a shared vocabulary from all job descriptions + portfolio texts.
  const allTexts = [
    ...filtered.map((j) => `${j.title} ${j.description}`),
    ...portfolio.map((p) => p.sourceText),
  ];
  const vocabulary = buildVocabulary(allTexts);

  // Embed each portfolio item (pre-compute once).
  const portfolioVectors = portfolio.map((p) => ({
    ...p,
    vector: embed(p.sourceText, vocabulary),
  }));

  // Embed each job + match against portfolio.
  const results: SemanticMatchResult[] = filtered.map((job) => {
    const jobText = `${job.title} ${job.description}`;
    const jobVector = embed(jobText, vocabulary);

    // Score against each portfolio item.
    const scored = portfolioVectors.map((p) => ({
      portfolioId: p.portfolioId,
      title: p.title,
      similarity: cosineSimilarity(jobVector, p.vector),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    const topMatches = scored.slice(0, 3);

    // Overall score: max similarity across portfolio items, scaled to 0-100.
    const maxSim = topMatches[0]?.similarity ?? 0;
    const score = Math.round(Math.min(100, maxSim * 100));

    // Extract match reasons (top overlapping tokens).
    const matchReasons = extractMatchReasons(jobText, portfolio as PortfolioEmbedding[], topMatches);

    return {
      jobId: job.jobId,
      score,
      matchedPortfolio: topMatches.map((m) => ({
        portfolioId: m.portfolioId,
        title: m.title,
        similarity: Math.round(m.similarity * 100) / 100,
      })),
      matchReasons,
    };
  });

  // Sort by score descending.
  results.sort((a, b) => b.score - a.score);
  return results;
}

function extractMatchReasons(
  jobText: string,
  portfolio: PortfolioEmbedding[],
  topMatches: Array<{ portfolioId: string; title: string; similarity: number }>,
): string[] {
  const jobTokens = new Set(tokenize(jobText));
  const reasons: string[] = [];
  for (const match of topMatches) {
    const pItem = portfolio.find((p) => p.portfolioId === match.portfolioId);
    if (!pItem) continue;
    const portfolioTokens = tokenize(pItem.sourceText);
    const overlap = portfolioTokens.filter((t) => jobTokens.has(t));
    // Pick the most distinctive overlapping tokens (longest first, dedup).
    const unique = Array.from(new Set(overlap)).sort((a, b) => b.length - a.length).slice(0, 3);
    for (const term of unique) {
      if (!reasons.includes(term)) reasons.push(term);
    }
  }
  return reasons.slice(0, 5);
}
