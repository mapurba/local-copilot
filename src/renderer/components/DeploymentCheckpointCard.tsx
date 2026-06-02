/**
 * DeploymentCheckpointCard
 *
 * An inline card rendered inside the chat message list when the HITL deployment
 * graph pauses at a checkpoint and needs user input.
 *
 * The card adapts its form controls to the current checkpoint phase:
 *   generateArchitecture  → OS selector + template UUID input + architecture approval
 *   allocateNetwork       → IP assignment choice (pool vs static)
 *   generateScripts       → Credential var acknowledgement
 *   finalizeAndVisualize  → Final approve / request changes
 */

import { useState } from 'react';
import ResponseRenderer from './ResponseRenderer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckpointPayload {
  threadId: string;
  phase: string;
  question: string;
  data?: {
    // generateArchitecture
    supportedOS?: string[];
    needsOsConfirm?: boolean;
    needsArchApproval?: boolean;
    vmSummary?: Array<{ role: string; services: string[]; cpu: number; ramGb: number; diskGb: number; os?: string }>;
    draftDesignId?: string;
    // allocateNetwork
    vmCount?: number;
    vmRoles?: Array<{ id: string; role: string }>;
    // generateScripts
    credentialVarNames?: string[];
    // finalizeAndVisualize
    mermaid?: string;
    runbookSummary?: string;
    vmTable?: Array<{ role: string; ip: string; cpu: number; ramGb: number; diskGb: number; os?: string }>;
    [key: string]: unknown;
  };
}

interface Props {
  payload: CheckpointPayload;
  /** Called when user submits answers. Parent will call resumeDeploymentGraph. */
  onSubmit: (threadId: string, answers: Record<string, unknown>) => void;
  /** Called when user wants to cancel / abandon the graph run. */
  onCancel: (threadId: string) => void;
  /** Whether the parent is waiting for the backend (disables submit button). */
  isLoading?: boolean;
}

// ── Sub-components per phase ──────────────────────────────────────────────────

