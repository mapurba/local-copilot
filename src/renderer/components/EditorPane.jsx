import React, { useRef } from 'react';
import Editor from '@monaco-editor/react';

const EditorPane = () => {
  const editorRef = useRef(null);

  const handleEditorMount = (editor) => {
    editorRef.current = editor;
  };

  const defaultValue = `// Welcome to Local Copilot!
// Start coding here and use the chat pane on the right to ask questions.

function greet(name) {
  return \`Hello, \${name}! Welcome to Local Copilot.\`;
}

console.log(greet("Developer"));
`;

  return (
    <div className="flex-1 h-full">
      <Editor
        height="100%"
        defaultLanguage="javascript"
        defaultValue={defaultValue}
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
        }}
      />
    </div>
  );
};

export default EditorPane;
