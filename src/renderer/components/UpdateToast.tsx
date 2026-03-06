import React from 'react';

export interface UpdateToastProps {
  progress: number;
  visible: boolean;
}

const UpdateToast: React.FC<UpdateToastProps> = ({ progress, visible }) => {
  if (!visible) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white px-6 py-4 rounded-lg shadow-lg flex flex-col items-center min-w-[260px]">
      <div className="font-semibold mb-2">Downloading Update...</div>
      <div className="w-full bg-gray-700 rounded h-3 overflow-hidden mb-1">
        <div
          className="bg-blue-500 h-3 rounded transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="text-xs text-gray-300">{progress}%</div>
    </div>
  );
};

export default UpdateToast;
