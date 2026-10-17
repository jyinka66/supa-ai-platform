"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea, Label } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Copy, Check, AlertCircle, Loader2 } from "lucide-react";
import { freelancerApi, ApiClientError, type RepurposedVariant } from "@/lib/api-client";

// ───────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────

const DARK = {
  bg: "#0B0F17",
  surface: "#111827",
  surfaceMuted: "#1F2937",
  border: "#374151",
  text: "#F9FAFB",
  textMuted: "#9CA3AF",
  accent: "#00F0FF",
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#EF4444",
};

const PLATFORM_OPTIONS = [
  { id: "twitter_thread", label: "Twitter / X Thread", icon: "🐦" },
  { id: "linkedin_post", label: "LinkedIn Post", icon: "💼" },
  { id: "instagram_caption", label: "Instagram Caption", icon: "📸" },
  { id: "email_newsletter", label: "Email Newsletter", icon: "📧" },
  { id: "show_notes", label: "Show Notes", icon: "🎬" },
  { id: "meta_description", label: "Meta Description", icon: "🔍" },
  { id: "ad_copy", label: "Ad Copy", icon: "📢" },
] as const;

const SOURCE_TYPES = [
  { id: "blog_post", label: "Blog Post" },
  { id: "video_transcript", label: "Video Transcript" },
  { id: "podcast_transcript", label: "Podcast Transcript" },
  { id: "article", label: "Article" },
  { id: "product_description", label: "Product Description" },
] as const;

const TONE_OPTIONS = [
  { id: "professional", label: "Professional" },
  { id: "casual", label: "Casual" },
  { id: "bold", label: "Bold" },
  { id: "educational", label: "Educational" },
  { id: "playful", label: "Playful" },
] as const;

type SourceType = typeof SOURCE_TYPES[number]["id"];
type Tone = typeof TONE_OPTIONS[number]["id"];
type PlatformId = typeof PLATFORM_OPTIONS[number]["id"];

// ───────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────

