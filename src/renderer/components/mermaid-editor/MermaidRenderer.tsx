import React, { useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';

let renderCounter = 0;

function detectTheme(): 'dark' | 'light' {
  return document.querySelector('.theme-light') ? 'light' : 'dark';
}

function initMermaid(theme: 'dark' | 'light') {
  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  });
}

interface MermaidRendererProps {
  source: string;
  className?: string;
}

const MermaidRenderer: React.FC<MermaidRendererProps> = ({ source, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSource, setShowSource] = useState(false);

  const render = useCallback(async () => {
    if (!containerRef.current || !source.trim()) return;

    setLoading(true);
    setError(null);

    const theme = detectTheme();
    initMermaid(theme);

    const id = `mermaid-${Date.now()}-${++renderCounter}`;

    try {
      const { svg } = await mermaid.render(id, source.trim());
      if (containerRef.current) {
        containerRef.current.innerHTML = svg;
        // Make the SVG responsive
        const svgEl = containerRef.current.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render diagram');
      // Clean up any orphaned render artifacts
      const orphan = document.getElementById(`d${id}`);
      orphan?.remove();
    } finally {
      setLoading(false);
    }
  }, [source]);

  // Render on mount and when source changes
  useEffect(() => {
    render();
  }, [render]);

  // Re-render when theme changes (observe root element class mutations)
  useEffect(() => {
    const root = document.querySelector('[class*="theme-"]');
    if (!root) return;

    let prevTheme = detectTheme();
    const observer = new MutationObserver(() => {
      const newTheme = detectTheme();
      if (newTheme !== prevTheme) {
        prevTheme = newTheme;
        render();
      }
    });

    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [render]);

  if (error) {
    return (
      <div className={`rounded-lg border border-red-500/30 bg-red-900/10 overflow-hidden ${className ?? ''}`}>
        <div className="flex items-center gap-2 px-3 py-2 text-red-400 text-xs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <span>Mermaid rendering failed: {error}</span>
        </div>
        <pre className="px-3 py-2 text-xs text-gray-400 overflow-x-auto bg-gray-900/50">{source}</pre>
      </div>
    );
  }

  return (
    <div className={className}>
      {loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-gray-400 text-xs">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Rendering diagram…
        </div>
      )}
      <div ref={containerRef} className={loading ? 'hidden' : ''} />

      {/* View Source toggle */}
      {!loading && (
        <>
          <button
            onClick={() => setShowSource(v => !v)}
            className="inline-flex items-center gap-1 mt-1 px-1 py-0.5 text-[11px] opacity-40 hover:opacity-70 transition-opacity bg-transparent border-none cursor-pointer"
            style={{ color: 'inherit', fontFamily: 'inherit' }}
          >
            <svg width="7" height="7" viewBox="0 0 10 10" fill="currentColor"
              style={{ transform: showSource ? 'rotate(90deg)' : 'none', transition: 'transform 0.13s' }}>
              <path d="M3 1l4 4-4 4V1z" />
            </svg>
            {showSource ? 'Hide' : 'View'} source
          </button>
          {showSource && (
            <pre className="mt-1 px-3 py-2 rounded text-xs text-gray-400 bg-gray-900/50 overflow-x-auto border border-gray-700">
              {source}
            </pre>
          )}
        </>
      )}
    </div>
  );
};

export default MermaidRenderer;
