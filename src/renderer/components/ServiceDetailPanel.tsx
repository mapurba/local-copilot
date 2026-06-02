import React, { useState } from 'react';
import type { ServiceNode } from '../deploymentTypes';

interface ServiceDetailPanelProps {
  service: ServiceNode;
  onClose: () => void;
  onDeploy: () => void;
  onRunbookSave: (serviceId: string, runbook: string) => void;
  planStatus: string;
  planVmTemplateName?: string;
  planVmTemplateId?: string;
}
const ServiceDetailPanel: React.FC<ServiceDetailPanelProps> = ({
  service,
  onClose,
  onDeploy,
  onRunbookSave,
  planStatus,
  planVmTemplateName,
  planVmTemplateId,
}) => {
  const [activeTab, setActiveTab] = useState<'details' | 'runbook' | 'logs'>('details');
  const [isEditingRunbook, setIsEditingRunbook] = useState(false);
  const [runbookDraft, setRunbookDraft] = useState(service.runbook || '#!/bin/bash\n');
  const [isDryRunning, setIsDryRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<{
    summary?: string;
    hasCriticalErrors?: boolean;
    issues?: Array<{ severity?: string; title?: string; detail?: string; lineHint?: string }>;
    changed?: boolean;
    autoHealApplied?: boolean;
    error?: string;
  } | null>(null);
  const [panelWidth, setPanelWidth] = useState(384);
  const resizeStateRef = React.useRef<{
    active: boolean;
    startX: number;
    startWidth: number;
  }>({ active: false, startX: 0, startWidth: 384 });

  const canDeploy = planStatus !== 'complete' && service.status === 'pending';

  React.useEffect(() => {
    setRunbookDraft(service.runbook || '#!/bin/bash\n');
    setIsEditingRunbook(false);
  }, [service.id, service.runbook]);

  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const st = resizeStateRef.current;
      if (!st.active) return;
      const deltaX = st.startX - e.clientX;
      const nextWidth = Math.min(900, Math.max(320, st.startWidth + deltaX));
      setPanelWidth(nextWidth);
    };

    const onMouseUp = () => {
      resizeStateRef.current.active = false;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    resizeStateRef.current = {
      active: true,
      startX: e.clientX,
      startWidth: panelWidth,
    };
    e.preventDefault();
  };

  const handleSaveRunbook = () => {
    onRunbookSave(service.id, runbookDraft);
    setIsEditingRunbook(false);
  };

  const handleDryRunRunbook = async () => {
    const script = (isEditingRunbook ? runbookDraft : (service.runbook || runbookDraft || '')).trim();
    if (!script) {
      setDryRunResult({ error: 'Runbook script is empty.' });
      return;
    }

    setIsDryRunning(true);
    setDryRunResult(null);
    try {
      const res = await window.copilot.dryRunRunbookScript({
        script,
        serviceName: service.name,
        osHint: service.os,
      });

      if (!res.success) {
        setDryRunResult({ error: res.error || 'Dry run failed.' });
        return;
      }

      const healed = (res.healedScript || script).trim();
      const changed = Boolean(res.changed) && healed !== script;
      if (changed) {
        setRunbookDraft(healed);
        onRunbookSave(service.id, healed);
      }

      setDryRunResult({
        summary: res.summary,
        hasCriticalErrors: res.hasCriticalErrors,
        issues: res.issues || [],
        changed,
        autoHealApplied: changed,
      });
    } catch (err) {
      setDryRunResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsDryRunning(false);
    }
  };

  return (
    <div
      className="relative border-l border-gray-700 bg-gray-850 flex flex-col overflow-hidden"
      style={{ width: `${panelWidth}px` }}
    >
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize z-20 hover:bg-blue-500/40"
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize width"
      />
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800 select-none"
      >
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-200 truncate">{service.name}</h3>
          <p className="text-xs text-gray-400 truncate">{service.vmName}</p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 p-1 text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setActiveTab('details')}
          className={`flex-1 px-3 py-2 text-xs font-medium ${activeTab === 'details' ? 'text-blue-400 border-b-2 border-blue-500' : 'text-gray-400 hover:text-gray-300'}`}
        >
          Details
        </button>
        <button
          onClick={() => setActiveTab('runbook')}
          className={`flex-1 px-3 py-2 text-xs font-medium ${activeTab === 'runbook' ? 'text-blue-400 border-b-2 border-blue-500' : 'text-gray-400 hover:text-gray-300'}`}
        >
          Runbook
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`flex-1 px-3 py-2 text-xs font-medium ${activeTab === 'logs' ? 'text-blue-400 border-b-2 border-blue-500' : 'text-gray-400 hover:text-gray-300'}`}
        >
          Logs
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'details' && (
          <div className="space-y-4">
            {/* Status */}
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase">Status</label>
              <div className="mt-1 flex items-center gap-2">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{
                    backgroundColor: service.status === 'complete' ? '#22c55e'
                      : service.status === 'failed' ? '#ef4444'
                      : service.status === 'pending' ? '#6b7280'
                      : '#f59e0b'
                  }}
                />
                <span className="text-sm text-gray-200 capitalize">{service.status}</span>
              </div>
              {service.statusMessage && (
                <p className="mt-1 text-xs text-gray-400">{service.statusMessage}</p>
              )}
            </div>

            {/* IP & Port */}
            {service.ip && (
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase">IP Address</label>
                <p className="mt-1 text-sm text-gray-200 font-mono">{service.ip}{service.port ? `:${service.port}` : ''}</p>
              </div>
            )}

            {/* OS */}
            {service.os && (
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase">Operating System</label>
                <p className="mt-1 text-sm text-gray-200">{service.os}</p>
              </div>
            )}
            {/* Template */}
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase">Template</label>
              <p className="mt-1 text-sm text-gray-200">{service.templateName || planVmTemplateName || '—'}</p>
              {service.templateId && (
                <p className="text-xs text-gray-400">(service override: {service.templateId})</p>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="text-xs font-medium text-gray-400 uppercase">Description</label>
              <p className="mt-1 text-sm text-gray-300">{service.description}</p>
            </div>

            {/* Dependencies */}
            {service.dependsOn.length > 0 && (
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase">Dependencies</label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {service.dependsOn.map(dep => (
                    <span key={dep} className="px-2 py-0.5 bg-gray-700 text-gray-300 text-xs rounded">
                      {dep}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Prerequisites */}
            {service.prerequisites.length > 0 && (
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase">Prerequisites</label>
                <ul className="mt-1 space-y-1">
                  {service.prerequisites.map((prereq, i) => (
                    <li key={i} className="text-xs text-gray-300 flex items-start gap-1">
                      <span className="text-gray-500 mt-0.5">•</span>
                      {prereq}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Health check */}
            {(service.healthCheckUrl || service.healthCheckCommand) && (
              <div>
                <label className="text-xs font-medium text-gray-400 uppercase">Health Check</label>
                <p className="mt-1 text-xs text-gray-300 font-mono bg-gray-800 p-2 rounded">
                  {service.healthCheckUrl || service.healthCheckCommand}
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'runbook' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">Shell script to execute on VM</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDryRunRunbook}
                  disabled={isDryRunning}
                  className="px-2 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded disabled:opacity-60 disabled:cursor-not-allowed"
                  title="Validate script with LLM and auto-heal obvious issues"
                >
                  {isDryRunning ? 'Dry Running...' : 'Dry Run + Heal'}
                </button>
                {isEditingRunbook ? (
                  <>
                    <button
                      onClick={() => {
                        setRunbookDraft(service.runbook || '#!/bin/bash\n');
                        setIsEditingRunbook(false);
                      }}
                      className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveRunbook}
                      className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setIsEditingRunbook(true)}
                    className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {dryRunResult && (
              <div className={`mb-2 p-2 rounded border text-xs ${dryRunResult.error
                ? 'border-red-700 bg-red-950/40 text-red-200'
                : dryRunResult.hasCriticalErrors
                  ? 'border-amber-700 bg-amber-950/30 text-amber-100'
                  : 'border-emerald-700 bg-emerald-950/30'}`}>
                {dryRunResult.error ? (
                  <div>{dryRunResult.error}</div>
                ) : (
                  <>
                    <div className="font-medium">{dryRunResult.summary || 'Dry run completed.'}</div>
                    {dryRunResult.autoHealApplied && (
                      <div className="mt-1 text-emerald-200">Auto-heal applied and script saved.</div>
                    )}
                    {!!dryRunResult.issues?.length && (
                      <ul className="mt-2 space-y-1 max-h-32 overflow-auto">
                        {dryRunResult.issues.map((issue, idx) => (
                          <li key={idx} className="leading-snug">
                            <span className="uppercase mr-1">[{issue.severity || 'info'}]</span>
                            <span className="font-medium">{issue.title || 'Issue'}:</span> {issue.detail || ''}
                            {issue.lineHint ? ` (${issue.lineHint})` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}

            {isEditingRunbook ? (
              <textarea
                value={runbookDraft}
                onChange={(e) => setRunbookDraft(e.target.value)}
                spellCheck={false}
                className="flex-1 overflow-auto bg-gray-800 text-gray-200 text-xs font-mono p-3 rounded border border-gray-700 focus:outline-none focus:border-blue-500 resize-none"
              />
            ) : (
              <pre className="flex-1 overflow-auto bg-gray-800 text-gray-200 text-xs font-mono p-3 rounded border border-gray-700 whitespace-pre-wrap">
                {service.runbook || '# No runbook defined'}
              </pre>
            )}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="flex flex-col h-full">
            {service.deploymentLog ? (
              <pre className="flex-1 overflow-auto bg-gray-800 text-gray-200 text-xs font-mono p-3 rounded border border-gray-700 whitespace-pre-wrap">
                {service.deploymentLog}
              </pre>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                No deployment logs yet
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer with deploy button */}
      <div className="px-4 py-3 border-t border-gray-700 bg-gray-800">
        <button
          onClick={onDeploy}
          disabled={!canDeploy}
          className="w-full px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {service.status === 'complete' ? 'Deployed ✓' : service.status === 'pending' ? 'Deploy Service' : `Status: ${service.status}`}
        </button>
      </div>
    </div>
  );
};

export default ServiceDetailPanel;
