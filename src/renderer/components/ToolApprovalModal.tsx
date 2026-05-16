/**
 * Tool Approval Modal — VS Code Copilot-style with severity-aware design.
 * Severity color is used ONLY for the badge, the banner accent strip, and
 * the banner message text. Everything else stays neutral.
 */

import React, { useState, useEffect } from 'react';
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@ux-aspects-universal/react/dialog';
import { Button } from '@ux-aspects-universal/react/button';

interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  category: string;
  riskLevel: 'safe' | 'review' | 'dangerous';
  description: string;
  args: unknown;
  target: string;
  impactAssessment?: string;
  timestamp: number;
}

interface ToolApprovalModalProps {
  request: ToolApprovalRequest | null;
  onApprove: (approvalType: 'once' | 'session' | 'always') => void;
  onDeny: (reason?: string) => void;
}

// ─── Severity — only the badge + banner strip use these colors ────────────────
const RISK = {
  safe: {
    accent: '#16a34a',
    badgeBg: 'rgba(22,163,74,0.12)',
    badgeText: '#15803d',
    badgeBorder: 'rgba(22,163,74,0.30)',
    bannerText: '#15803d',
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" /><polyline points="5,8 7,10 11,6" />
      </svg>
    ),
    label: 'SAFE',
    bannerMsg: 'This is a read-only operation — no data will be modified.',
  },
  review: {
    accent: '#b45309',
    badgeBg: 'rgba(180,83,9,0.10)',
    badgeText: '#b45309',
    badgeBorder: 'rgba(180,83,9,0.28)',
    bannerText: '#92400e',
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2L14 13H2L8 2z" /><line x1="8" y1="7" x2="8" y2="10" /><circle cx="8" cy="12" r="0.6" fill="currentColor" />
      </svg>
    ),
    label: 'REVIEW',
    bannerMsg: 'Review the details carefully before approving — this action will make changes.',
  },
  dangerous: {
    accent: '#b91c1c',
    badgeBg: 'rgba(185,28,28,0.10)',
    badgeText: '#b91c1c',
    badgeBorder: 'rgba(185,28,28,0.28)',
    bannerText: '#991b1b',
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" /><line x1="8" y1="5" x2="8" y2="9" /><circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
      </svg>
    ),
    label: 'DANGEROUS',
    bannerMsg: 'This is a destructive operation that may be irreversible. Approve only if you intended this.',
  },
} as const;

// ─── Neutral tokens (theme-agnostic) ─────────────────────────────────────────
const N = {
  surface:   'var(--uxa-color__surface-subtle, rgba(0,0,0,0.04))',
  border:    'var(--uxa-color__border,         rgba(0,0,0,0.12))',
  text:      'var(--uxa-color__text,           inherit)',
  label:     'rgba(0,0,0,0.45)',
  codeBg:    '#1e1e1e',   // VS Code dark terminal
  codeText:  '#d4d4d4',
};

// ─── Command preview helpers ──────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set(['password', 'pass', 'secret', 'token', 'key', 'apikey', 'api_key', 'passwd']);

function maskValue(key: string, value: string): string {
  return SENSITIVE_KEYS.has(key.toLowerCase()) ? '•'.repeat(Math.min(value.length, 10)) : value;
}

