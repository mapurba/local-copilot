import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

// ─── JSON summary + accordion ───────────────────────────────────────────────
type SummaryStatus = 'success' | 'error' | 'denied' | 'info' | 'warning';

const STATUS_DOT: Record<SummaryStatus, { dot: string; titleColor: string; bg: string; border: string }> = {
  success: { dot: '#22c55e', titleColor: '#15803d', bg: 'rgba(22,163,74,0.07)',  border: 'rgba(22,163,74,0.20)' },
  error:   { dot: '#ef4444', titleColor: '#b91c1c', bg: 'rgba(239,68,68,0.07)',  border: 'rgba(239,68,68,0.22)' },
  denied:  { dot: '#f59e0b', titleColor: '#b45309', bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.22)' },
  warning: { dot: '#f59e0b', titleColor: '#b45309', bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.22)' },
  info:    { dot: '#3b82f6', titleColor: '#1d4ed8', bg: 'rgba(59,130,246,0.07)', border: 'rgba(59,130,246,0.20)' },
};

function summariseJson(raw: string): { status: SummaryStatus; title: string; detail?: string } {
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw) as Record<string, unknown>; } catch { return { status: 'info', title: 'Tool response' }; }

  if (d.denied === true)
    return { status: 'denied', title: 'Execution denied', detail: d.reason ? String(d.reason) : undefined };
  if (d.cancelled === true)
    return { status: 'denied', title: 'Cancelled', detail: d.message ? String(d.message) : undefined };
  if (d.success === false)
    return { status: 'error', title: 'Operation failed', detail: d.error ? String(d.error) : undefined };
  if (d.success === true)
    return { status: 'success', title: 'Completed successfully', detail: d.message ? String(d.message) : undefined };

  // SSH connect
  if (d.sessionId && typeof d.sessionId === 'string') {
    const host = d.host ? String(d.host) : '';
    const user = d.username ? String(d.username) : '';
    const msg  = d.message ? String(d.message) : '';
    const detail = msg || (host && user ? `${user}@${host}` : host || undefined);
    return { status: 'success', title: 'SSH connected', detail };
  }

  // SSH command
  if ('stdout' in d || 'exitCode' in d) {
    const code = d.exitCode as number | undefined;
    const out  = String(d.stdout ?? d.output ?? '').trim();
    const detail = out.length > 100 ? out.slice(0, 100) + '…' : out || undefined;
    if (code !== undefined && code !== 0)
      return { status: 'warning', title: `Command exited with code ${code}`, detail };
    return { status: 'success', title: 'Command executed', detail };
  }

  // List results
  const LIST: Record<string, string> = { vms:'VM', tasks:'task', templates:'template', snapshots:'snapshot', vapps:'vApp', items:'item', results:'result', sessions:'session' };
  for (const [key, label] of Object.entries(LIST)) {
    if (Array.isArray(d[key])) {
      const count = d.count !== undefined ? Number(d.count) : (d[key] as unknown[]).length;
      return { status: 'info', title: `Found ${count} ${label}${count !== 1 ? 's' : ''}` };
    }
  }
  if (typeof d.count === 'number')
    return { status: 'info', title: `${d.count} result${d.count !== 1 ? 's' : ''}` };
  if ('powered_on' in d) {
    const name = d.name ? `"${d.name}"` : 'VM';
    return { status: 'info', title: `${name} is ${d.powered_on ? 'powered on' : 'powered off'}` };
  }
  if (typeof d.message === 'string')
    return { status: 'info', title: d.message.slice(0, 120) };
  return { status: 'info', title: 'Tool response received' };
}

