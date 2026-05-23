import React from 'react';
import MermaidRenderer from './MermaidRenderer';
import { useMermaidEditor } from './MermaidEditorContext';

const MermaidEditorPane: React.FC = () => {
  const { editorSource, closeEditor } = useMermaidEditor();

  if (!editorSource) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No diagram loaded. Generate or import a Mermaid diagram to begin editing.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 bg-gray-800">
        <span className="text-xs font-medium text-gray-300 flex-1">Mermaid Diagram Editor</span>
        <button
          onClick={() => navigator.clipboard.writeText(editorSource)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors border-none cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy Mermaid
        </button>
        <button
          onClick={closeEditor}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors border-none cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to Chat
        </button>
      </div>

      {/* Diagram view */}
      <div className="flex-1 overflow-auto p-6">
        <MermaidRenderer source={editorSource} className="bg-gray-800 rounded-lg border border-gray-700 p-4" />

        {/* Placeholder banner for future visual editor */}
        <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-lg border border-blue-500/20 bg-blue-500/5 text-xs text-blue-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            Visual editing (drag nodes, add connections, edit flow order) will be available in a future update.
            For now you can view and copy the generated diagram.
          </span>
        </div>
      </div>
    </div>
  );
};

export default MermaidEditorPane;