function getCommandPreview(toolName: string, args: unknown): { lines: string[]; isTerminal: boolean } {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => String(v ?? '');

  switch (toolName) {
    case 'ssh:connect':
    case 'ssh_connect':
      return { lines: [`ssh ${s(a.username) || 'user'}@${s(a.host) || 'host'}`], isTerminal: true };
    case 'ssh:runCommand':
    case 'ssh_runCommand':
    case 'ssh:run':
      return { lines: [s(a.command || a.cmd || a.script || '')], isTerminal: true };
    case 'ssh:disconnect':
    case 'ssh_disconnect':
      return { lines: [`disconnect session${a.sessionId ? ' ' + s(a.sessionId) : ''}`], isTerminal: true };
    case 'ssh:writeFile':
    case 'ssh_writeFile':
      return { lines: [`write → ${s(a.path || a.filePath || '')}`, `${String(a.content ?? '').slice(0, 80)}${String(a.content ?? '').length > 80 ? '…' : ''}`], isTerminal: true };
    case 'delete_vm':
      return { lines: [`DELETE VM  ${s(a.vmName || a.href || a.vm_name || '')}`, a.powered_on ? '⚠ VM is currently powered on — will force-delete' : ''].filter(Boolean), isTerminal: false };
    case 'power_off_vm':
    case 'stop_vm':
      return { lines: [`Power OFF  ${s(a.vmName || a.vmHref || a.href || '')}`], isTerminal: false };
    case 'power_on_vm':
    case 'start_vm':
      return { lines: [`Power ON   ${s(a.vmName || a.vmHref || a.href || '')}`], isTerminal: false };
    case 'revert_snapshot':
    case 'revert_vm_snapshot':
      return { lines: [`Revert snapshot  ${s(a.vmName || a.vmNameOrHref || '')}`, '⚠ Current VM state will be lost'].filter(Boolean), isTerminal: false };
    case 'resize_vm':
    case 'update_vm_compute':
      return { lines: [`Resize  ${s(a.vmName || a.vmNameOrHref || '')}`, a.cpu ? `CPU: ${s(a.cpu)}  RAM: ${s(a.memory_mb)} MB` : ''].filter(Boolean), isTerminal: false };
    default: {
      const entries = Object.entries(a)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${maskValue(k, String(v))}`)
        .slice(0, 4);
      return { lines: [toolName, ...entries], isTerminal: false };
    }
  }
}

function getArgRows(args: unknown): { key: string; value: string; sensitive: boolean }[] {
  const a = (args ?? {}) as Record<string, unknown>;
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({
      key: k,
      value: String(v),
      sensitive: SENSITIVE_KEYS.has(k.toLowerCase()),
    }));
}

// ─── Component ────────────────────────────────────────────────────────────────
export const ToolApprovalModal: React.FC<ToolApprovalModalProps> = ({ request, onApprove, onDeny }) => {
  const [selectedApprovalType, setSelectedApprovalType] = useState<'once' | 'session' | 'always'>('once');
  const [showArgs, setShowArgs] = useState(false);

  useEffect(() => {
    if (request) { setSelectedApprovalType('once'); setShowArgs(false); }
  }, [request?.requestId]);

  if (!request) return null;

  const risk = RISK[request.riskLevel] ?? RISK.review;
  const preview = getCommandPreview(request.toolName, request.args);
  const argRows = getArgRows(request.args);

  return (
    <Dialog onClose={() => onDeny()} aria-label="Tool Approval Required"
      style={{ width: '100%', maxWidth: '44rem' }}>

      {/* ── Header ── */}
      <DialogHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
          {/* Shield icon — neutral */}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.65 }}>
            <path d="M8 1.5 L14 4 V8 C14 11.5 11 14 8 14.5 C5 14 2 11.5 2 8 V4 Z" />
          </svg>
          <span style={{ fontWeight: 600, flex: 1 }}>Tool Approval Required</span>
          {/* Severity badge — the ONE place for accent color */}
          <span style={{
            background: risk.badgeBg,
            color: risk.badgeText,
            border: `1px solid ${risk.badgeBorder}`,
            borderRadius: '4px', padding: '2px 8px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em',
            display: 'inline-flex', alignItems: 'center', gap: '5px',
          }}>
            <span>{risk.icon}</span>{risk.label}
          </span>
        </div>
      </DialogHeader>

      <DialogContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* ── Severity banner — accent left-strip only, neutral bg ── */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '9px 13px',
            borderRadius: '5px',
            background: N.surface,
            border: `1px solid ${N.border}`,
            borderLeft: `3px solid ${risk.accent}`,
          }}>
            <span style={{ color: risk.accent, marginTop: '1px', flexShrink: 0 }}>{risk.icon}</span>
            <span style={{ fontSize: '12.5px', color: risk.bannerText, lineHeight: 1.5 }}>{risk.bannerMsg}</span>
          </div>

          {/* ── Tool chip + category + target ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              background: N.surface, border: `1px solid ${N.border}`,
              borderRadius: '5px', padding: '3px 10px',
              fontFamily: 'monospace', fontSize: '12.5px', fontWeight: 600,
            }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.55 }}>
                <path d="M9.5 1.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5L6 5l2.5-1z"/>
                <path d="M3 8l.7 1.8L5.5 10l-1.8.7L3 12.5l-.7-1.8L.5 10l1.8-.7z"/>
              </svg>
              {request.toolName}
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              background: N.surface, border: `1px solid ${N.border}`,
              borderRadius: '5px', padding: '3px 10px', fontSize: '11.5px', opacity: 0.65,
            }}>
              {request.category}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '11.5px', opacity: 0.45 }}>
              target: <strong>{request.target}</strong>
            </span>
          </div>

          {/* ── Description ── */}
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.8 }}>
            {request.description}
          </p>

          {/* ── Command preview ── */}
          <div>
            <div style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', opacity: 0.45, marginBottom: '6px' }}>
              {preview.isTerminal ? 'Command to execute' : 'Action to perform'}
            </div>
            <div style={{
              borderRadius: '6px',
              border: `1px solid ${preview.isTerminal ? 'rgba(255,255,255,0.07)' : N.border}`,
              padding: '10px 14px',
              background: preview.isTerminal ? N.codeBg : N.surface,
              color: preview.isTerminal ? N.codeText : N.text,
              fontFamily: 'monospace', fontSize: '12.5px', lineHeight: 1.65,
              overflowX: 'auto',
            }}>
              {preview.isTerminal && (
                <span style={{ color: '#6a9955', marginRight: '8px', userSelect: 'none' }}>$</span>
              )}
              {preview.lines.filter(Boolean).map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </div>

          {/* ── Impact assessment — neutral, not amber ── */}
          {request.impactAssessment && (
            <div style={{
              display: 'flex', gap: '10px', alignItems: 'flex-start',
              padding: '9px 13px', borderRadius: '5px',
              background: N.surface, border: `1px solid ${N.border}`,
              borderLeft: `3px solid ${risk.accent}`,
            }}>
              <span style={{ color: risk.accent, flexShrink: 0, marginTop: '1px' }}>{risk.icon}</span>
              <span style={{ fontSize: '12.5px', lineHeight: 1.5, opacity: 0.85 }}>{request.impactAssessment}</span>
            </div>
          )}

          {/* ── Arguments — collapsible ── */}
          <div>
            <button onClick={() => setShowArgs(v => !v)} style={{
              display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 5px 0',
              fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase',
              opacity: 0.45, color: 'inherit',
            }}>
              <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"
                style={{ transform: showArgs ? 'rotate(90deg)' : 'none', transition: 'transform 0.14s' }}>
                <path d="M3 1l4 4-4 4V1z" />
              </svg>
              Arguments
              <span style={{ opacity: 0.6, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                ({argRows.length} {argRows.length === 1 ? 'param' : 'params'})
              </span>
            </button>

            {showArgs && (
              <div style={{ borderRadius: '5px', border: `1px solid ${N.border}`, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'monospace' }}>
                  <tbody>
                    {argRows.map(({ key, value, sensitive }, i) => (
                      <tr key={key} style={{
                        borderBottom: i < argRows.length - 1 ? `1px solid ${N.border}` : 'none',
                        background: i % 2 === 0 ? 'transparent' : N.surface,
                      }}>
                        <td style={{ padding: '6px 12px', width: '32%', opacity: 0.5, fontWeight: 500, whiteSpace: 'nowrap' }}>{key}</td>
                        <td style={{ padding: '6px 12px', wordBreak: 'break-all' }}>
                          {sensitive
                            ? <><span style={{ opacity: 0.4, letterSpacing: '1.5px' }}>{maskValue(key, value)}</span>
                                <span style={{ marginLeft: 8, fontSize: '10px', opacity: 0.35, background: N.surface, border: `1px solid ${N.border}`, borderRadius: 3, padding: '1px 5px' }}>hidden</span>
                              </>
                            : <span>{value}</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Approval scope ── */}
          <div>
            <div style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', opacity: 0.45, marginBottom: '7px' }}>
              Approval scope
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {([
                { value: 'once',    label: 'Allow once',        desc: 'Execute this time only' },
                { value: 'session', label: 'Allow for session', desc: 'Auto-approve until app restart' },
                { value: 'always',  label: 'Always allow',      desc: 'Auto-approve permanently' },
              ] as const).map(({ value, label, desc }) => {
                const active = selectedApprovalType === value;
                return (
                  <label key={value} onClick={() => setSelectedApprovalType(value)} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 12px', borderRadius: '5px', cursor: 'pointer',
                    border: `1px solid ${active ? N.border : N.border}`,
                    background: active ? N.surface : 'transparent',
                    transition: 'background 0.1s',
                  }}>
                    {/* Custom radio */}
                    <div style={{
                      width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
                      border: `2px solid ${active ? risk.accent : 'rgba(0,0,0,0.22)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {active && <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: risk.accent }} />}
                    </div>
                    <input type="radio" name="approval-type" value={value} checked={active}
                      onChange={() => setSelectedApprovalType(value)} style={{ display: 'none' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: active ? 500 : 400 }}>{label}</div>
                      <div style={{ fontSize: '11px', opacity: 0.5 }}>{desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

        </div>
      </DialogContent>

      <DialogFooter>
        <Button secondary onClick={() => onDeny()}>Deny</Button>
        <Button primary onClick={() => onApprove(selectedApprovalType)}
          iconBefore={
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3,8 6.5,11.5 13,5" />
            </svg>
          }
        >
          Approve
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