export function ContentRepurposer() {
  const [sourceContent, setSourceContent] = React.useState("");
  const [sourceType, setSourceType] = React.useState<SourceType>("blog_post");
  const [tone, setTone] = React.useState<Tone>("professional");
  const [selectedPlatforms, setSelectedPlatforms] = React.useState<Set<PlatformId>>(
    new Set(["twitter_thread", "linkedin_post", "instagram_caption"]),
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [variants, setVariants] = React.useState<RepurposedVariant[] | null>(null);
  const [keyPoints, setKeyPoints] = React.useState<string[]>([]);

  function togglePlatform(platform: PlatformId) {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  async function handleRepurpose() {
    if (sourceContent.length < 50) {
      setError("Content must be at least 50 characters.");
      return;
    }
    if (selectedPlatforms.size === 0) {
      setError("Select at least one platform.");
      return;
    }
    setLoading(true);
    setError(null);
    setVariants(null);
    setKeyPoints([]);
    try {
      const result = await freelancerApi.content.repurpose({
        sourceContent,
        sourceType,
        platforms: Array.from(selectedPlatforms),
        tone,
      });
      setVariants(result.variants);
      setKeyPoints(result.extractedKeyPoints);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError("Failed to repurpose content. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-lg">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: DARK.text }}>AI Content Repurposer</h2>
        <p className="text-sm mt-1" style={{ color: DARK.textMuted }}>
          Transform existing content into platform-specific variants — Twitter threads, LinkedIn posts, Instagram captions, email newsletters, show notes, meta descriptions, and ad copy.
        </p>
      </div>

      {/* ─── Source content input ─── */}
      <Card style={{ background: DARK.surface, borderColor: DARK.border }}>
        <CardHeader>
          <CardTitle style={{ color: DARK.text }}>Source Content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-md">
          {/* Source type selector */}
          <div>
            <Label style={{ color: DARK.textMuted }}>Source Type</Label>
            <div className="flex flex-wrap gap-sm mt-1">
              {SOURCE_TYPES.map((st) => (
                <button
                  key={st.id}
                  onClick={() => setSourceType(st.id)}
                  className="px-md py-sm rounded-md text-sm transition-colors"
                  style={{
                    background: sourceType === st.id ? DARK.accent : DARK.surfaceMuted,
                    color: sourceType === st.id ? DARK.bg : DARK.textMuted,
                  }}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          {/* Textarea */}
          <div>
            <Label style={{ color: DARK.textMuted }}>Content ({sourceContent.length} chars)</Label>
            <Textarea
              value={sourceContent}
              onChange={(e) => setSourceContent(e.target.value)}
              placeholder="Paste a blog post, video transcript, podcast transcript, article, or product description here…"
              className="mt-1 min-h-[180px]"
              style={{ background: DARK.surfaceMuted, color: DARK.text, borderColor: DARK.border }}
            />
            <p className="text-xs mt-1" style={{ color: DARK.textMuted }}>
              {sourceContent.length < 50 ? `Need ${50 - sourceContent.length} more characters…` : "✓ Content length OK"}
            </p>
          </div>

          {/* Tone selector */}
          <div>
            <Label style={{ color: DARK.textMuted }}>Tone</Label>
            <div className="flex flex-wrap gap-sm mt-1">
              {TONE_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTone(t.id)}
                  className="px-md py-sm rounded-md text-sm transition-colors"
                  style={{
                    background: tone === t.id ? DARK.accent : DARK.surfaceMuted,
                    color: tone === t.id ? DARK.bg : DARK.textMuted,
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Platform selector */}
          <div>
            <Label style={{ color: DARK.textMuted }}>Platforms ({selectedPlatforms.size} selected)</Label>
            <div className="flex flex-wrap gap-sm mt-1">
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => togglePlatform(p.id)}
                  className="flex items-center gap-sm px-md py-sm rounded-md text-sm transition-colors"
                  style={{
                    background: selectedPlatforms.has(p.id) ? `${DARK.accent}20` : DARK.surfaceMuted,
                    color: selectedPlatforms.has(p.id) ? DARK.accent : DARK.textMuted,
                    border: selectedPlatforms.has(p.id) ? `1px solid ${DARK.accent}` : `1px solid ${DARK.border}`,
                  }}
                >
                  <span>{p.icon}</span>
                  {p.label}
                  {selectedPlatforms.has(p.id) && <Check className="w-3 h-3" />}
                </button>
              ))}
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="flex items-center gap-sm rounded-md border p-md text-sm" style={{ borderColor: `${DARK.danger}40`, background: `${DARK.danger}10`, color: DARK.danger }}>
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Submit button */}
          <div className="flex items-center gap-sm">
            <Button
              onClick={handleRepurpose}
              disabled={loading || sourceContent.length < 50 || selectedPlatforms.size === 0}
              style={{ background: DARK.accent, color: DARK.bg }}
            >
              {loading ? (
                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Repurposing…</>
              ) : (
                <><Bot className="w-3 h-3 mr-1" /> Repurpose Content</>
              )}
            </Button>
            <Button variant="outline" onClick={() => { setSourceContent(""); setVariants(null); setKeyPoints([]); setError(null); }} style={{ borderColor: DARK.border, color: DARK.textMuted }}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ─── Extracted key points ─── */}
      {keyPoints.length > 0 && (
        <Card style={{ background: DARK.surface, borderColor: DARK.border }}>
          <CardHeader>
            <CardTitle style={{ color: DARK.text }}>Extracted Key Points ({keyPoints.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-sm">
              {keyPoints.map((point, i) => (
                <li key={i} className="text-sm flex gap-sm" style={{ color: DARK.textMuted }}>
                  <span style={{ color: DARK.accent }}>{i + 1}.</span>
                  {point}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* ─── Generated variants ─── */}
      {variants && variants.length > 0 && (
        <div className="space-y-md">
          <h3 className="text-sm font-semibold" style={{ color: DARK.text }}>
            Generated Variants ({variants.length})
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
            {variants.map((variant) => (
              <VariantCard key={variant.platform} variant={variant} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────
// Variant card — displays one generated variant with copy button
// ───────────────────────────────────────────────

function VariantCard({ variant }: { variant: RepurposedVariant }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(variant.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard might not be available in some contexts.
    }
  }

  const platformMeta = PLATFORM_OPTIONS.find((p) => p.id === variant.platform);
  const icon = platformMeta?.icon ?? "📄";

  return (
    <Card style={{ background: DARK.surface, borderColor: DARK.border }}>
      <CardHeader style={{ paddingBottom: "0.5rem" }}>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-sm">
            <span className="text-lg">{icon}</span>
            <span className="text-sm font-medium" style={{ color: DARK.text }}>{variant.label}</span>
          </div>
          <div className="flex items-center gap-sm">
            {variant.withinLimit ? (
              <Badge variant="success" style={{ background: `${DARK.success}20`, color: DARK.success, border: `1px solid ${DARK.success}40` }}>
                {variant.charCount} chars
              </Badge>
            ) : (
              <Badge variant="danger" style={{ background: `${DARK.danger}20`, color: DARK.danger, border: `1px solid ${DARK.danger}40` }}>
                {variant.charCount} chars — over limit
              </Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              style={{ color: copied ? DARK.success : DARK.textMuted }}
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs mb-sm" style={{ color: DARK.textMuted }}>{variant.description}</p>
        <ScrollArea className="max-h-80 rounded-md border" style={{ borderColor: DARK.border, background: DARK.surfaceMuted }}>
          <pre className="p-md text-xs whitespace-pre-wrap font-mono" style={{ color: DARK.text }}>
            {variant.content}
          </pre>
        </ScrollArea>
        {variant.hashtags && variant.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-sm mt-sm">
            {variant.hashtags.map((tag) => (
              <Badge key={tag} variant="outline" style={{ borderColor: DARK.border, color: DARK.accent }}>
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
