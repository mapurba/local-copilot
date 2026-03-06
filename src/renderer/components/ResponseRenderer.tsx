import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

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
              const language = match ? match[1] : 'text';
              const isInline = !props.node?.parent?.tagName || props.node?.parent?.tagName !== 'pre';
              
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
                    {String(children).replace(/\n$/, '')}
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

  // Render JSON data
  return <JsonRenderer data={jsonData} />;
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