function ArchitectureForm({
  data,
  onSubmit,
}: {
  data: CheckpointPayload['data'];
  onSubmit: (answers: Record<string, unknown>) => void;
}) {
  const [os, setOs] = useState('');
  const [customOs, setCustomOs] = useState('');
  const [template, setTemplate] = useState('');
  const [modeName, setModeName] = useState('distributed');
  const [approved, setApproved] = useState(false);

  const supportedOS = data?.supportedOS ?? [];
  const vmSummary = data?.vmSummary ?? [];
  const needsOsConfirm = data?.needsOsConfirm !== false;
  const needsArchApproval = data?.needsArchApproval !== false;

  const canSubmit = (!needsOsConfirm || os || customOs) && (!needsArchApproval || approved);

  return (
    <div className="space-y-4">
      {needsOsConfirm && (
        <div>
          <label className="block text-sm font-semibold mb-1 text-gray-200">Target OS</label>
          {supportedOS.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-2">
              {supportedOS.map((o) => (
                <button
                  key={o}
                  onClick={() => { setOs(o); setCustomOs(''); }}
                  className={`px-3 py-1 rounded text-sm border transition-colors ${
                    os === o
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <input
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Or type a custom OS (e.g. RHEL 9, Ubuntu 22.04)"
            value={customOs}
            onChange={(e) => { setCustomOs(e.target.value); setOs(''); }}
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-semibold mb-1 text-gray-200">
          Deployment Mode
        </label>
        <select
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          value={modeName}
          onChange={(e) => setModeName(e.target.value)}
        >
          <option value="distributed">Distributed</option>
          <option value="single-node">Single Node</option>
          <option value="ha">High Availability (HA)</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1 text-gray-200">
          VM Template UUID <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
      </div>

      {needsArchApproval && vmSummary.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-gray-200 mb-2">Draft VM Topology</p>
          <div className="overflow-x-auto rounded border border-gray-700">
            <table className="w-full text-xs text-gray-300">
              <thead className="bg-gray-700 text-gray-200">
                <tr>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Services</th>
                  <th className="px-3 py-2 text-right">vCPU</th>
                  <th className="px-3 py-2 text-right">RAM (GB)</th>
                  <th className="px-3 py-2 text-right">Disk (GB)</th>
                </tr>
              </thead>
              <tbody>
                {vmSummary.map((vm, i) => (
                  <tr key={i} className="border-t border-gray-700">
                    <td className="px-3 py-2 font-mono">{vm.role}</td>
                    <td className="px-3 py-2">{Array.isArray(vm.services) ? vm.services.join(', ') : ''}</td>
                    <td className="px-3 py-2 text-right">{vm.cpu}</td>
                    <td className="px-3 py-2 text-right">{vm.ramGb}</td>
                    <td className="px-3 py-2 text-right">{vm.diskGb}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 mt-3 cursor-pointer">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            <span className="text-sm text-gray-300">This architecture looks correct — proceed</span>
          </label>
        </div>
      )}

      <button
        disabled={!canSubmit}
        onClick={() => onSubmit({
          osPreference: os || customOs || undefined,
          vmTemplate: template || undefined,
          modeName,
          architectureApproved: needsArchApproval ? approved : true,
        })}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition-colors"
      >
        Continue
      </button>
    </div>
  );
}

function NetworkForm({
  data,
  onSubmit,
}: {
  data: CheckpointPayload['data'];
  onSubmit: (answers: Record<string, unknown>) => void;
}) {
  const [usePool, setUsePool] = useState(true);
  const [staticIps, setStaticIps] = useState<Record<string, string>>({});
  const [hostname, setHostname] = useState('');
  const [subnet, _setSubnet] = useState('');
  const [gateway, setGateway] = useState('');

  const vmRoles = data?.vmRoles ?? [];

  const canSubmit = usePool || vmRoles.every((v) => staticIps[v.id]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <button
          onClick={() => setUsePool(true)}
          className={`flex-1 px-3 py-2 rounded border text-sm font-semibold transition-colors ${
            usePool
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Allocate from VCD Pool
        </button>
        <button
          onClick={() => setUsePool(false)}
          className={`flex-1 px-3 py-2 rounded border text-sm font-semibold transition-colors ${
            !usePool
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Specify Static IPs
        </button>
      </div>

      {!usePool && vmRoles.length > 0 && (
        <div className="space-y-2">
          {vmRoles.map((vm) => (
            <div key={vm.id} className="flex items-center gap-3">
              <span className="text-sm text-gray-300 w-32 font-mono truncate">{vm.role}</span>
              <input
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="e.g. 10.0.0.11"
                value={staticIps[vm.id] ?? ''}
                onChange={(e) => setStaticIps({ ...staticIps, [vm.id]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Hostname <span className="text-gray-500">(optional)</span></label>
          <input
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="server-01"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Gateway <span className="text-gray-500">(optional)</span></label>
          <input
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="10.0.0.1"
            value={gateway}
            onChange={(e) => setGateway(e.target.value)}
          />
        </div>
      </div>

      <button
        disabled={!canSubmit}
        onClick={() => onSubmit({
          networkDetails: {
            usePoolIps: usePool,
            staticIps: usePool ? undefined : staticIps,
            hostname: hostname || undefined,
            subnet: subnet || undefined,
            gateway: gateway || undefined,
          },
        })}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition-colors"
      >
        Continue
      </button>
    </div>
  );
}

function CredentialVarsForm({
  data,
  onSubmit,
}: {
  data: CheckpointPayload['data'];
  onSubmit: (answers: Record<string, unknown>) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const vars = data?.credentialVarNames ?? [];

  return (
    <div className="space-y-4">
      {vars.length > 0 && (
        <div className="bg-gray-800 border border-yellow-600/40 rounded p-3">
          <p className="text-xs text-yellow-400 font-semibold mb-2 uppercase tracking-wide">
            Required Credentials / Config Variables
          </p>
          <ul className="space-y-1">
            {vars.map((v) => (
              <li key={v} className="flex items-center gap-2 text-sm text-gray-300">
                <span className="w-2 h-2 rounded-full bg-yellow-500 flex-shrink-0" />
                <code className="font-mono text-yellow-300">{v}</code>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3">
            These are <strong>variable names only</strong> — no passwords are stored or transmitted.
            Set them in your deployment environment before running the install scripts.
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="w-4 h-4 accent-blue-500"
        />
        <span className="text-sm text-gray-300">
          I understand — I will configure these variables before deployment
        </span>
      </label>

      <button
        disabled={!acknowledged}
        onClick={() => onSubmit({ credentialVarsAcknowledged: true })}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition-colors"
      >
        Continue
      </button>
    </div>
  );
}

function FinalApprovalForm({
  data,
  onSubmit,
  onRequestChanges,
}: {
  data: CheckpointPayload['data'];
  onSubmit: (answers: Record<string, unknown>) => void;
  onRequestChanges: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const vmTable = data?.vmTable ?? [];
  const mermaid = data?.mermaid ?? '';

  return (
    <div className="space-y-4">
      {mermaid && (
        <div className="rounded border border-gray-700 overflow-hidden">
          <ResponseRenderer content={`\`\`\`mermaid\n${mermaid}\n\`\`\``} />
        </div>
      )}

      {vmTable.length > 0 && (
        <div className="overflow-x-auto rounded border border-gray-700">
          <table className="w-full text-xs text-gray-300">
            <thead className="bg-gray-700 text-gray-200">
              <tr>
                <th className="px-3 py-2 text-left">VM Role</th>
                <th className="px-3 py-2 text-left">IP</th>
                <th className="px-3 py-2 text-left">OS</th>
                <th className="px-3 py-2 text-right">vCPU</th>
                <th className="px-3 py-2 text-right">RAM (GB)</th>
                <th className="px-3 py-2 text-right">Disk (GB)</th>
              </tr>
            </thead>
            <tbody>
              {vmTable.map((vm, i) => (
                <tr key={i} className="border-t border-gray-700">
                  <td className="px-3 py-2 font-mono">{vm.role}</td>
                  <td className="px-3 py-2 font-mono">{vm.ip}</td>
                  <td className="px-3 py-2">{vm.os ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{vm.cpu}</td>
                  <td className="px-3 py-2 text-right">{vm.ramGb}</td>
                  <td className="px-3 py-2 text-right">{vm.diskGb}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!showFeedback ? (
        <div className="flex gap-3">
          <button
            onClick={() => onSubmit({ finalApproved: true })}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-semibold rounded transition-colors"
          >
            Approve &amp; Save Plan
          </button>
          <button
            onClick={() => setShowFeedback(true)}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
          >
            Request Changes
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            rows={3}
            placeholder="Describe what you'd like to change..."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              disabled={!feedback.trim()}
              onClick={() => onRequestChanges(feedback)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded transition-colors"
            >
              Submit Feedback
            </button>
            <button
              onClick={() => setShowFeedback(false)}
              className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  classifyIntent: 'Step 1 — Understanding Intent',
  generateArchitecture: 'Step 2 — Architecture Design',
  allocateNetwork: 'Step 3 — Network & IPs',
  generateScripts: 'Step 4 — Install Scripts',
  finalizeAndVisualize: 'Step 5 — Review & Approve',
};

const PHASE_ICONS: Record<string, string> = {
  generateArchitecture: '🏗',
  allocateNetwork: '🌐',
  generateScripts: '📜',
  finalizeAndVisualize: '✅',
};

export default function DeploymentCheckpointCard({
  payload,
  onSubmit,
  onCancel,
  isLoading = false,
}: Props) {
  const { threadId, phase, question, data } = payload;
  const label = PHASE_LABELS[phase] ?? 'Deployment Checkpoint';
  const icon = PHASE_ICONS[phase] ?? '🔧';

  const handleSubmit = (answers: Record<string, unknown>) => {
    onSubmit(threadId, answers);
  };

  const handleRequestChanges = (feedback: string) => {
    // Treat feedback as a new chat message — parent routes it to chatWithTools
    onSubmit(threadId, { feedback, finalApproved: false });
  };

  return (
    <div className="rounded-xl border border-blue-500/40 bg-gray-850 shadow-lg overflow-hidden my-3">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-lg">{icon}</span>
        <div>
          <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide">{label}</p>
          <p className="text-sm text-gray-200">Deployment Agent needs your input</p>
        </div>
        {isLoading && (
          <div className="ml-auto">
            <svg className="animate-spin h-4 w-4 text-blue-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          </div>
        )}
      </div>

      {/* Question */}
      <div className="px-4 pt-3 pb-2">
        <div className="text-sm text-gray-300 leading-relaxed">
          <ResponseRenderer content={question} />
        </div>
      </div>

      {/* Phase-specific form */}
      <div className="px-4 pb-4">
        {phase === 'generateArchitecture' && (
          <ArchitectureForm data={data} onSubmit={handleSubmit} />
        )}
        {phase === 'allocateNetwork' && (
          <NetworkForm data={data} onSubmit={handleSubmit} />
        )}
        {phase === 'generateScripts' && (
          <CredentialVarsForm data={data} onSubmit={handleSubmit} />
        )}
        {phase === 'finalizeAndVisualize' && (
          <FinalApprovalForm
            data={data}
            onSubmit={handleSubmit}
            onRequestChanges={handleRequestChanges}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-700 flex justify-end">
        <button
          onClick={() => onCancel(threadId)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Abandon this deployment workflow
        </button>
      </div>
    </div>
  );
}
