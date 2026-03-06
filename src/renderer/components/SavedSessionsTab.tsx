import React from 'react';

interface SavedSession {
  id: string;
  label: string;
  command: string;
  host?: string;
  username?: string;
  port?: number;
  password?: string;
  vmName?: string;
  ip?: string;
  source?: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface SavedSessionsTabProps {
  sessions: SavedSession[];
  onOpen: (session: SavedSession) => void;
  onEdit: (session: SavedSession) => void;
  onDelete: (sessionId: string) => void;
  onRefresh: () => void;
}

const SavedSessionsTab: React.FC<SavedSessionsTabProps> = ({
  sessions,
  onOpen,
  onEdit,
  onDelete,
  onRefresh,
}) => {
  React.useEffect(() => {
    onRefresh();
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 text-center">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="mx-auto mb-2 text-gray-500"
        >
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          <polyline points="17 8 17 14" />
          <polyline points="7 8 7 14" />
          <polyline points="7 8 17 8" />
          <polyline points="7 14 17 14" />
        </svg>
        <p className="text-gray-500 text-sm mb-3">No saved sessions yet</p>
        <p className="text-gray-600 text-xs">
          Create a new terminal session and save it for quick access
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto">
      <div className="space-y-1 p-2">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="group bg-gray-700/30 hover:bg-gray-700/50 rounded p-2 transition-colors"
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-200 truncate">
                  {session.label}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {session.command}
                </div>
                {session.username && (
                  <div className="text-[10px] text-gray-600">
                    {session.username}
                    {session.host && `@${session.host}`}
                    {session.port && `:${session.port}`}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onOpen(session)}
                className="flex-1 px-2 py-1 text-[10px] bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                title="Open session"
              >
                Open
              </button>
              <button
                onClick={() => onEdit(session)}
                className="px-2 py-1 text-[10px] bg-gray-600 hover:bg-yellow-600 text-white rounded transition-colors"
                title="Edit session"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(session.id)}
                className="px-2 py-1 text-[10px] bg-gray-600 hover:bg-red-600 text-white rounded transition-colors"
                title="Delete session"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SavedSessionsTab;
