import React, { useState, useRef, useEffect } from 'react';

interface ResizablePanelsProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initialLeftWidth?: number; // pixels
  minLeftWidth?: number;
  minRightWidth?: number;
}

const ResizablePanels: React.FC<ResizablePanelsProps> = ({
  left,
  right,
  initialLeftWidth = 320,
  minLeftWidth = 200,
  minRightWidth = 300,
}) => {
  const [leftWidth, setLeftWidth] = useState(initialLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const container = containerRef.current;
      const containerRect = container.getBoundingClientRect();
      const newLeftWidth = e.clientX - containerRect.left;

      // Apply constraints
      const maxLeftWidth = container.clientWidth - minRightWidth;
      const constrainedWidth = Math.max(
        minLeftWidth,
        Math.min(newLeftWidth, maxLeftWidth)
      );

      setLeftWidth(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minLeftWidth, minRightWidth]);

  return (
    <div ref={containerRef} className="flex flex-1 h-full w-full min-h-0 overflow-hidden">
      {/* Left Panel */}
      <div style={{ width: `${leftWidth}px` }} className="flex flex-col min-h-0 flex-shrink-0 overflow-hidden">
        {left}
      </div>

      {/* Resize Handle */}
      <div
        onMouseDown={() => setIsDragging(true)}
        className={`w-1 bg-gray-700 hover:bg-blue-500 transition-colors cursor-col-resize select-none ${
          isDragging ? 'bg-blue-500' : ''
        }`}
      />

      {/* Right Panel */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {right}
      </div>
    </div>
  );
};

export default ResizablePanels;
