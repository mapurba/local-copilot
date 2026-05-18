import React, {
  createContext,
  FC,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Button, IconButton } from '@ux-aspects-universal/react/button';
import { Checkbox } from '@ux-aspects-universal/react/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@ux-aspects-universal/react/dialog';
import { CollapseAllIcon, ExpandAllIcon } from '@ux-aspects-universal/react/icon/jato';
import { TextInput } from '@ux-aspects-universal/react/text-input';
import { useSelection } from '@ux-aspects-universal/react/selection';

interface ToolEntry {
  name: string;
  category: string;
  description: string;
}

interface ToolData {
  type: 'category' | 'tool';
  toolName?: string;
  description?: string;
  catTools?: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  vcd: 'VCD Operations',
  tasks: 'Task Tracking',
  ssh: 'SSH Tools',
  docs: 'Documents',
  local: 'Local Tools',
  agent: 'Agent Tools',
  browser: 'Browser Tools',
  todo: 'Todo Tools',
};

// ─────────────────────────────────────────────────────────────────────────────
// Context — passes mutable panel state into the module-level tree node renderer
// ─────────────────────────────────────────────────────────────────────────────

interface PanelContextValue {
  localDisabled: Set<string>;
  toggleTool: (name: string) => void;
  toggleCategoryTools: (catTools: string[], checked: boolean) => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

// We render a custom expandable list below (instead of the Tree control)
// so that tool names and descriptions can wrap naturally without being
// clipped by a fixed row height inside the Tree implementation.

// ─────────────────────────────────────────────────────────────────────────────
// Panel component
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigureToolsPanelProps {
  open: boolean;
  disabledTools: Set<string>;
  onClose: () => void;
  onSave: (disabledTools: Set<string>) => void;
}

const ConfigureToolsPanel: FC<ConfigureToolsPanelProps> = ({
  open,
  disabledTools,
  onClose,
  onSave,
}) => {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localDisabled, setLocalDisabled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [allCollapsed, setAllCollapsed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocalDisabled(new Set(disabledTools));
    setSearch('');
    setLoadError(null);
    setAllCollapsed(false);
    window.copilot
      .listTools()
      .then((entries) => setTools(entries))
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
        setTools([]);
      });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? tools.filter(
          (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
        )
      : tools;
  }, [tools, search]);

  const treeItems = useMemo(() => {
    const byCategory: Record<string, ToolEntry[]> = {};
    for (const t of filteredTools) {
      if (!byCategory[t.category]) byCategory[t.category] = [];
      byCategory[t.category].push(t);
    }
    return Object.keys(byCategory).map((cat) => ({
      title: CATEGORY_LABELS[cat] ?? cat,
      data: { type: 'category' as const, catTools: byCategory[cat].map((t) => t.name) },
      children: byCategory[cat].map((tool) => ({
        title: tool.name,
        data: { type: 'tool' as const, toolName: tool.name, description: tool.description },
      })),
    }));
  }, [filteredTools]);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (treeItems.length > 0) {
      const all = new Set(treeItems.map((t: any) => t.title));
      setExpandedCategories(allCollapsed ? new Set() : all);
    }
  }, [treeItems, allCollapsed]);

  const toggleCategoryExpanded = useCallback((title: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  const toggleTool = useCallback((name: string) => {
    setLocalDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleCategoryTools = useCallback((catTools: string[], checked: boolean) => {
    setLocalDisabled((prev) => {
      const next = new Set(prev);
      catTools.forEach((name) => {
        if (checked) next.delete(name);
        else next.add(name);
      });
      return next;
    });
  }, []);

  const contextValue = useMemo(
    () => ({ localDisabled, toggleTool, toggleCategoryTools }),
    [localDisabled, toggleTool, toggleCategoryTools]
  );

  if (!open) return null;

  const enabledCount = tools.length - localDisabled.size;

  const handleCollapseToggle = () => {
    if (allCollapsed) {
      const all = new Set(treeItems.map((t: any) => t.title));
      setExpandedCategories(all);
      setAllCollapsed(false);
    } else {
      setExpandedCategories(new Set());
      setAllCollapsed(true);
    }
  };

  return (
    <PanelContext.Provider value={contextValue}>
      <Dialog onClose={onClose} aria-label="Configure Tools" style={{ width: '48rem', maxWidth: '98vw' }}>
        <DialogHeader>Configure Tools</DialogHeader>

        <DialogContent>
          {/* Search row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <TextInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search tools…"
              style={{ flex: 1 }}
            />
            <IconButton
              flat
              size="small"
              onClick={handleCollapseToggle}
              aria-label={allCollapsed ? 'Expand all' : 'Collapse all'}
              title={allCollapsed ? 'Expand all' : 'Collapse all'}
              icon={allCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 10,
                background: 'var(--uxap-primary, #0070d2)',
                color: '#fff',
                whiteSpace: 'nowrap',
              }}
            >
              {enabledCount} Selected
            </span>
          </div>

          <p style={{ fontSize: 11, opacity: 0.6, margin: '0 0 10px' }}>
            Select which tools are available to the AI assistant.
          </p>

          {/* Tool tree */}
          <div
            style={{
              maxHeight: '65vh',
              overflowY: 'auto',
              borderTop: '1px solid var(--uxap-border, #ddd)',
              paddingTop: 4,
              paddingRight: 40,
              boxSizing: 'border-box',
              whiteSpace: 'normal',
              wordBreak: 'break-word',
            }}
          >
            {loadError ? (
              <p style={{ padding: '12px 8px', textAlign: 'center', fontSize: 12, color: '#dc2626' }}>
                Failed to load tools — please restart the app.
                <br />
                <span style={{ opacity: 0.6, fontSize: 11 }}>{loadError}</span>
              </p>
            ) : treeItems.length === 0 ? (
              <p style={{ padding: 16, textAlign: 'center', opacity: 0.5, fontSize: 12 }}>
                {tools.length > 0 ? 'No tools match your search.' : 'Loading…'}
              </p>
            ) : (
              <div style={{ paddingRight: 12 }}>
                {treeItems.map((cat: any) => {
                  const title = cat.title as string;
                  const catTools: string[] = cat.data?.catTools ?? [];
                  const enabledInCat = catTools.filter((n) => !localDisabled.has(n)).length;
                  const allEnabled = enabledInCat === catTools.length;
                  const someEnabled = enabledInCat > 0 && enabledInCat < catTools.length;
                  const expanded = expandedCategories.has(title);

                  return (
                    <div key={title} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={() => toggleCategoryExpanded(title)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleCategoryExpanded(title);
                          }
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer' }}
                      >
                        <span onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            isChecked={allEnabled}
                            isIndeterminate={someEnabled}
                            onCheckedChange={(checked) => toggleCategoryTools(catTools, !!checked)}
                          />
                        </span>
                        <button
                          aria-expanded={expanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCategoryExpanded(title);
                          }}
                          style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', lineHeight: 1 }}
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flex: 1 }} title={title}>
                          <span>{title}</span>
                          <span style={{ fontSize: 11, opacity: 0.5 }}>{`(${catTools.length})`}</span>
                        </div>
                      </div>

                      {expanded && (
                        <div style={{ paddingLeft: 44, paddingRight: 8, paddingBottom: 8 }}>
                          {cat.children?.map((child: any) => {
                            const toolName = child.title as string;
                            const description = child.data?.description as string | undefined;
                            return (
                              <div key={toolName} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 4px' }}>
                                <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, marginTop: 2, width: 28 }}>
                                  <Checkbox
                                    isChecked={!localDisabled.has(toolName)}
                                    onCheckedChange={() => toggleTool(toolName)}
                                  />
                                </span>
                                <div style={{ minWidth: 0, flex: 1, minHeight: 44 }}>
                                  <span title={toolName} style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 500, whiteSpace: 'normal', wordBreak: 'break-word', display: 'block' }}>
                                    {toolName}
                                  </span>
                                          {description && (
                                            <p title={String(description)} style={{ fontSize: 11, opacity: 0.85, margin: '0px 0 0', lineHeight: 1.35, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                                              {description}
                                            </p>
                                          )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>

        <DialogFooter>
          <Button secondary flat onClick={onClose}>
            Cancel
          </Button>
          <Button primary onClick={() => onSave(localDisabled)}>
            OK
          </Button>
        </DialogFooter>
      </Dialog>
    </PanelContext.Provider>
  );
};

export default ConfigureToolsPanel;

