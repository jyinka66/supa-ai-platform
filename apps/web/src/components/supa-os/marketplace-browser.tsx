"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supaOsApi, type MarketplaceItem } from "@/lib/api-client";
import { Search, Download, Star, CheckCircle } from "lucide-react";

const TYPE_FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "agent_skill", label: "Agent Skills" },
  { id: "api_connector", label: "API Connectors" },
  { id: "ui_component", label: "UI Components" },
  { id: "template", label: "Templates" },
  { id: "theme", label: "Themes" },
];

const SORT_OPTIONS = ["trending", "newest", "top_rated", "most_downloaded", "featured"] as const;

export function MarketplaceBrowser() {
  const [items, setItems] = React.useState<MarketplaceItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [sort, setSort] = React.useState<(typeof SORT_OPTIONS)[number]>("trending");
  const [selectedItem, setSelectedItem] = React.useState<MarketplaceItem | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await supaOsApi.marketplace.list({
        q: query || undefined,
        type: typeFilter === "all" ? undefined : typeFilter,
        sort,
      });
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load marketplace");
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, sort]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-7xl space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Marketplace</h1>
          <p className="text-sm text-textMuted mt-1">Agent skills, API connectors, UI components, templates, and themes.</p>
        </div>
        <Button>+ Submit item</Button>
      </div>

      <Card>
        <CardContent className="p-md flex flex-wrap items-center gap-md">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-md top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
            <Input
              placeholder="Search items…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-lg"
            />
          </div>
          <div className="flex gap-sm">
            {TYPE_FILTERS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={typeFilter === t.id ? "default" : "outline"}
                onClick={() => setTypeFilter(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="h-10 rounded-md border border-border bg-surface px-md text-sm"
          >
            {SORT_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
        </CardContent>
      </Card>

      {error && <div className="text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="text-textMuted text-center py-lg">Loading items…</div>
      ) : items.length === 0 ? (
        <div className="text-textMuted text-center py-lg">No items match your filters.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
          {items.map((item) => (
            <MarketplaceCard key={item.id} item={item} onSelect={() => setSelectedItem(item)} />
          ))}
        </div>
      )}

      {selectedItem && (
        <ItemDetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

function MarketplaceCard({ item, onSelect }: { item: MarketplaceItem; onSelect: () => void }) {
  return (
    <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={onSelect}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">{item.name}</CardTitle>
            <div className="flex items-center gap-sm mt-1">
              <Badge variant="outline">{item.type.replace(/_/g, " ")}</Badge>
              {item.verified && <CheckCircle className="w-3 h-3 text-success" />}
            </div>
          </div>
          <div className="text-right">
            {item.monetization === "free" ? (
              <Badge variant="success">Free</Badge>
            ) : (
              <div className="text-sm font-semibold">${item.price}</div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-textMuted line-clamp-2">{item.description}</p>
        <div className="flex items-center gap-md mt-md text-xs text-textMuted">
          <span className="flex items-center gap-1">
            <Download className="w-3 h-3" /> {item.downloadCount}
          </span>
          <span className="flex items-center gap-1">
            <Star className="w-3 h-3" /> {item.rating.toFixed(1)} ({item.reviewCount})
          </span>
          <span>v{item.version}</span>
        </div>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-sm">
            {item.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="default">{tag}</Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ItemDetailModal({ item, onClose }: { item: MarketplaceItem; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-lg z-50" onClick={onClose}>
      <Card className="max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{item.name}</CardTitle>
              <div className="flex items-center gap-sm mt-1">
                <Badge variant="outline">{item.type.replace(/_/g, " ")}</Badge>
                {item.verified && <Badge variant="success"><CheckCircle className="w-3 h-3 mr-1" /> Verified</Badge>}
                <span className="text-xs text-textMuted">v{item.version}</span>
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-md">
          <p className="text-sm">{item.description}</p>
          <div className="grid grid-cols-3 gap-md text-sm">
            <div>
              <div className="text-xs text-textMuted">Price</div>
              <div className="font-medium">{item.monetization === "free" ? "Free" : `$${item.price}`}</div>
            </div>
            <div>
              <div className="text-xs text-textMuted">Downloads</div>
              <div className="font-medium">{item.downloadCount}</div>
            </div>
            <div>
              <div className="text-xs text-textMuted">Rating</div>
              <div className="font-medium">{item.rating.toFixed(1)} ({item.reviewCount} reviews)</div>
            </div>
          </div>
          {item.tags.length > 0 && (
            <div>
              <div className="text-xs text-textMuted mb-sm">Tags</div>
              <div className="flex flex-wrap gap-sm">
                {item.tags.map((tag) => <Badge key={tag} variant="default">{tag}</Badge>)}
              </div>
            </div>
          )}
          <div className="flex gap-sm pt-md">
            <Button>Install</Button>
            <Button variant="outline">View source</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
