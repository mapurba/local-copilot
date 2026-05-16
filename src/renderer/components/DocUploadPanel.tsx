import React, { useState, useEffect, useCallback } from 'react';

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: 'bg-green-900 text-green-300 border-green-700',
    processing: 'bg-yellow-900 text-yellow-300 border-yellow-700',
    pending: 'bg-gray-700 text-gray-300 border-gray-600',
    error: 'bg-red-900 text-red-300 border-red-700',
  };
  const cls = styles[status] ?? styles.pending;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border ${cls}`}>
      {status === 'processing' && (
        <svg className="w-3 h-3 mr-1 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      )}
      {status}
    </span>
  );
}

const DocUploadPanel: React.FC = () => {
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleUpload = async () => {
    setUploading(true);
    setError(null);
    try {
      const result = await window.copilot.docsOpenAndUpload();
      if (result.canceled) {
        // user cancelled — no-op
      } else if (!result.success) {
        setError(result.error ?? 'Upload failed');
      } else {
        // Refresh list after upload starts
        await fetchDocs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (docId: string, filename: string) => {
    if (!window.confirm(`Delete "${filename}"?`)) return;
    try {
      await window.copilot.docsDelete(docId);
      setDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Upload Button */}
      <div className="px-3 py-3 border-b border-gray-700">
        <button
          onClick={handleUpload}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded transition-colors"
        >
          {uploading ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Uploading…
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload Document
            </>
          )}
        </button>
        {error && (
          <p className="mt-2 text-xs text-red-400">{error}</p>
        )}
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto">
        {loading && docs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-gray-500 text-xs">
            Loading…
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-gray-500">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
            <p className="text-xs">No documents uploaded yet.</p>
            <p className="text-xs mt-1 opacity-60">Upload PDFs, DOCX, MD, or TXT files to ask the AI about them.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-800">
            {docs.map((doc) => (
              <li key={doc.id} className="px-3 py-3 hover:bg-gray-800 group">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className="text-xs font-medium text-gray-200 truncate max-w-[140px]" title={doc.title ?? doc.filename}>
                        {doc.title ?? doc.filename}
                      </span>
                      <StatusBadge status={doc.status} />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="uppercase">{doc.fileType}</span>
                      <span>·</span>
                      <span>{formatBytes(doc.sizeBytes)}</span>
                    </div>
                    {doc.summary && (
                      <p className="mt-1 text-xs text-gray-400 line-clamp-2">{doc.summary}</p>
                    )}
                    {doc.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {doc.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="px-1 py-0.5 bg-gray-700 text-gray-400 rounded text-xs">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(doc.id, doc.filename)}
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
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default DocUploadPanel;
