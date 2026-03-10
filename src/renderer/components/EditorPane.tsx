import React, { useRef, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';

interface EditorPaneProps {
  language?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  title?: string;
}

const EditorPane: React.FC<EditorPaneProps> = ({
  language = 'typescript',
  value = '',
  onChange,
  onSave,
  onCancel,
  title = 'Edit Code',
}) => {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    // Force layout recalculation
    setTimeout(() => editor.layout(), 100);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }
      if (e.key === 'Escape') {
        onCancel?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSave, onCancel]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-11/12 h-5/6 max-w-6xl flex flex-col border border-gray-700">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-850">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <div className="text-xs text-gray-400">Language: {language}</div>
        </div>

        {/* Editor Container */}
        <div className="flex-1 overflow-hidden bg-gray-800">
          <Editor
            height="100%"
            language={language}
            value={value}
            onChange={(newValue) => onChange?.(newValue || '')}
            theme="vs-dark"
            onMount={handleEditorMount}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              wordWrap: 'on',
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              tabSize: 2,
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
              },
            }}
          />
        </div>

        {/* Footer with Buttons */}
        <div className="px-6 py-4 border-t border-gray-700 flex gap-3 justify-end bg-gray-850">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm font-medium transition-colors"
          >
            Cancel (Esc)
          </button>
          <button
            onClick={onSave}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors"
          >
            Save (Ctrl+S)
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditorPane;
