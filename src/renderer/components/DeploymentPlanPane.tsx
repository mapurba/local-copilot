import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DeploymentPlan, ServiceNode } from '../deploymentTypes';
import ServiceDetailPanel from './ServiceDetailPanel';

interface DeploymentPlanPaneProps {
  plan: DeploymentPlan;
  onPlanUpdate: (plan: DeploymentPlan) => void;
  onDeployAll: () => void;
  onDeployService: (serviceId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  provisioning: '#f59e0b',
  installing: '#3b82f6',
  running: '#10b981',
  failed: '#ef4444',
  'health-check': '#8b5cf6',
  complete: '#22c55e',
};

const DeploymentPlanPane: React.FC<DeploymentPlanPaneProps> = ({
  plan,
  onPlanUpdate,
  onDeployAll,
  onDeployService,
}) => {
  const [activeView, setActiveView] = useState<'diagram' | 'editor' | 'markdown'>('diagram');
  const [mermaidSource, setMermaidSource] = useState(plan.mermaidDiagram);
  const [selectedService, setSelectedService] = useState<ServiceNode | null>(null);
  const [diagramSvg, setDiagramSvg] = useState<string>('');
  const diagramRef = useRef<HTMLDivElement>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(plan.vm_template_id);
  const [selectedTemplateName, setSelectedTemplateName] = useState<string | undefined>(plan.vm_template_name);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const templateDropdownRef = useRef<HTMLDivElement>(null);
  const templateSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render mermaid diagram
  const renderDiagram = useCallback(async (source: string) => {
    try {
      const mermaid = await import('mermaid');
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          // primaryColor: '#1e40af',
          // primaryTextColor: '#e5e7eb',
          // primaryBorderColor: '#3b82f6',
          // lineColor: '#6b7280',
          // secondaryColor: '#374151',
          // tertiaryColor: '#1f2937',
        },
      });
      const id = `mermaid-${Date.now()}`;
      const { svg } = await mermaid.default.render(id, source);
      setDiagramSvg(svg);
    } catch (err) {
      console.error('[DeploymentPane] Mermaid render error:', err);
      setDiagramSvg(`<div class="text-red-400 p-4">Diagram render error: ${err instanceof Error ? err.message : String(err)}</div>`);
    }
  }, []);

  useEffect(() => {
    setMermaidSource(plan.mermaidDiagram);
    renderDiagram(plan.mermaidDiagram);
    // keep selected template in sync with external plan updates
    setSelectedTemplateId(plan.vm_template_id);
    setSelectedTemplateName(plan.vm_template_name);
    setTemplateSearch(plan.vm_template_name ?? '');
  }, [plan.mermaidDiagram, renderDiagram]);

  // Close template dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node) &&
        templateInputRef.current && !templateInputRef.current.contains(e.target as Node)
      ) {
        setTemplateDropdownOpen(false);
        // Reset search text to current selection name if user blurred without picking
        setTemplateSearch(selectedTemplateName ?? '');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [selectedTemplateName]);

  useEffect(() => {
    // Initial load — fetch all templates (no filter)
    fetchTemplates('');
  }, []);

  const fetchTemplates = async (query: string) => {
    if (typeof window.copilot?.listTemplates !== 'function') return;
    setTemplateLoading(true);
    try {
      const res = await window.copilot.listTemplates(query);
      if (res && Array.isArray(res.templates)) {
        const arr = res.templates.map((t: any) => ({
          id: String(t.id || t.uuid || t.template_id),
          name: String(t.name || t.template_name || t.title || t.id),
        }));
        setTemplates(arr);
      }
    } catch {
      // ignore
    } finally {
      setTemplateLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedService) return;
    const latest = plan.services.find((s) => s.id === selectedService.id);
    if (latest) {
      setSelectedService(latest);
    } else {
      setSelectedService(null);
    }
  }, [plan.services, selectedService]);

  // Handle diagram click to select a service node
  const handleDiagramClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const nodeEl = target.closest('[id^="flowchart-"]') || target.closest('.node');
    if (nodeEl) {
      const nodeId = nodeEl.id?.replace('flowchart-', '').split('-')[0] || '';
      const service = plan.services.find(s => s.id === nodeId || s.name.toLowerCase().replace(/\s+/g, '-') === nodeId);
      if (service) {
        setSelectedService(service);
      }
    }
  };

  // Apply mermaid source edits
  const handleApplyEdits = () => {
    const updatedPlan: DeploymentPlan = {
      ...plan,
      mermaidDiagram: mermaidSource,
      updatedAt: new Date().toISOString(),
    };
    onPlanUpdate(updatedPlan);
    renderDiagram(mermaidSource);
    setActiveView('diagram');
  };

  const handleSaveServiceRunbook = (serviceId: string, runbook: string) => {
    const updatedPlan: DeploymentPlan = {
      ...plan,
      updatedAt: new Date().toISOString(),
      services: plan.services.map((service) =>
        service.id === serviceId ? { ...service, runbook } : service
      ),
    };
    onPlanUpdate(updatedPlan);
  };

  // Get status color for service badges
  const getStatusBadge = (status: string) => {
    const color = STATUS_COLORS[status] || '#6b7280';
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
        style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}
      >
        {status}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Top toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-200">{plan.name}</h2>
          {getStatusBadge(plan.status)}
        </div>
        <div className="flex items-center gap-2">
            {/* Global template selector — searchable combobox */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-300 whitespace-nowrap">Global template</label>
              <div className="relative">
                <input
                  ref={templateInputRef}
                  type="text"
                  value={templateSearch}
                  placeholder={templateLoading ? 'Loading…' : 'Search templates…'}
                  onFocus={() => setTemplateDropdownOpen(true)}
                  onChange={(e) => {
                    const q = e.target.value;
                    setTemplateSearch(q);
                    setTemplateDropdownOpen(true);
                    // debounce server-side search by 350 ms
                    if (templateSearchTimer.current) clearTimeout(templateSearchTimer.current);
                    templateSearchTimer.current = setTimeout(() => fetchTemplates(q), 350);
                  }}
                  className="text-xs bg-gray-700 text-gray-200 px-2 py-1 rounded border border-gray-600 w-52 focus:outline-none focus:border-blue-500"
                />
                {templateDropdownOpen && (
                  <div
                    ref={templateDropdownRef}
                    className="absolute z-50 top-full left-0 mt-1 w-72 max-h-64 overflow-y-auto bg-gray-800 border border-gray-600 rounded shadow-lg"
                  >
                    {/* Clear option */}
                    <div
                      className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 cursor-pointer"
                      onMouseDown={() => {
                        setSelectedTemplateId(undefined);
                        setSelectedTemplateName(undefined);
                        setTemplateSearch('');
                        setTemplateDropdownOpen(false);
                        // Clear the global template and remove it from services that inherited it
                        const clearedServices = plan.services.map((svc) => {
                          const svcId = (svc as any).vm_template_id?.trim();
                          if (!svcId || svcId === selectedTemplateId) {
                            return { ...svc, vm_template_id: '', vm_template_name: undefined };
                          }
                          return svc;
                        });
                        onPlanUpdate({ ...plan, vm_template_id: undefined, vm_template_name: undefined, services: clearedServices, updatedAt: new Date().toISOString() });
                      }}
                    >
                      — none —
                    </div>
                    {templateLoading && (
                      <div className="px-3 py-2 text-xs text-gray-400">Searching…</div>
                    )}
                    {!templateLoading && templates.map((t) => (
                        <div
                          key={t.id}
                          onMouseDown={() => {
                            setSelectedTemplateId(t.id);
                            setSelectedTemplateName(t.name);
                            setTemplateSearch(t.name);
                            setTemplateDropdownOpen(false);
                            // Propagate global template to all services that have no own override
                            const updatedServices = plan.services.map((svc) => {
                              if ((svc as any).vm_template_id?.trim()) return svc;
                              return { ...svc, vm_template_id: t.id, vm_template_name: t.name };
                            });
                            onPlanUpdate({ ...plan, vm_template_id: t.id, vm_template_name: t.name, services: updatedServices, updatedAt: new Date().toISOString() });
                          }}
                          className={`px-3 py-1.5 text-xs cursor-pointer truncate ${t.id === selectedTemplateId ? 'bg-blue-700 text-white' : 'text-gray-200 hover:bg-gray-700'}`}
                          title={t.name}
                        >
                          {t.name}
                        </div>
                      ))}
                    {!templateLoading && templates.length === 0 && (
                      <div className="px-3 py-2 text-xs text-gray-500">No templates match</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          {/* View toggle */}
          <div className="flex bg-gray-700 rounded overflow-hidden">
            <button
              onClick={() => setActiveView('diagram')}
              className={`px-3 py-1 text-xs ${activeView === 'diagram' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}
            >
              Diagram
            </button>
            <button
              onClick={() => setActiveView('editor')}
              className={`px-3 py-1 text-xs ${activeView === 'editor' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}
            >
              Editor
            </button>
            <button
              onClick={() => setActiveView('markdown')}
              className={`px-3 py-1 text-xs ${activeView === 'markdown' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}
            >
              Summary
            </button>
          </div>
          {/* Deploy controls */}
          <button
            onClick={onDeployAll}
            disabled={plan.status === 'deploying' || plan.status === 'complete'}
            className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Deploy All
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Main content area */}
        <div className="flex-1 min-w-0 overflow-auto">
          {activeView === 'diagram' && (
            <div className="p-4 h-full overflow-auto">
              <div
                ref={diagramRef}
                className="mermaid-container flex justify-center"
                onClick={handleDiagramClick}
                dangerouslySetInnerHTML={{ __html: diagramSvg }}
              />
              {/* Service list below diagram */}
              <div className="mt-6 border-t border-gray-700 pt-4">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Services ({plan.services.length})</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {plan.services.map(service => (
                    <div
                      key={service.id}
                      onClick={() => setSelectedService(service)}
                      className="p-3 bg-gray-800 border border-gray-700 rounded-lg cursor-pointer hover:border-blue-500 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-200">{service.name}</span>
                        {getStatusBadge(service.status)}
                      </div>
                      <div className="text-xs text-gray-400">
                        VM: {service.vmName} {service.ip && `• IP: ${service.ip}`}
                        <div className="text-xs text-gray-400 mt-1">Template: <span className="text-gray-200">{service.templateName || plan.vm_template_name || '—'}</span></div>
                      </div>
                      {service.dependsOn.length > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          Depends on: {service.dependsOn.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeView === 'editor' && (
            <div className="flex flex-col h-full p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">Edit Mermaid diagram source</span>
                <button
                  onClick={handleApplyEdits}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
                >
                  Apply & Preview
                </button>
              </div>
              <textarea
                value={mermaidSource}
                onChange={(e) => setMermaidSource(e.target.value)}
                className="flex-1 w-full bg-gray-800 text-gray-100 font-mono text-sm p-4 rounded border border-gray-600 focus:border-blue-500 focus:outline-none resize-none"
                spellCheck={false}
              />
            </div>
          )}

          {activeView === 'markdown' && (
            <div className="p-4 overflow-auto prose prose-invert max-w-none">
              <article className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {plan.markdownSummary || '_No summary available._'}
                </ReactMarkdown>
              </article>
            </div>
          )}
        </div>

        {/* Service detail side panel */}
        {selectedService && (
          <ServiceDetailPanel
            service={selectedService}
            onClose={() => setSelectedService(null)}
            onDeploy={() => {
              onDeployService(selectedService.id);
            }}
            onRunbookSave={(serviceId, runbook) => handleSaveServiceRunbook(serviceId, runbook)}
            planStatus={plan.status}
            planVmTemplateName={plan.vm_template_name}
            planVmTemplateId={plan.vm_template_id}
          />
        )}
      </div>
    </div>
  );
};

export default DeploymentPlanPane;
