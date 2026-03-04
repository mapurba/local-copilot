import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import ModelSelector from './ModelSelector';
import ResponseRenderer from './ResponseRenderer';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  type?: 'text' | 'tool-call' | 'tool-result';
}

interface VmCreateFormData {
  vm_name: string;
  template_id: string;
  template_name?: string;
  network_name?: string;
  ip_address?: string;
  gateway?: string;
  dns_servers?: string;
  power_on: boolean;
  storage_profile_id?: string;
  compute_policy_id?: string;
  setup_ilm?: boolean;
  ilm_version?: string;
}

const ChatPane: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('gpt-4');
  const [isStreaming, setIsStreaming] = useState(false);
  const [useTools, setUseTools] = useState(true);
  const [pendingForm, setPendingForm] = useState<VmCreateFormData | null>(null);
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

  const handleDeployVm = async (formData: VmCreateFormData) => {
    try {
      // In a real scenario, this would call create_vm_confirmed via the chat API
      console.log('Deploying VM:', formData);
      setPendingForm(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `VM creation confirmed! Deploying **${formData.vm_name}**...`,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deployment failed';
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${message}` }]);
    }
  };

  const handleCancelReview = () => {
    setPendingForm(null);
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: 'VM creation cancelled.' },
    ]);
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
        {messages.length === 0 && !pendingForm && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm space-y-2">
            <span className="text-4xl">🤖</span>
            <p>Ask about your VMs or create new ones</p>
            {useTools && (
              <p className="text-xs text-gray-400">
                💡 Tools enabled: Try "list my VMs" or "create a new VM"
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
                <div>
                  <ResponseRenderer content={msg.content} />
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

        {/* VM Review Form */}
        {pendingForm && (
          <div className="flex justify-start">
            <div className="w-full max-w-2xl bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
              <div className="bg-gray-750 px-6 py-4 border-b border-gray-700 flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="font-semibold text-gray-200">Review &amp; Deploy VM</span>
              </div>

              <div className="p-6 space-y-4 max-h-96 overflow-y-auto">
                {[
                  ['vm_name', 'VM Name'],
                  ['template_id', 'Template ID'],
                  ['network_name', 'Network'],
                  ['ip_address', 'IP Address'],
                  ['gateway', 'Gateway'],
                  ['dns_servers', 'DNS Servers'],
                  ['power_on', 'Power On'],
                  ['storage_profile_id', 'Storage Profile'],
                  ['compute_policy_id', 'Compute Policy'],
                  ['setup_ilm', 'Setup ILM'],
                  ['ilm_version', 'ILM Version'],
                ].map(([key, label]) => (
                  <div key={key} className="grid grid-cols-3 gap-4 items-center">
                    <label className="text-xs font-medium text-gray-400">{label}</label>
                    <div className="col-span-2">
                      {key === 'power_on' || key === 'setup_ilm' ? (
                        <input
                          type="text"
                          value={String(pendingForm[key as keyof VmCreateFormData])}
                          readOnly
                          className="w-full bg-gray-700 text-gray-300 text-xs rounded px-2 py-1.5 border border-gray-600"
                        />
                      ) : (
                        <input
                          type="text"
                          value={String(pendingForm[key as keyof VmCreateFormData] || '')}
                          onChange={(e) => {
                            setPendingForm((prev) =>
                              prev ? { ...prev, [key]: e.target.value } : null
                            );
                          }}
                          className="w-full bg-gray-700 text-gray-100 text-xs rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-gray-750 px-6 py-4 border-t border-gray-700 flex gap-3 justify-end">
                <button
                  onClick={handleCancelReview}
                  className="px-4 py-2 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeployVm(pendingForm)}
                  className="px-4 py-2 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  Deploy VM
                </button>
              </div>
            </div>
          </div>
        )}

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
