import React, { createContext, useContext, useState, useCallback } from 'react';

interface MermaidEditorState {
  /** Mermaid source currently loaded in the editor (null = no diagram open) */
  editorSource: string | null;
  /** Which right-panel tab is active */
  activeTab: 'chat' | 'editor';
  /** Open the mermaid editor with the given source */
  openInEditor: (source: string) => void;
  /** Close the editor and return to chat */
  closeEditor: () => void;
  /** Switch tabs without changing editor content */
  setActiveTab: (tab: 'chat' | 'editor') => void;
}

const MermaidEditorContext = createContext<MermaidEditorState | null>(null);

export const MermaidEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [editorSource, setEditorSource] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'editor'>('chat');

  const openInEditor = useCallback((source: string) => {
    setEditorSource(source);
    setActiveTab('editor');
  }, []);

  const closeEditor = useCallback(() => {
    setActiveTab('chat');
    // Keep editorSource so user can switch back without losing content
  }, []);

  return (
    <MermaidEditorContext.Provider value={{ editorSource, activeTab, openInEditor, closeEditor, setActiveTab }}>
      {children}
    </MermaidEditorContext.Provider>
  );
};

export function useMermaidEditor(): MermaidEditorState {
  const ctx = useContext(MermaidEditorContext);
  if (!ctx) throw new Error('useMermaidEditor must be used within MermaidEditorProvider');
  return ctx;
}
