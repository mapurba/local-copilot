import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import ModelSelector from './ModelSelector';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  type?: 'text' | 'tool-call' | 'tool-result';
}

const ChatPane: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  const [isStreaming, setIsStreaming] = useState(false);
  const [useTools, setUseTools] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    const unsubChunk = window.copilot.onChatStream((_event: unknown, chunk: string, type?: string) => {
      const messageType = (type as 'text' | 'tool-call' | 'tool-result' | undefined) || 'text';
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + chunk, type: messageType },
          ];
        }
        return [...prev, { role: 'assistant', content: chunk, streaming: true, type: messageType }];
      });
    });

    const unsubEnd = window.copilot.onChatEnd(() => {
      setIsStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.streaming) {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    });

    const unsubError = window.copilot.onChatError((_event: unknown, message: string) => {
      setIsStreaming(false);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${message}` },
      ]);
    });

    cleanupRef.current = [unsubChunk, unsubEnd, unsubError];
    return () => cleanupRef.current.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    const historyForApi = [...messages, userMsg]
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    if (useTools) {
      await window.copilot.sendChatMessageWithTools(selectedModel, historyForApi);
    } else {
      await window.copilot.sendChatMessage(selectedModel, historyForApi);
    }
  }, [input, isStreaming, messages, selectedModel, useTools]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const getMessageColor = (message: Message) => {
    if (message.role === 'user') {
      return 'bg-blue-600 text-white';
    }
    
    switch (message.type) {
      case 'tool-call':
        return 'bg-purple-700 text-purple-100';
      case 'tool-result':
        return 'bg-green-700 text-green-100';
      default:
        return 'bg-gray-700 text-gray-100';
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-gray-200">Copilot Chat</span>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 cursor-pointer">
            <input
              type="checkbox"
              checked={useTools}
              onChange={(e) => setUseTools(e.target.checked)}
              disabled={isStreaming}
              className="w-4 h-4"
            />
            <span>Enable Tools</span>
          </label>
          <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm space-y-2">
            <span className="text-4xl">🤖</span>
            <p>Ask Copilot anything about your code</p>
            {useTools && (
              <p className="text-xs text-gray-400">
                💡 Tools enabled: Try asking for calculations!
              </p>
            )}
          </div>
        )}
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-4 py-3 text-sm ${getMessageColor(msg)}`}
            >
              {msg.role === 'assistant' ? (
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                  {msg.streaming && (
                    <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse ml-1 align-text-bottom" />
                  )}
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="px-4 py-3 bg-gray-800 border-t border-gray-700">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Copilot... (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={3}
            className="flex-1 bg-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 border border-gray-600 placeholder-gray-500 disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={isStreaming || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors h-[4.5rem] flex items-center justify-center"
          >
            {isStreaming ? (
              <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              '↑ Send'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPane;
