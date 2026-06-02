import React, { useState, useEffect, useCallback, useRef } from 'react';

interface DocRecord {
  id: string;
  filename: string;
  title?: string;
  status: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: number;
  summary?: string;
  tags: string[];
}

interface AnalyzeLog {
  message: string;
  level: 'info' | 'warn' | 'error';
  done: boolean;
}

interface UrlImportEntry {
  url: string;
  state: 'pending' | 'importing' | 'done' | 'error';
  error?: string;
  isMerge?: boolean;
}

/** Parse a blob of text into a clean list of URLs (handles commas, newlines, quotes) */
function parseUrlList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.replace(/["'\s]/g, ''))
    .filter((s) => s.startsWith('http'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: 'bg-green-900 text-green-300 border-green-700',
    analysed: 'bg-blue-900 text-blue-300 border-blue-700',
    processing: 'bg-yellow-900 text-yellow-300 border-yellow-700',
    pending: 'bg-gray-700 text-gray-300 border-gray-600',
    error: 'bg-red-900 text-red-300 border-red-700',
  };
  const cls = styles[status] ?? styles.pending;
  const isSpinning = status === 'processing';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border ${cls}`}>
      {isSpinning && (
        <svg className="w-3 h-3 mr-1 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      )}
      {status}
    </span>
  );
}

function LogEntry({ log }: { log: AnalyzeLog }) {
  const color =
    log.level === 'error'
      ? 'text-red-400'
      : log.level === 'warn'
      ? 'text-yellow-400'
      : log.done
      ? 'text-green-400'
      : 'text-gray-300';
  return <p className={`text-xs font-mono leading-snug ${color}`}>{log.message}</p>;
}

// ── URL Import Modal ──────────────────────────────────────────────────────────

interface UrlImportModalProps {
  onClose: () => void;
  onImportDone: () => void;
}

function UrlImportModal({ onClose, onImportDone }: UrlImportModalProps) {
  const [rawText, setRawText] = useState('');
  const [entries, setEntries] = useState<UrlImportEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [concatMode, setConcatMode] = useState(true);

  const parsedUrls = parseUrlList(rawText);

  const handleStart = async () => {
    if (parsedUrls.length === 0) return;

    const urlEntries: UrlImportEntry[] = parsedUrls.map((url) => ({ url, state: 'pending' }));
    const saveRow: UrlImportEntry = {
      url: `Save ${parsedUrls.length} pages as one document`,
      state: 'pending',
      isMerge: true,
    };
    const allEntries: UrlImportEntry[] = concatMode ? [...urlEntries, saveRow] : [...urlEntries];

    setEntries(allEntries);
    setRunning(true);
    setAllDone(false);

    const working = [...allEntries];

    if (concatMode) {
      // ─ Concat mode: fetch content per URL (no individual docs created), then save once
      const markdowns: string[] = [];
      for (let i = 0; i < urlEntries.length; i++) {
        working[i] = { ...working[i], state: 'importing' };
        setEntries([...working]);
        try {
          const res = await window.copilot.docsFetchUrlMarkdown(working[i].url);
          if (res.success && res.markdown) {
            working[i] = { ...working[i], state: 'done' };
            markdowns.push(res.markdown);
          } else {
            working[i] = { ...working[i], state: 'error', error: res.error ?? 'Fetch failed' };
          }
        } catch (err) {
          working[i] = { ...working[i], state: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        setEntries([...working]);
      }

      const mergeIdx = working.length - 1;
      if (markdowns.length > 0) {
        working[mergeIdx] = { ...working[mergeIdx], state: 'importing' };
        setEntries([...working]);
        try {
          const combined = markdowns.join('\n\n---\n\n');
          const title = `Merged (${markdowns.length} of ${parsedUrls.length} sources)`;
          const res = await window.copilot.docsSaveMarkdown(title, combined);
          working[mergeIdx] = {
            ...working[mergeIdx],
            state: res.success ? 'done' : 'error',
            error: res.success ? undefined : (res.error ?? 'Save failed'),
          };
        } catch (err) {
          working[mergeIdx] = { ...working[mergeIdx], state: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        setEntries([...working]);
      } else {
        working.splice(mergeIdx, 1);
        setEntries([...working]);
      }
    } else {
      // ─ Separate mode: create one doc per URL (existing behaviour)
      for (let i = 0; i < urlEntries.length; i++) {
        working[i] = { ...working[i], state: 'importing' };
        setEntries([...working]);
        try {
          const res = await window.copilot.docsImportFromUrl(working[i].url);
          if (res.success) {
            working[i] = { ...working[i], state: 'done' };
          } else {
            working[i] = { ...working[i], state: 'error', error: res.error ?? 'Import failed' };
          }
        } catch (err) {
          working[i] = { ...working[i], state: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        setEntries([...working]);
      }
    }

    setRunning(false);
    setAllDone(true);
    onImportDone();
  };

  const entryIcon = (e: UrlImportEntry) => {
    if (e.state === 'importing') return (
      <svg className="w-3.5 h-3.5 animate-spin text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
    );
    if (e.state === 'done') return (
      <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
    if (e.state === 'error') return (
      <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
    return (
      <span className="w-3.5 h-3.5 rounded-full border border-gray-500 flex-shrink-0 inline-block" />
    );
  };

  const doneCount = entries.filter((e) => e.state === 'done').length;
  const errCount = entries.filter((e) => e.state === 'error').length;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}
    >
      {/* Panel */}
      <div className="relative w-[560px] max-w-[95vw] max-h-[85vh] flex flex-col bg-gray-850 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 bg-gray-800">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Import URLs</h2>
            <p className="text-xs text-gray-400 mt-0.5">Paste one or more URLs — comma or newline separated</p>
          </div>
          {!running && (
            <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300 rounded transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* Textarea (shown before running) */}
          {!running && !allDone && (
            <div>
              <textarea
                className="w-full h-40 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-xs text-gray-200 placeholder-gray-500 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder={`Paste URLs here, e.g.:\nhttps://docs.example.com/page1,\nhttps://docs.example.com/page2`}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                spellCheck={false}
              />
              {parsedUrls.length > 0 && (
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500 flex-shrink-0">
                    <span className="text-blue-400 font-semibold">{parsedUrls.length}</span> URL{parsedUrls.length !== 1 ? 's' : ''} detected
                  </p>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={concatMode}
                      onChange={(e) => setConcatMode(e.target.checked)}
                      className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                    />
                    <span className="text-xs text-gray-300">Merge into one document</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Preview / progress list */}
          {(entries.length > 0 || (parsedUrls.length > 0 && !running && !allDone)) && (
            <div className="space-y-1.5">
              {(running || allDone ? entries : parsedUrls.map((url): UrlImportEntry => ({ url, state: 'pending' }))).map((e, i) => (
                <div key={i} className="flex items-start gap-2 py-1.5 px-2.5 bg-gray-800/70 rounded-lg">
                  <div className="mt-0.5">{entryIcon(e)}</div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs truncate ${e.isMerge ? 'text-blue-300 italic' : 'text-gray-300 font-mono'}`} title={e.url}>{e.url}</p>
                    {e.state === 'error' && e.error && (
                      <p className="text-xs text-red-400 mt-0.5">{e.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Summary when done */}
          {allDone && (
            <div className="flex items-center gap-3 p-3 bg-gray-800 rounded-lg text-xs">
              <span className="text-green-400 font-semibold">{doneCount} imported</span>
              {errCount > 0 && <span className="text-red-400 font-semibold">{errCount} failed</span>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-700 bg-gray-800 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {running ? `Importing ${entries.filter(e => e.state !== 'pending').length} / ${entries.length}…` : ''}
          </span>
          <div className="flex gap-2">
            {!running && (
              <button
                onClick={onClose}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
              >
                {allDone ? 'Close' : 'Cancel'}
              </button>
            )}
            {!allDone && (
              <button
                onClick={() => void handleStart()}
                disabled={running || parsedUrls.length === 0}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded transition-colors"
              >
                {running ? (
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                )}
                {running ? 'Importing…' : `Import ${parsedUrls.length > 0 ? parsedUrls.length : ''} URL${parsedUrls.length !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const DocUploadPanel: React.FC = () => {
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Map of docId → log lines for the inline log panel */
  const [analyzeLogs, setAnalyzeLogs] = useState<Record<string, AnalyzeLog[]>>({});
  /** Set of docIds currently being analyzed */
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  /** Which doc's log panel is expanded */
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);

  const fetchDocs = useCallback(async () => {
    try {
      const result = await window.copilot.docsList();
      if (result.success && result.documents) {
        setDocs(result.documents);
      }
    } catch (err) {
      console.error('[DocUploadPanel] docsList error:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchDocs().finally(() => setLoading(false));
  }, [fetchDocs]);

  // Poll while any doc is still processing
  useEffect(() => {
    const hasProcessing = docs.some((d) => d.status === 'processing' || d.status === 'pending');
    if (!hasProcessing) return;
    const timer = setInterval(fetchDocs, 3000);
    return () => clearInterval(timer);
  }, [docs, fetchDocs]);

  // Register the global log push listener once
  useEffect(() => {
    const cleanup = window.copilot.onDocsAnalyzeLog((_event, payload) => {
      const { docId, message, level, done } = payload;
      setAnalyzeLogs((prev) => ({
        ...prev,
        [docId]: [...(prev[docId] ?? []), { message, level, done }],
      }));
      if (done) {
        setAnalyzingIds((prev) => {
          const next = new Set(prev);
          next.delete(docId);
          return next;
        });
        void fetchDocs();
      }
    });
    return cleanup;
  }, [fetchDocs]);

  // Auto-scroll log panel when new entries arrive
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [analyzeLogs, expandedLogId]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleUpload = async () => {
    setUploading(true);
    setError(null);
    try {
      const result = await window.copilot.docsOpenAndUpload();
      if (!result.canceled && !result.success) {
        setError(result.error ?? 'Upload failed');
      } else {
        await fetchDocs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleAnalyze = async (docId: string) => {
    setAnalyzeLogs((prev) => ({ ...prev, [docId]: [] }));
    setAnalyzingIds((prev) => new Set(prev).add(docId));
    setExpandedLogId(docId);
    setError(null);
    try {
      const result = await window.copilot.docsAnalyze(docId);
      if (!result.success) {
        setError(result.error ?? 'Analysis failed to start');
        setAnalyzingIds((prev) => { const n = new Set(prev); n.delete(docId); return n; });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAnalyzingIds((prev) => { const n = new Set(prev); n.delete(docId); return n; });
    }
  };

  const handleDelete = async (docId: string, filename: string) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;
    try {
      await window.copilot.docsDelete(docId);
      setDocs((prev) => prev.filter((d) => d.id !== docId));
      setAnalyzeLogs((prev) => { const n = { ...prev }; delete n[docId]; return n; });
      if (expandedLogId === docId) setExpandedLogId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAttachToChat = (docId: string, title: string) => {
    window.dispatchEvent(new CustomEvent('attach-doc-to-chat', { detail: { docId, title } }));
  };

  const handlePreview = async (doc: DocRecord) => {
    const res = await window.copilot.docsGetContent(doc.id);
    if (res.success && res.content) {
      window.dispatchEvent(new CustomEvent('preview-doc', {
        detail: { docId: doc.id, title: doc.title ?? doc.filename, content: res.content },
      }));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {showUrlModal && (
        <UrlImportModal
          onClose={() => setShowUrlModal(false)}
          onImportDone={() => { void fetchDocs(); }}
        />
      )}

      <div className="flex flex-col h-full">

        {/* ── Action buttons ─────────────────────────────────────────── */}
        <div className="px-3 pt-3 pb-2 border-b border-gray-700 space-y-2">

          {/* Import URLs button */}
          <button
            onClick={() => setShowUrlModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Import URLs…
          </button>

          {/* File upload (secondary) */}
          <button
            onClick={() => void handleUpload()}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 text-xs rounded transition-colors"
          >
            {uploading ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Uploading…
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Upload local file (PDF, DOCX, MD, TXT)
              </>
            )}
          </button>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* ── Document List ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {loading && docs.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-gray-500 text-xs">Loading…</div>
          ) : docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-gray-500">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <p className="text-xs">No documents yet.</p>
              <p className="text-xs mt-1 opacity-60">Import URLs or upload a file to get started.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-800">
              {docs.map((doc) => {
                const isAnalyzing = analyzingIds.has(doc.id);
                const logs = analyzeLogs[doc.id] ?? [];
                const showLogs = expandedLogId === doc.id && logs.length > 0;
                const canAnalyze = !isAnalyzing;

                return (
                  <li key={doc.id} className="px-3 py-3 hover:bg-gray-800/60 group">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {/* Title row */}
                        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                          <span className="text-xs font-medium text-gray-200 truncate max-w-[140px]" title={doc.title ?? doc.filename}>
                            {doc.title ?? doc.filename}
                          </span>
                          <StatusBadge status={isAnalyzing ? 'processing' : doc.status} />
                        </div>

                        {/* Meta */}
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span className="uppercase">{doc.fileType}</span>
                          <span>·</span>
                          <span>{formatBytes(doc.sizeBytes)}</span>
                        </div>

                        {/* Summary */}
                        {doc.summary && (
                          <p className="mt-1 text-xs text-gray-400 line-clamp-2">{doc.summary}</p>
                        )}

                        {/* Tags */}
                        {doc.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {doc.tags.slice(0, 4).map((tag) => (
                              <span key={tag} className="px-1 py-0.5 bg-gray-700 text-gray-400 rounded text-xs">{tag}</span>
                            ))}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center gap-3 mt-1.5">
                          {/* Preview button */}
                          <button
                            onClick={() => void handlePreview(doc)}
                            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                            title="Open in preview tab"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                            Preview
                          </button>

                          {/* Analyze button */}
                          <button
                            disabled={!canAnalyze}
                            onClick={() => void handleAnalyze(doc.id)}
                            className="flex items-center gap-1 text-xs font-semibold text-purple-400 hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            title="Run the documentation refiner pipeline on this document"
                          >
                            {isAnalyzing ? (
                              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                              </svg>
                            ) : (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.07 4.93a10 10 0 0 1 1.4 13.05M4.93 19.07A10 10 0 0 1 3.53 6.02" />
                                <path d="M2 12a10 10 0 1 0 10-10" />
                              </svg>
                            )}
                            {isAnalyzing ? 'Analysing…' : 'Analyze'}
                          </button>

                          {/* Toggle logs */}
                          {logs.length > 0 && (
                            <button
                              onClick={() => setExpandedLogId(expandedLogId === doc.id ? null : doc.id)}
                              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                              {showLogs ? 'Hide logs' : `Show logs (${logs.length})`}
                            </button>
                          )}

                          {/* Attach to chat */}
                          {doc.status !== 'error' && doc.status !== 'processing' && (
                            <button
                              onClick={() => handleAttachToChat(doc.id, doc.title ?? doc.filename)}
                              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                              title="Attach this document to the next chat message"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                              </svg>
                              Attach to Chat
                            </button>
                          )}
                        </div>

                        {/* Inline log panel */}
                        {showLogs && (
                          <div
                            ref={logPanelRef}
                            className="mt-2 bg-gray-900 border border-gray-700 rounded p-2 max-h-40 overflow-y-auto space-y-0.5"
                          >
                            {logs.map((log, i) => (
                              <LogEntry key={i} log={log} />
                            ))}
                            {isAnalyzing && (
                              <p className="text-xs text-gray-500 font-mono animate-pulse">…running</p>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Delete button */}
                      <button
                        onClick={() => void handleDelete(doc.id, doc.filename)}
                        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 text-gray-500 hover:text-red-400 rounded transition-all"
                        title="Delete document"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
};

export default DocUploadPanel;
