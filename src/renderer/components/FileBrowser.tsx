import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt?: number;
}

interface FileBrowserProps {
  terminalId: string | null;
  command?: string;
  username?: string;
  password?: string;
}

const joinPath = (base: string, name: string) => {
  if (!base || base === '/') {
    return `/${name}`;
  }
  return `${base}/${name}`;
};

const basename = (targetPath: string) => {
  const parts = targetPath.split('/').filter(Boolean);
  return parts.length === 0 ? '/' : parts[parts.length - 1];
};

const dirname = (targetPath: string) => {
  if (targetPath === '/') return '/';
  const parts = targetPath.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
};

const FileBrowser: React.FC<FileBrowserProps> = ({ terminalId, command, password }) => {
  const [connected, setConnected] = useState(false);
  const [currentDirectory, setCurrentDirectory] = useState('/');
  const [entriesByPath, setEntriesByPath] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [followTerminal, setFollowTerminal] = useState(true);

  const connectFileSession = useCallback(async (effectiveCommand: string, password?: string) => {
    if (!terminalId || !effectiveCommand) {
      return { connected: false, error: 'Missing terminal context' } as const;
    }
    return window.copilot.fileConnect({ terminalId, command: effectiveCommand, password });
  }, [terminalId]);

  const getEffectiveSshCommand = useCallback(async () => {
    const rawCommand = command?.trim() || '';
    if (!terminalId) {
      return '';
    }

    if (rawCommand.startsWith('ssh ')) {
      return rawCommand;
    }

    const context = await window.copilot.terminalQuerySshContext({ terminalId });
    if (!context.success || !context.connected || !context.host) {
      return rawCommand;
    }

    const login = context.username ? `${context.username}@${context.host}` : context.host;
    const portPart = context.port && context.port !== 22 ? ` -p ${context.port}` : '';
    return `ssh ${login}${portPart}`;
  }, [command, terminalId]);

  const loadDirectory = useCallback(async (path: string, updateCurrent = false) => {
    if (!terminalId) return;

    setLoadingPath(path);
    setError(null);
    const result = await window.copilot.fileList({ terminalId, path });
    setLoadingPath(null);

    if (!result.success) {
      setError(result.error || 'Failed to load directory');
      return;
    }

    const resolvedPath = result.path || path;
    const entries = result.entries || [];
    setEntriesByPath((prev) => ({ ...prev, [resolvedPath]: entries }));

    if (updateCurrent) {
      setCurrentDirectory(resolvedPath);
      setPathInput(resolvedPath);
    }
  }, [terminalId]);

  const syncFromTerminal = useCallback(async (force = false) => {
    if (!terminalId) return;

    setBusy(true);
    setError(null);

    const cwdResult = await window.copilot.terminalQueryCwd({ terminalId });
    if (cwdResult.success && cwdResult.cwd) {
      const setResult = await window.copilot.fileSetDirectory({ terminalId, directory: cwdResult.cwd });
      if (setResult.success && setResult.currentDirectory) {
        if (force || setResult.currentDirectory !== currentDirectory) {
          setCurrentDirectory(setResult.currentDirectory);
          await loadDirectory(setResult.currentDirectory, true);
        }
        setBusy(false);
        return;
      }
    }

    const fallback = await window.copilot.fileGetDirectory({ terminalId });
    if (!fallback.success || !fallback.currentDirectory) {
      setError(cwdResult.error || fallback.error || 'Failed to sync directory from terminal');
      setBusy(false);
      return;
    }

    if (force || fallback.currentDirectory !== currentDirectory) {
      setCurrentDirectory(fallback.currentDirectory);
      await loadDirectory(fallback.currentDirectory, true);
    }
    setBusy(false);
  }, [currentDirectory, loadDirectory, terminalId]);

  useEffect(() => {
    let disposed = false;

    const connect = async () => {
      setConnected(false);
      setEntriesByPath({});
      setExpanded({});
      setCurrentDirectory('/');
      setError(null);

      if (!terminalId || !command) {
        return;
      }

      const effectiveCommand = await getEffectiveSshCommand();
      let result = await connectFileSession(effectiveCommand, password || undefined);

      if (!result.connected && result.authRequired && !password) {
        const password = window.prompt('SSH password for file explorer:') || '';
        if (password) {
          result = await connectFileSession(effectiveCommand, password);
        }
      }

      if (disposed) return;

      if (!result.connected || !result.currentDirectory) {
        setConnected(false);
        setError(result.error || 'File explorer requires an active SSH shell in this terminal');
        return;
      }

      setConnected(true);
      setCurrentDirectory(result.currentDirectory);
      setPathInput(result.currentDirectory);
      setExpanded({ [result.currentDirectory]: true });
      await loadDirectory(result.currentDirectory, true);
      await syncFromTerminal(true);
    };

    connect();

    return () => {
      disposed = true;
    };
  }, [command, connectFileSession, getEffectiveSshCommand, loadDirectory, password, syncFromTerminal, terminalId]);

  useEffect(() => {
    if (!connected || !terminalId || !followTerminal) return;
    
    // Use a ref to track if the component is mounted
    let isActive = true;
    
    const sync = async () => {
      if (!isActive) return;
      
      const cwdResult = await window.copilot.terminalQueryCwd({ terminalId });
      if (!isActive) return;
      
      if (cwdResult.success && cwdResult.cwd) {
        const setResult = await window.copilot.fileSetDirectory({ terminalId, directory: cwdResult.cwd });
        if (!isActive) return;
        
        if (setResult.success && setResult.currentDirectory) {
          setCurrentDirectory((prev) => {
            if (setResult.currentDirectory !== prev) {
              loadDirectory(setResult.currentDirectory, true);
            }
            return setResult.currentDirectory;
          });
          return;
        }
      }

      const fallback = await window.copilot.fileGetDirectory({ terminalId });
      if (!isActive) return;
      
      if (fallback.success && fallback.currentDirectory) {
        setCurrentDirectory((prev) => {
          if (fallback.currentDirectory !== prev) {
            loadDirectory(fallback.currentDirectory, true);
          }
          return fallback.currentDirectory;
        });
      }
    };

    const interval = setInterval(sync, 2500);
    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, [connected, followTerminal, terminalId, loadDirectory]);

  const currentEntries = useMemo(() => entriesByPath[currentDirectory] || [], [currentDirectory, entriesByPath]);

  const toggleDirectory = async (targetPath: string) => {
    setExpanded((prev) => ({ ...prev, [targetPath]: !prev[targetPath] }));
    if (!entriesByPath[targetPath]) {
      await loadDirectory(targetPath, false);
    }
  };

  const handleOpenFile = async (targetPath: string) => {
    if (!terminalId) return;

    setBusy(true);
    setError(null);
    const result = await window.copilot.fileRead({ terminalId, path: targetPath });
    setBusy(false);

    if (!result.success || typeof result.content !== 'string') {
      setError(result.error || 'Failed to open file');
      return;
    }

    setEditorFilePath(result.path || targetPath);
    setEditorContent(result.content);
    setEditorDirty(false);
  };

  const handleSaveFile = async () => {
    if (!terminalId || !editorFilePath) return;

    setBusy(true);
    const result = await window.copilot.fileWrite({ terminalId, path: editorFilePath, content: editorContent });
    setBusy(false);

    if (!result.success) {
      setError(result.error || 'Failed to save file');
      return;
    }

    setEditorDirty(false);
    await loadDirectory(dirname(editorFilePath), false);
  };

  const handleDeleteEntry = async (entry: FileEntry) => {
    if (!terminalId) return;
    const confirmed = window.confirm(`Delete ${entry.isDirectory ? 'folder' : 'file'} "${entry.name}"?`);
    if (!confirmed) return;

    setBusy(true);
    const result = await window.copilot.fileDelete({ terminalId, path: entry.path });
    setBusy(false);

    if (!result.success) {
      setError(result.error || `Failed to delete ${entry.name}`);
      return;
    }

    await loadDirectory(currentDirectory, true);
  };

  const handleRenameEntry = async (entry: FileEntry) => {
    if (!terminalId) return;
    const nextName = window.prompt('Rename to:', entry.name)?.trim();
    if (!nextName || nextName === entry.name) return;

    const nextPath = joinPath(dirname(entry.path), nextName);
    setBusy(true);
    const result = await window.copilot.fileRename({ terminalId, oldPath: entry.path, newPath: nextPath });
    setBusy(false);

    if (!result.success) {
      setError(result.error || `Failed to rename ${entry.name}`);
      return;
    }

    await loadDirectory(currentDirectory, true);
  };

  const handleCreateFile = async () => {
    if (!terminalId) return;

    const fileName = window.prompt('New file name:')?.trim();
    if (!fileName) return;

    const fullPath = joinPath(currentDirectory, fileName);
    setBusy(true);
    const result = await window.copilot.fileWrite({ terminalId, path: fullPath, content: '' });
    setBusy(false);

    if (!result.success) {
      setError(result.error || 'Failed to create file');
      return;
    }

    await loadDirectory(currentDirectory, true);
  };

  const handleCreateFolder = async () => {
    if (!terminalId) return;

    const folderName = window.prompt('New folder name:')?.trim();
    if (!folderName) return;

    const fullPath = joinPath(currentDirectory, folderName);
    setBusy(true);
    const result = await window.copilot.fileMkdir({ terminalId, path: fullPath });
    setBusy(false);

    if (!result.success) {
      setError(result.error || 'Failed to create folder');
      return;
    }

    await loadDirectory(currentDirectory, true);
  };

  const renderTree = (path: string, depth = 0): React.ReactNode => {
    const entries = entriesByPath[path] || [];

    return entries.map((entry) => {
      const isExpanded = !!expanded[entry.path];
      return (
        <div key={entry.path}>
          <div
            className="group flex items-center justify-between px-2 py-1 hover:bg-gray-800 rounded text-xs"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <button
              className="flex items-center gap-1 min-w-0 flex-1 text-left"
              onClick={() => (entry.isDirectory ? toggleDirectory(entry.path) : handleOpenFile(entry.path))}
            >
              <span className="text-gray-400 w-3 inline-block">{entry.isDirectory ? (isExpanded ? '▾' : '▸') : '•'}</span>
              <span className="truncate text-gray-200">{entry.name}</span>
            </button>
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
              <button
                className="px-1 text-gray-400 hover:text-gray-200"
                onClick={() => handleRenameEntry(entry)}
                title="Rename"
              >
                R
              </button>
              <button
                className="px-1 text-gray-400 hover:text-red-400"
                onClick={() => handleDeleteEntry(entry)}
                title="Delete"
              >
                D
              </button>
            </div>
          </div>

          {entry.isDirectory && isExpanded && (
            <div>
              {loadingPath === entry.path && (
                <div className="text-[11px] text-gray-500 px-2" style={{ paddingLeft: `${24 + depth * 14}px` }}>
                  Loading...
                </div>
              )}
              {renderTree(entry.path, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  if (!terminalId) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-gray-500 px-3 text-center">
        Open a terminal to browse remote files.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-900 border-r border-gray-700 overflow-auto">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-gray-200">Remote Explorer</span>
          <div className="flex items-center gap-1">
            <button
              className={`text-[11px] px-2 py-1 rounded ${followTerminal ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}
              onClick={() => setFollowTerminal((prev) => !prev)}
              title="Follow terminal directory"
            >
              {followTerminal ? 'Follow: On' : 'Follow: Off'}
            </button>
            <button className="text-[11px] px-2 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600" onClick={handleCreateFile}>+F</button>
            <button className="text-[11px] px-2 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600" onClick={handleCreateFolder}>+D</button>
            <button className="text-[11px] px-2 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600" onClick={syncFromTerminal}>Sync</button>
          </div>
        </div>
        <div className="flex items-center gap-1 mt-1">
          <input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const nextPath = pathInput.trim();
                if (!nextPath) return;
                window.copilot.fileSetDirectory({ terminalId: terminalId || '', directory: nextPath })
                  .then((result) => {
                    if (result.success && result.currentDirectory) {
                      setCurrentDirectory(result.currentDirectory);
                      loadDirectory(result.currentDirectory, true);
                    } else {
                      setError(result.error || 'Failed to change directory');
                    }
                  })
                  .catch(() => setError('Failed to change directory'));
              }
            }}
            className="flex-1 text-[11px] bg-gray-900 text-gray-300 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            placeholder="/path/to/folder"
          />
          <button
            className="text-[11px] px-2 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600"
            onClick={() => {
              const nextPath = pathInput.trim();
              if (!nextPath || !terminalId) return;
              window.copilot.fileSetDirectory({ terminalId, directory: nextPath })
                .then((result) => {
                  if (result.success && result.currentDirectory) {
                    setCurrentDirectory(result.currentDirectory);
                    loadDirectory(result.currentDirectory, true);
                  } else {
                    setError(result.error || 'Failed to change directory');
                  }
                })
                .catch(() => setError('Failed to change directory'));
            }}
          >
            Go
          </button>
        </div>
        {!connected && !error && <div className="text-[11px] text-gray-500 mt-1">Connecting to SSH file session...</div>}
        {error && <div className="text-[11px] text-red-400 mt-1">{error}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-1 py-1">
        {loadingPath === currentDirectory && currentEntries.length === 0 ? (
          <div className="text-xs text-gray-500 px-2 py-2">Loading...</div>
        ) : currentEntries.length === 0 ? (
          <div className="text-xs text-gray-500 px-2 py-2">No files</div>
        ) : (
          <>
            {renderTree(currentDirectory)}
          </>
        )}
      </div>

      {editorFilePath && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg w-[70vw] h-[70vh] flex flex-col shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
              <div className="text-xs text-gray-300 truncate pr-3" title={editorFilePath}>{editorFilePath}</div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1 text-xs bg-gray-700 text-gray-200 rounded hover:bg-gray-600"
                  onClick={() => {
                    if (editorDirty && !window.confirm('Discard unsaved changes?')) return;
                    setEditorFilePath(null);
                    setEditorContent('');
                    setEditorDirty(false);
                  }}
                >
                  Close
                </button>
                <button
                  className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-60"
                  onClick={handleSaveFile}
                  disabled={!editorDirty || busy}
                >
                  Save
                </button>
              </div>
            </div>
            <textarea
              className="flex-1 w-full bg-gray-900 text-gray-100 text-xs font-mono p-3 resize-none outline-none"
              value={editorContent}
              onChange={(event) => {
                setEditorContent(event.target.value);
                setEditorDirty(true);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default FileBrowser;
