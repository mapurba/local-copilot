import React, { useEffect, useState } from 'react';
import { Button } from '@ux-aspects-universal/react/button';
import TemplateEditor from './TemplateEditor';

const TemplatesPane: React.FC = () => {
  const [templates, setTemplates] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingXml, setEditingXml] = useState<string | null>(null);

  const fetchTemplates = async (nameFilter?: string) => {
    setLoading(true);
    setError(null);
    try {
      // Try to invoke the IPC handler, with a short retry/backoff when the main process
      // hasn't yet registered handlers ("No handler registered" race).
      const maxAttempts = 5;
      let attempt = 0;
      let lastErr: any = null;
      // @ts-ignore - exposed in preload
      while (attempt < maxAttempts) {
        try {
          const res = await window.copilot.listTemplates(nameFilter ?? '');
          if (!res || !res.success) {
            // If it's a transient IPC registration error, retry
            const errMsg = res?.error || '';
            if (/No handler registered/i.test(errMsg)) {
              lastErr = new Error(errMsg);
              attempt += 1;
              await new Promise((r) => setTimeout(r, 150 * attempt));
              continue;
            }
            setTemplates([]);
            setError(errMsg || 'Failed to list templates');
            return;
          }
          setTemplates((res.templates as Array<Record<string, any>>) || []);
          return;
        } catch (e: any) {
          lastErr = e;
          if (/No handler registered/i.test(e?.message || '')) {
            attempt += 1;
            await new Promise((r) => setTimeout(r, 150 * attempt));
            continue;
          }
          throw e;
        }
      }
      // If we exhausted retries, surface last error
      setTemplates([]);
      setError(lastErr?.message || 'Failed to list templates after retries');
    } catch (e: any) {
      setTemplates([]);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const openEditorFor = async (template: Record<string, any>) => {
    try {
      setLoading(true);
      setError(null);
      const id = String(template.template_id || template.templateId || template.id || '');
      if (!id) throw new Error('Template id missing');
      // @ts-ignore
      const res = await window.copilot.getTemplate(id);
      if (!res || !res.success) {
        setError(res?.error || 'Failed to fetch template');
        return;
      }
      setEditingTemplateId(id);
      setEditingXml(res.xml || '');
      setEditorOpen(true);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (templateId: string, newXml: string) => {
    try {
      setLoading(true);
      setError(null);
      // @ts-ignore
      const res = await window.copilot.updateTemplate({ templateId, xml: newXml });
      if (!res || !res.success) {
        setError(res?.error || 'Failed to update template');
      } else {
        setEditorOpen(false);
        // refresh list
        await fetchTemplates(filter || undefined);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <input
          className="flex-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-100"
          placeholder="Search templates (name)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button size="small" primary onClick={() => fetchTemplates(filter)}>
          Search
        </Button>
        <Button size="small" flat onClick={() => fetchTemplates()}>
          Refresh
        </Button>
      </div>

      {loading && <div className="text-sm text-gray-400">Loading...</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="space-y-2">
        {templates.map((t) => (
          <div
            key={t.template_id || t.name}
            className="p-2 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 cursor-pointer"
            onClick={() => openEditorFor(t)}
          >
            <div className="flex justify-between items-center">
              <div className="text-sm font-medium text-gray-200">{t.name}</div>
              <div className="text-xs text-gray-400">{t.template_id}</div>
            </div>
            <div className="text-xs text-gray-400">{t.catalog || t.catalogName}</div>
            {t.description && <div className="text-xs text-gray-500 mt-1">{t.description}</div>}
          </div>
        ))}
        {templates.length === 0 && !loading && <div className="text-sm text-gray-500">No templates found.</div>}
      </div>

      {editorOpen && editingTemplateId && (
        <TemplateEditor
          open={editorOpen}
          templateId={editingTemplateId}
          initialXml={editingXml || ''}
          onClose={() => setEditorOpen(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
};

export default TemplatesPane;
