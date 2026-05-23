import React, { useEffect, useState } from 'react';
import { Button } from '@ux-aspects-universal/react/button';

interface DraftItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const DraftsPane: React.FC<{ onLoad?: (id: string) => Promise<void>; onDelete?: (id: string) => Promise<void> }> = ({ onLoad, onDelete }) => {
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDrafts = async () => {
    setLoading(true);
    setError(null);
    try {
      // @ts-ignore - exposed by preload
      const res = await window.copilot.listDeploymentDrafts();
      if (!res || !res.success) {
        setDrafts([]);
        setError(res?.error || 'Failed to list drafts');
      } else {
        setDrafts(res.drafts || []);
      }
    } catch (e: any) {
      setDrafts([]);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDrafts();
  }, []);

  const handleLoad = async (id: string) => {
    if (onLoad) {
      await onLoad(id);
      return;
    }

    // fallback: directly load via preload
    try {
      // @ts-ignore
      const res = await window.copilot.loadDeploymentDraft(id);
      if (!res || !res.success) {
        window.alert(res?.error || 'Failed to load draft');
        return;
      }
      // emit a browser-level event so App can react if needed
      window.dispatchEvent(new CustomEvent('deploymentDraftLoaded', { detail: res.plan }));
    } catch (e: any) {
      window.alert(e?.message || String(e));
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Delete draft? This cannot be undone.');
    if (!confirmed) return;

    if (onDelete) {
      await onDelete(id);
      await fetchDrafts();
      return;
    }

    try {
      // @ts-ignore
      const res = await window.copilot.deleteDeploymentDraft(id);
      if (!res || !res.success) {
        window.alert(res?.error || 'Failed to delete draft');
        return;
      }
      await fetchDrafts();
    } catch (e: any) {
      window.alert(e?.message || String(e));
    }
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Button size="small" primary onClick={() => void fetchDrafts()}>
          Refresh
        </Button>
      </div>

      {loading && <div className="text-sm text-gray-400">Loading...</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="space-y-2">
        {drafts.map((d) => (
          <div key={d.id} className="p-2 bg-gray-800 border border-gray-700 rounded">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-sm font-medium text-gray-200">{d.name}</div>
                <div className="text-xs text-gray-400">{d.id}</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-gray-400 mr-2">{d.status}</div>
                <Button size="small" onClick={() => void handleLoad(d.id)}>Load</Button>
                <Button size="small" flat onClick={() => void handleDelete(d.id)}>Delete</Button>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-2">Updated: {new Date(d.updatedAt).toLocaleString()}</div>
          </div>
        ))}

        {drafts.length === 0 && !loading && <div className="text-sm text-gray-500">No drafts found.</div>}
      </div>
    </div>
  );
};

export default DraftsPane;
