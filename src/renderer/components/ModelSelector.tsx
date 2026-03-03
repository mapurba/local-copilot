import React, { useEffect, useRef, useState } from 'react';

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ selectedModel, onModelChange }) => {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const onModelChangeRef = useRef(onModelChange);
  onModelChangeRef.current = onModelChange;

  useEffect(() => {
    const fetchModels = async () => {
      try {
        setLoading(true);
        const list = await window.copilot.getModels();
        setModels(list);
        if (list.length > 0 && !selectedModel) {
          onModelChangeRef.current(list[0]);
        }
      } catch (err) {
        console.warn('[ModelSelector] Failed to fetch models, using fallback list:', err);
        // Use a more comprehensive fallback list
        setModels(['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'claude-3-opus', 'o1', 'o1-preview']);
      } finally {
        setLoading(false);
      }
    };
    
    fetchModels();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-400 whitespace-nowrap">Model:</label>
      {loading ? (
        <div className="text-xs text-gray-500">Loading...</div>
      ) : (
        <select
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          className="bg-gray-700 text-white text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 cursor-pointer"
        >
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
    </div>
  );
};

export default ModelSelector;
