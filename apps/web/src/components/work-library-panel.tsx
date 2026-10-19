"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Download,
  FileText,
  Folder,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";

interface WorkItem {
  id: string;
  title: string;
  type: string;
  status: string;
  content: string | null;
  contentFormat: string | null;
  favorite: boolean;
  folderId: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface WorkFolder {
  id: string;
  name: string;
  type: string;
  color: string | null;
}

interface Props {
  workspaceId: string;
  onStatsChange?: (stats: { items: number; folders: number }) => void;
}

function responseMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const value = payload as { error?: string | { message?: string }; detail?: string };
    if (typeof value.error === "string") return value.error;
    if (value.error?.message) return value.error.message;
    if (value.detail) return value.detail;
  }
  return fallback;
}

function shortDate(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function WorkLibraryPanel({ workspaceId, onStatsChange }: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [folders, setFolders] = useState<WorkFolder[]>([]);
  const [trashItems, setTrashItems] = useState<WorkItem[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [editing, setEditing] = useState<WorkItem | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editorFolderId, setEditorFolderId] = useState("");
  const [folderName, setFolderName] = useState("");

  const load = useCallback(async (search: string) => {
    setLoading(true);
    setError(null);
    try {
      const active = await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const activePayload = await active.json().catch(() => ({}));
      if (!active.ok) throw new Error(responseMessage(activePayload, "Could not select this workspace."));

      const params = new URLSearchParams({ limit: "8", sort: "updated", saveHistory: "false" });
      if (search.trim()) params.set("q", search.trim());
      if (activeFolderId) params.set("folder", activeFolderId);
      const [itemsResponse, foldersResponse] = await Promise.all([
        fetch("/api/work/items?" + params.toString(), { cache: "no-store" }),
        fetch("/api/work/folders", { cache: "no-store" }),
      ]);
      const [itemsPayload, foldersPayload] = await Promise.all([
        itemsResponse.json().catch(() => ({})),
        foldersResponse.json().catch(() => ({})),
      ]);
      if (!itemsResponse.ok) throw new Error(responseMessage(itemsPayload, "Could not load your saved work."));
      if (!foldersResponse.ok) throw new Error(responseMessage(foldersPayload, "Could not load folders."));
      const nextItems = Array.isArray(itemsPayload.data?.items) ? itemsPayload.data.items : [];
      const nextFolders = Array.isArray(foldersPayload.data?.folders) ? foldersPayload.data.folders : [];
      setItems(nextItems);
      setFolders(nextFolders);
      if (!search.trim() && !activeFolderId) {
        onStatsChange?.({ items: Number(itemsPayload.data?.total ?? nextItems.length), folders: nextFolders.length });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your work.");
    } finally {
      setLoading(false);
    }
  }, [activeFolderId, onStatsChange, workspaceId]);

  useEffect(() => { void load(""); }, [load]);

  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    setError(null);
    try {
      const active = await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const activePayload = await active.json().catch(() => ({}));
      if (!active.ok) throw new Error(responseMessage(activePayload, "Could not select this workspace."));
      const response = await fetch("/api/trash", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not load Trash."));
      setTrashItems(Array.isArray(payload.data?.items) ? payload.data.items : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Trash.");
    } finally {
      setTrashLoading(false);
    }
  }, [workspaceId]);

  async function restoreItem(item: WorkItem) {
    setBusyItem(item.id);
    setError(null);
    try {
      const response = await fetch("/api/trash/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not restore this item."));
      setTrashItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice("Item restored to your work library.");
      await load("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this item.");
    } finally {
      setBusyItem(null);
    }
  }

  async function emptyTrash() {
    if (!window.confirm("Permanently delete all items in Trash? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      let deleted = 0;
      for (let batch = 0; batch < 20; batch += 1) {
        const response = await fetch("/api/trash", { method: "DELETE" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(responseMessage(payload, "Could not empty Trash."));
        const result = payload.data as { deleted?: number; hasMore?: boolean };
        deleted += result.deleted ?? 0;
        if (!result.hasMore) break;
      }
      setTrashItems([]);
      setNotice(`Permanently deleted ${String(deleted)} item(s).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not empty Trash.");
      await loadTrash();
    } finally {
      setBusy(false);
    }
  }

  async function createNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/work/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "document",
          title: title.trim(),
          content: body,
          contentFormat: "markdown",
          sourceType: "manual",
          metadata: { origin: "dashboard-note" },
          ...(activeFolderId ? { folderId: activeFolderId } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not save this note."));
      setNoteOpen(false);
      setTitle("");
      setBody("");
      setNotice("Your note has been saved to this workspace.");
      await load("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this note.");
    } finally {
      setBusy(false);
    }
  }

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folderName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/work/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName.trim(), type: "manual" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not create this folder."));
      setFolderName("");
      setFolderOpen(false);
      setNotice("Folder created.");
      await load("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this folder.");
    } finally {
      setBusy(false);
    }
  }

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/work/items/" + editing.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: body, contentFormat: "markdown", folderId: editorFolderId || null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not update this item."));
      setEditing(null);
      setTitle("");
      setBody("");
      setNotice("Changes saved.");
      await load("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this item.");
    } finally {
      setBusy(false);
    }
  }

  async function updateItem(item: WorkItem, patch: { favorite?: boolean; status?: "trash" }) {
    setBusyItem(item.id);
    setError(null);
    try {
      const response = await fetch("/api/work/items/" + item.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not update this item."));
      setNotice(patch.status === "trash" ? "Moved to trash." : patch.favorite ? "Added to favorites." : "Favorite updated.");
      await load("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this item.");
    } finally {
      setBusyItem(null);
    }
  }

  async function exportItem(item: WorkItem) {
    setBusyItem(item.id);
    setError(null);
    try {
      const response = await fetch("/api/work/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "md", selection: { itemIds: [item.id] } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseMessage(payload, "Could not export this item."));
      const result = payload.data as { inline?: boolean; content?: string; filename?: string; status?: string };
      if (!result.inline || typeof result.content !== "string") {
        throw new Error("This export was queued, but downloadable exports are not ready yet. Try Markdown export for one saved item.");
      }
      const blob = new Blob([result.content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename || "supa-work.md";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("Markdown export downloaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export this item.");
    } finally {
      setBusyItem(null);
    }
  }

  function openEditor(item: WorkItem) {
    setEditing(item);
    setTitle(item.title);
    setBody(item.content ?? "");
    setEditorFolderId(item.folderId ?? "");
    setNoteOpen(false);
  }

  const formOpen = noteOpen || Boolean(editing);

  return (
    <section id="my-work" className="scroll-mt-24 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">Your workspace</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Work library</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">Create notes, organize saved work into folders, find previous deliverables, and keep important items close.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setNoteOpen(true); setEditing(null); setTitle(""); setBody(""); setEditorFolderId(activeFolderId ?? ""); setError(null); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-700">
            <Plus className="h-4 w-4" /> New note
          </button>
          <button type="button" onClick={() => { setFolderOpen((open) => !open); setError(null); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            <FolderPlus className="h-4 w-4" /> New folder
          </button>
          <button type="button" onClick={() => { const next = !showTrash; setShowTrash(next); setError(null); if (next) void loadTrash(); }} className={"inline-flex min-h-10 items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition " + (showTrash ? "border-violet-200 bg-violet-50 text-violet-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>
            <Trash2 className="h-4 w-4" /> {showTrash ? "Back to library" : "Trash"}
          </button>
        </div>
      </div>

      {notice && <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800"><Check className="h-4 w-4 shrink-0" /> <span className="flex-1">{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message"><X className="h-4 w-4" /></button></div>}
      {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800"><span className="flex-1">{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X className="h-4 w-4" /></button></div>}

      {folderOpen && <form onSubmit={(event) => void createFolder(event)} className="mt-4 flex flex-col gap-2 rounded-2xl border border-violet-100 bg-violet-50/60 p-4 sm:flex-row">
        <label className="sr-only" htmlFor="new-work-folder">Folder name</label>
        <input id="new-work-folder" value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={100} required placeholder="Folder name, e.g. Client projects" className="min-h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" />
        <button disabled={busy || !folderName.trim()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />} Create folder</button>
      </form>}

      <form onSubmit={(event) => { event.preventDefault(); void load(query); }} className="mt-5 flex gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-slate-400 focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100">
          <Search className="h-4 w-4 shrink-0" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your saved work…" aria-label="Search saved work" className="min-w-0 w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400" />
        </label>
        <button type="submit" disabled={loading} className="rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Search</button>
        {query && <button type="button" onClick={() => { setQuery(""); void load(""); }} className="rounded-xl px-3 text-sm font-medium text-slate-500 hover:bg-slate-100">Clear</button>}
      </form>

      {folders.length > 0 && <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Folders</p>
        <div className="flex flex-wrap gap-2">
          {folders.slice(0, 8).map((folder) => <button key={folder.id} type="button" onClick={() => { setQuery(""); setActiveFolderId(folder.id === activeFolderId ? null : folder.id); }} aria-pressed={activeFolderId === folder.id} className={"inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition " + (activeFolderId === folder.id ? "border-violet-200 bg-violet-50 text-violet-800" : "border-slate-200 bg-slate-50 text-slate-700 hover:border-violet-200")}><Folder className="h-3.5 w-3.5" style={{ color: folder.color ?? "#7c3aed" }} />{folder.name}</button>)}
          {folders.length > 8 && <span className="px-2 py-2 text-xs text-slate-400">+{folders.length - 8} more</span>}
          {activeFolderId && <button type="button" onClick={() => { setActiveFolderId(null); setQuery(""); }} className="rounded-xl px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50">All work</button>}
        </div>
      </div>}

      {showTrash && <div className="mt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold text-slate-900">Trash</h3><p className="mt-1 text-xs text-slate-500">Restore saved work or permanently remove it.</p></div>
          <button type="button" onClick={() => void emptyTrash()} disabled={busy || trashLoading || trashItems.length === 0} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">Empty trash</button>
        </div>
        {trashLoading ? <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 py-10 text-sm text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading Trash…</div> : trashItems.length ? <div className="space-y-2">
          {trashItems.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Trash2 className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{item.title || "Untitled work"}</span><span className="mt-1 block text-xs capitalize text-slate-400">{item.type.replaceAll("_", " ")} · Updated {shortDate(item.updatedAt)}</span></span>
            <button type="button" onClick={() => void restoreItem(item)} disabled={busyItem === item.id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{busyItem === item.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore</button>
          </article>)}
        </div> : <div className="rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-800">Trash is empty</p><p className="mt-1 text-xs text-slate-500">Items you move to Trash will appear here.</p></div>}
      </div>}
      {!showTrash && <div className="mt-5">
        {loading ? <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 py-12 text-sm text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading your work…</div> : items.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => <article key={item.id} className="group min-w-0 rounded-2xl border border-slate-200 p-4 transition hover:border-violet-200 hover:shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><FileText className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-slate-900">{item.title || "Untitled work"}</h3>
                  <p className="mt-1 text-[11px] capitalize text-slate-400">{item.type.replaceAll("_", " ")} · Updated {shortDate(item.updatedAt)}</p>
                </div>
                <button type="button" onClick={() => void updateItem(item, { favorite: !item.favorite })} disabled={busyItem === item.id} aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"} title={item.favorite ? "Remove favorite" : "Add favorite"} className={"rounded-lg p-1.5 " + (item.favorite ? "text-amber-500" : "text-slate-300 hover:text-amber-500")}><Star className="h-4 w-4" fill={item.favorite ? "currentColor" : "none"} /></button>
              </div>
              <p className="mt-3 line-clamp-3 min-h-[3.75rem] whitespace-pre-wrap text-xs leading-5 text-slate-500">{item.content?.trim() || "No text preview available for this item."}</p>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <div className="flex items-center gap-3"><button type="button" onClick={() => openEditor(item)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 hover:text-violet-900"><Pencil className="h-3.5 w-3.5" /> Open & edit</button><button type="button" onClick={() => void exportItem(item)} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-violet-700" title="Export Markdown"><Download className="h-3.5 w-3.5" /> Export</button></div>
                <button type="button" onClick={() => { if (window.confirm("Move this item to trash? You can restore it later from Trash.")) void updateItem(item, { status: "trash" }); }} disabled={busyItem === item.id} aria-label={"Move " + item.title + " to trash"} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </article>)}
          </div>
        ) : <div className="rounded-2xl border border-dashed border-slate-200 px-5 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-700"><FileText className="h-5 w-5" /></div>
          <h3 className="mt-3 text-sm font-semibold text-slate-900">{query ? "No matching work found" : "Your library is ready"}</h3>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{query ? "Try another search term or clear your search." : "Save notes and AI deliverables here. Your saved work stays attached to this workspace."}</p>
          {!query && <button type="button" onClick={() => { setNoteOpen(true); setTitle(""); setBody(""); setEditorFolderId(activeFolderId ?? ""); }} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-violet-700"><Plus className="h-3.5 w-3.5" /> Create your first note</button>}
        </div>}
      </div>}

      {formOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="work-item-dialog-title">
        <form onSubmit={(event) => void (editing ? saveItem(event) : createNote(event))} className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-xs font-bold uppercase tracking-wide text-violet-700">{editing ? "Saved work" : "Work library"}</p><h2 id="work-item-dialog-title" className="mt-1 text-xl font-semibold text-slate-950">{editing ? "Edit item" : "Create a note"}</h2></div>
            <button type="button" onClick={() => { setEditing(null); setNoteOpen(false); }} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close editor"><X className="h-4 w-4" /></button>
          </div>
          <label htmlFor="work-item-title" className="mt-5 block text-xs font-semibold text-slate-600">Title</label>
          <input id="work-item-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} className="mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" placeholder="Give this work a clear title" />
          <label htmlFor="work-item-folder" className="mt-4 block text-xs font-semibold text-slate-600">Save in folder</label>
          <select id="work-item-folder" value={editorFolderId} onChange={(event) => setEditorFolderId(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100">
            <option value="">No folder</option>
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
          <label htmlFor="work-item-body" className="mt-4 block text-xs font-semibold text-slate-600">Content</label>
          <textarea id="work-item-body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={1000000} rows={10} className="mt-1.5 w-full resize-y rounded-xl border border-slate-200 px-3 py-3 text-sm leading-6 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" placeholder="Write notes, paste a draft, or save useful information…" />
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => { setEditing(null); setNoteOpen(false); }} className="min-h-10 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={busy || !title.trim()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{editing ? "Save changes" : "Save note"}</button>
          </div>
        </form>
      </div>}
    </section>
  );
}
