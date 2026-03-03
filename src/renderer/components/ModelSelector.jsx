import React, { useEffect, useRef, useState } from 'react';

const ModelSelector = ({ selectedModel, onModelChange }) => {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const onModelChangeRef = useRef(onModelChange);
  onModelChangeRef.current = onModelChange;

  useEffect(() => {
    window.copilot.getModels().then((list) => {
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        onModelChangeRef.current(list[0]);
      }
    }).catch(() => {
      setModels(['gpt-4', 'gpt-4o', 'claude-3.5-sonnet']);
    }).finally(() => setLoading(false));
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
