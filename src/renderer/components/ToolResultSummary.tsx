/**
 * ToolResultSummary — wraps tool result messages with a human-readable
 * summary and collapses the raw response into an accordion.
 */

import React, { useState } from 'react';
import ResponseRenderer from './ResponseRenderer';

interface ToolResultSummaryProps {
  content: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type ResultStatus = 'success' | 'error' | 'denied' | 'info' | 'warning';

interface Summary {
  status: ResultStatus;
  title: string;
  detail?: string;
}

// ─── JSON extraction ──────────────────────────────────────────────────────────
function extractJson(content: string): unknown | null {
  // Try a fenced ```json ... ``` block first
  const fenced = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const str = fenced ? fenced[1].trim() : content.trim();
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Smart summary ────────────────────────────────────────────────────────────
function buildSummary(content: string): Summary {
  const data = extractJson(content);

  // ── Plain-text (non-JSON) ──────────────────────────────────────────────
  if (data === null) {
    const first = content.split('\n').find(l => l.trim())?.trim() ?? '';
    if (/^error[: ]/i.test(first))
      return { status: 'error', title: 'Tool error', detail: first.slice(0, 120) };
    // Markdown with table = list result
    if (content.includes('|---'))
      return { status: 'info', title: 'Results returned', detail: 'Tabular data' };
    return { status: 'info', title: first.slice(0, 100) || 'Tool executed' };
  }

  const d = data as Record<string, unknown>;

  // ── Denied / rejected ─────────────────────────────────────────────────
  if (d.denied === true)
    return { status: 'denied', title: 'Execution denied', detail: d.reason ? String(d.reason) : undefined };

  // ── Cancelled ─────────────────────────────────────────────────────────
  if (d.cancelled === true)
    return { status: 'denied', title: 'Cancelled', detail: d.message ? String(d.message) : undefined };

  // ── Explicit success/failure ──────────────────────────────────────────
  if (d.success === false)
    return { status: 'error', title: 'Operation failed', detail: d.error ? String(d.error) : undefined };
  if (d.success === true) {
    const detail = d.message ? String(d.message) : undefined;
    return { status: 'success', title: 'Completed successfully', detail };
  }

  // ── SSH connect ───────────────────────────────────────────────────────
  if (d.sessionId && d.connected !== undefined)
    return d.connected
      ? { status: 'success', title: 'SSH connected', detail: `Session ${String(d.sessionId)}` }
      : { status: 'error', title: 'SSH connection failed', detail: d.error ? String(d.error) : undefined };

  // ── SSH command output ────────────────────────────────────────────────
  if ('stdout' in d || 'stderr' in d || 'exitCode' in d) {
    const code = d.exitCode as number | undefined;
    const out = String(d.stdout ?? d.output ?? '').trim();
    const preview = out.length > 80 ? out.slice(0, 80) + '…' : out;
    if (code !== undefined && code !== 0)
      return { status: 'warning', title: `Command exited with code ${code}`, detail: preview || undefined };
    return { status: 'success', title: 'Command executed', detail: preview || undefined };
  }

  // ── List results ──────────────────────────────────────────────────────
  const LIST_KEYS: Record<string, string> = {
    vms: 'VM', tasks: 'task', templates: 'template', snapshots: 'snapshot',
    vapps: 'vApp', items: 'item', results: 'result', sessions: 'session',
    records: 'record', entries: 'entry',
  };
  for (const [key, label] of Object.entries(LIST_KEYS)) {
    if (Array.isArray(d[key])) {
      const count = d.count !== undefined ? Number(d.count) : (d[key] as unknown[]).length;
      const plural = count !== 1 ? label + 's' : label;
      return { status: 'info', title: `Found ${count} ${plural}` };
    }
  }

  // ── Bare count ────────────────────────────────────────────────────────
  if (typeof d.count === 'number')
    return { status: 'info', title: `${d.count} result${d.count !== 1 ? 's' : ''}` };

  // ── VM status ─────────────────────────────────────────────────────────
  if ('powered_on' in d) {
    const name = d.name ? `"${d.name}"` : 'VM';
    return { status: 'info', title: `${name} is ${d.powered_on ? 'powered on' : 'powered off'}` };
  }

  // ── Single message field ──────────────────────────────────────────────
  if (typeof d.message === 'string')
    return { status: 'info', title: d.message.slice(0, 120) };

  // ── Fallback ──────────────────────────────────────────────────────────
  return { status: 'info', title: 'Tool response received' };
}

// ─── Status dot + colours ─────────────────────────────────────────────────────
const STATUS_META: Record<ResultStatus, { dot: string; title: string; detail: string; bg: string; border: string }> = {
  success: { dot: '#22c55e', title: '#15803d', detail: '#166534', bg: 'rgba(22,163,74,0.07)',  border: 'rgba(22,163,74,0.20)' },
  error:   { dot: '#ef4444', title: '#b91c1c', detail: '#991b1b', bg: 'rgba(239,68,68,0.07)',  border: 'rgba(239,68,68,0.22)' },
  denied:  { dot: '#f59e0b', title: '#b45309', detail: '#92400e', bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.22)' },
  warning: { dot: '#f59e0b', title: '#b45309', detail: '#92400e', bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.22)' },
  info:    { dot: '#3b82f6', title: '#1d4ed8', detail: '#1e3a8a', bg: 'rgba(59,130,246,0.07)', border: 'rgba(59,130,246,0.20)' },
};

// ─── Component ────────────────────────────────────────────────────────────────
const ToolResultSummary: React.FC<ToolResultSummaryProps> = ({ content }) => {
  const [open, setOpen] = useState(false);
  const summary = buildSummary(content);
  const meta = STATUS_META[summary.status];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>

      {/* ── Summary card ── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '9px',
        padding: '8px 12px', borderRadius: '6px',
        background: meta.bg, border: `1px solid ${meta.border}`,
        borderLeft: `3px solid ${meta.dot}`,
      }}>
        {/* Status dot */}
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: meta.dot, flexShrink: 0, marginTop: 5,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 500, color: meta.title, lineHeight: 1.4 }}>
            {summary.title}
          </div>
          {summary.detail && (
            <div style={{
              fontSize: '12px', marginTop: '2px',
              color: meta.detail, opacity: 0.85, lineHeight: 1.4,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {summary.detail}
            </div>
          )}
        </div>
      </div>

      {/* ── Raw response accordion ── */}
      <div>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
            fontSize: '11.5px', opacity: 0.45, color: 'inherit',
            fontFamily: 'inherit',
          }}
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.14s', flexShrink: 0 }}>
            <path d="M3 1l4 4-4 4V1z" />
          </svg>
          {open ? 'Hide' : 'Raw'} response
        </button>

        {open && (
          <div style={{
            marginTop: '6px',
            padding: '1px 0',
            borderRadius: '6px',
            overflow: 'hidden',
            opacity: 0.85,
          }}>
            <ResponseRenderer content={content} />
          </div>
        )}
      </div>
    </div>
  );
};

export default ToolResultSummary;