const JsonAccordion: React.FC<{ raw: string }> = ({ raw }) => {
  const [open, setOpen] = useState(false);
  const s = summariseJson(raw);
  const meta = STATUS_DOT[s.status];

  return (
    <div style={{ margin: '6px 0' }}>
      {/* Summary row */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '9px',
        padding: '8px 12px', borderRadius: '6px',
        background: meta.bg, border: `1px solid ${meta.border}`,
        borderLeft: `3px solid ${meta.dot}`,
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: meta.dot, flexShrink: 0, marginTop: 5 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: meta.titleColor, lineHeight: 1.4 }}>{s.title}</div>
          {s.detail && (
            <div style={{ fontSize: '12px', marginTop: '2px', color: meta.titleColor, opacity: 0.75, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {s.detail}
            </div>
          )}
        </div>
      </div>

      {/* Raw accordion */}
      <button onClick={() => setOpen(v => !v)} style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '3px 4px', fontSize: '11px', opacity: 0.4,
        color: 'inherit', fontFamily: 'inherit', marginTop: '2px',
      }}>
        <svg width="7" height="7" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.13s' }}>
          <path d="M3 1l4 4-4 4V1z" />
        </svg>
        {open ? 'Hide' : 'Raw'} response
      </button>

      {open && (
        <div className="rounded-lg overflow-hidden" style={{ marginTop: '4px' }}>
          <SyntaxHighlighter language="json" style={oneDark} className="!bg-gray-900 !text-sm">
            {raw}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
interface ResponseRendererProps {
  content: string;
}

const ResponseRenderer: React.FC<ResponseRendererProps> = ({ content }) => {
  // Try to parse as JSON
  const parseAnswer = (): unknown => {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  };

  const jsonData = parseAnswer();

  // If not JSON, render as markdown
  if (!jsonData) {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={{
            // Code block with syntax highlighting
            code: ({ children, className, ...props }) => {
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : null;
              const raw = String(children).replace(/\n$/, '');

              // JSON blocks — intercept BEFORE the inline check so they are
              // never accidentally rendered as inline code snippets.
              if (language === 'json') {
                return <JsonAccordion raw={raw} />;
              }

              // Inline code (no language class detected)
              const isInline = !language || (!props.node?.parent?.tagName ||
                props.node?.parent?.tagName !== 'pre');
              if (isInline) {
                return (
                  <code className="bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono text-green-400">
                    {children}
                  </code>
                );
              }

              return (
                <div className="rounded-lg overflow-hidden my-3">
                  <SyntaxHighlighter
                    language={language}
                    style={oneDark}
                    className="!bg-gray-900 !text-sm"
                    showLineNumbers
                  >
                    {raw}
                  </SyntaxHighlighter>
                </div>
              );
            },
            // Enhanced table styling
            table: ({ children }) => (
              <div className="overflow-x-auto my-3">
                <table className="border-collapse border border-gray-600 w-full text-xs">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-gray-700 font-semibold">{children}</thead>
            ),
            tbody: ({ children }) => (
              <tbody className="divide-y divide-gray-600">{children}</tbody>
            ),
            tr: ({ children }) => (
              <tr className="hover:bg-gray-700/30 transition-colors">{children}</tr>
            ),
            th: ({ children }) => (
              <th className="border border-gray-600 px-4 py-3 text-left text-blue-300">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-gray-600 px-4 py-2 text-gray-100">{children}</td>
            ),
            // Link styling
            a: ({ children, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                {children}
              </a>
            ),
            // List styling
            ul: ({ children }) => (
              <ul className="list-disc list-inside my-2 space-y-1 text-gray-100">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside my-2 space-y-1 text-gray-100">
                {children}
              </ol>
            ),
            // Blockquote styling
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-gray-600 pl-4 my-2 italic text-gray-300">
                {children}
              </blockquote>
            ),
            // Heading styling
            h1: ({ children }) => (
              <h1 className="text-2xl font-bold text-gray-100 mt-4 mb-2">{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="text-xl font-bold text-gray-100 mt-3 mb-2">{children}</h2>
            ),
            h3: ({ children }) => (
              <h3 className="text-lg font-bold text-gray-100 mt-2 mb-1">{children}</h3>
            ),
            // Paragraph styling
            p: ({ children }) => (
              <p className="text-gray-100 my-2">{children}</p>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  // Bare JSON message (no markdown fences) — still wrap in accordion
  return <JsonAccordion raw={content.trim()} />;
};

interface JsonRendererProps {
  data: unknown;
}

const JsonRenderer: React.FC<JsonRendererProps> = ({ data }) => {
  // Handle arrays
  if (Array.isArray(data)) {
    // If array of objects with consistent keys, render as table
    if (
      data.length > 0 &&
      data.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
    ) {
      return <ObjectArrayTable items={data as Record<string, unknown>[]} />;
    }

    // Otherwise render as list
    return (
      <div className="space-y-2">
        {data.map((item, idx) => (
          <div key={idx} className="bg-gray-800 rounded p-3 border-l-2 border-blue-500">
            <JsonRenderer data={item} />
          </div>
        ))}
      </div>
    );
  }

  // Handle objects
  if (typeof data === 'object' && data !== null) {
    return <ObjectCard obj={data as Record<string, unknown>} />;
  }

  // Handle primitives
  if (typeof data === 'string') {
    return <span className="text-gray-100">{data}</span>;
  }
  if (typeof data === 'number') {
    return <span className="text-amber-400">{data}</span>;
  }
  if (typeof data === 'boolean') {
    return <span className={data ? 'text-green-400' : 'text-red-400'}>{String(data)}</span>;
  }

  return <span className="text-gray-400">null</span>;
};

interface ObjectCardProps {
  obj: Record<string, unknown>;
}

const ObjectCard: React.FC<ObjectCardProps> = ({ obj }) => {
  return (
    <div className="bg-gray-800 rounded p-3 border border-gray-700 space-y-2">
      {Object.entries(obj).map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <span className="text-blue-400 font-semibold min-w-fit">{key}:</span>
          <div className="text-gray-300 flex-1">
            {typeof value === 'object' && value !== null ? (
              <div className="ml-2 border-l border-gray-600 pl-2">
                <JsonRenderer data={value} />
              </div>
            ) : (
              <JsonRenderer data={value} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

interface ObjectArrayTableProps {
  items: Record<string, unknown>[];
}

const ObjectArrayTable: React.FC<ObjectArrayTableProps> = ({ items }) => {
  if (items.length === 0) {
    return <p className="text-gray-400">No items to display</p>;
  }

  // Get all unique keys from all objects
  const allKeys = Array.from(
    new Set(items.flatMap((item) => Object.keys(item)))
  );

  // Filter complex types (objects, arrays) for table display
  const tableKeys = allKeys.filter((key) => {
    const value = items[0][key];
    return typeof value !== 'object' || value === null;
  });

  if (tableKeys.length === 0) {
    // If all values are complex, render as cards
    return (
      <div className="space-y-2">
        {items.map((item, idx) => (
          <ObjectCard key={idx} obj={item} />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse border border-gray-600 w-full text-xs">
        <thead className="bg-gray-700">
          <tr>
            {tableKeys.map((key) => (
              <th key={key} className="border border-gray-600 px-3 py-2 text-left font-semibold text-gray-200">
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, rowIdx) => (
            <tr key={rowIdx} className="hover:bg-gray-700/50">
              {tableKeys.map((key) => {
                const value = item[key];
                return (
                  <td
                    key={`${rowIdx}-${key}`}
                    className="border border-gray-600 px-3 py-2 text-gray-300 max-w-xs truncate"
                  >
                    {renderTableCell(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function renderTableCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-gray-500">-</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
        {String(value)}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="text-amber-400">{value}</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-gray-100">{value}</span>;
  }
  if (typeof value === 'object') {
    return <span className="text-gray-500 italic">{"[object]"}</span>;
  }
  return <span className="text-gray-400">{String(value)}</span>;
}

export default ResponseRenderer;
