import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  title: string;
  content: string;
}

const DocPreviewPane: React.FC<Props> = ({ title, content }) => (
  <div className="flex flex-col h-full overflow-hidden bg-gray-900">
    {/* Header */}
    <div className="px-5 py-2.5 border-b border-gray-700 bg-gray-800 flex-shrink-0">
      <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Document Preview</p>
      <p className="text-sm font-semibold text-gray-100 truncate mt-0.5">{title}</p>
    </div>

    {/* Markdown body */}
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <article className="prose prose-invert prose-sm max-w-3xl">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    </div>
  </div>
);

export default DocPreviewPane;
