import React, { useEffect, useRef, useState } from 'react';

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

/** Shorten a model id to a readable label, e.g. "claude-3.5-sonnet" → "Claude 3.5 Sonnet" */
function labelOf(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/, 'GPT')
    .replace(/\bO1\b/, 'o1')
    .replace(/\bO3\b/, 'o3');
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ selectedModel, onModelChange }) => {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const onModelChangeRef = useRef(onModelChange);
  onModelChangeRef.current = onModelChange;

  useEffect(() => {
    const fetchModels = async () => {
      try {
        setLoading(true);
        const list = await window.copilot.getModels();
        setModels(list);
        if (list.length > 0 && !selectedModel) onModelChangeRef.current(list[0]);
      } catch {
        setModels(['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'claude-3-opus', 'o1', 'o1-preview']);
      } finally {
        setLoading(false);
      }
    };
    fetchModels();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Pill trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border
          ${open
            ? 'bg-gray-600 border-gray-500 text-white'
            : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600 hover:text-white hover:border-gray-500'
          }`}
      >
        {/* Sparkle icon */}
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z" />
        </svg>
        <span className="max-w-[120px] truncate">
          {loading ? 'Loading…' : labelOf(selectedModel)}
        </span>
        <svg className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown — opens upward */}
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Select Model</span>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {models.map((m) => (
              <button
                key={m}
                onClick={() => { onModelChange(m); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors
                  ${m === selectedModel
                    ? 'bg-blue-600/20 text-blue-300'
                    : 'text-gray-200 hover:bg-gray-700'
                  }`}
              >
                {/* Check mark for active */}
                <span className={`w-3.5 h-3.5 shrink-0 ${m === selectedModel ? 'opacity-100' : 'opacity-0'}`}>
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 3.5l-7 7-3-3" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                <span className="truncate">{labelOf(m)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
