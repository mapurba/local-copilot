import {
  buildUnderstandingPrompt,
  buildToolSelectorPrompt,
  buildActivityDetailPrompt,
  buildFlowDesignPrompt,
  buildPlanningPrompt,
  buildCritiquePrompt,
  buildRevisionPrompt,
  PLANNING_SYSTEM_PROMPT,
} from './prompts';
import { generateJson } from './llm';
import { WorkflowBuilder, StartActivity, UserActivity, RestActivity, EntityActivity, ConditionActivity, LogActivity, FinishActivity } from './builder';

function toSafeKey(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '_') || 'field'
  );
}

function toBool(value: any, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return defaultValue;
}

function normalizeComponentType(rawType: any) {
  const type = String(rawType || '').trim();
  const lower = type.toLowerCase();
  const aliases: Record<string, string> = {
    text: 'textfield',
    textbox: 'textfield',
    string: 'textfield',
    multiline: 'textarea',
    int: 'number',
    integer: 'number',
    bool: 'checkbox',
    boolean: 'checkbox',
    date: 'datetime',
  };
  const normalized = aliases[lower] || lower;
  const allowed = new Set([
    'textfield',
    'textarea',
    'select',
    'radio',
    'checkbox',
    'number',
    'email',
    'phonenumber',
    'datetime',
    'day',
    'button',
    'panel',
    'columns',
    'fieldset',
    'container',
  ]);
  if (allowed.has(normalized)) return normalized;
  return 'textfield';
}

function sanitizeComponent(component: any, index: number) {
  const c = component && typeof component === 'object' ? component : {};
  const labelFromInput = typeof c['label'] === 'string' ? c['label'] : '';
  const keyFromInput = typeof c['key'] === 'string' ? c['key'] : '';
  const label = labelFromInput || keyFromInput || `Field ${index + 1}`;
  const key = keyFromInput || toSafeKey(label);
  const type = normalizeComponentType(c['type']);
  const out: any = { ...c, key, label, type };
  const validate = c['validate'] && typeof c['validate'] === 'object' ? { ...c['validate'] } : {};
  if ('required' in validate) validate['required'] = toBool(validate['required']);
  out['validate'] = validate;
  if (type === 'select' || type === 'radio') {
    const rawData = c['data'] && typeof c['data'] === 'object' ? { ...c['data'] } : {};
    const rawValues = Array.isArray(rawData['values']) ? rawData['values'] : [];
    rawData['values'] = rawValues
      .filter((item: any) => item && typeof item === 'object')
      .map((entry: any) => {
        const value = String(entry['value'] ?? entry['label'] ?? 'option');
        const labelValue = String(entry['label'] ?? value);
        return { label: labelValue, value };
      });
    if (rawData['values'].length === 0) rawData['values'] = [{ label: 'Option 1', value: 'option_1' }];
    out['data'] = rawData;
  }
  if (Array.isArray(c['components'])) out['components'] = c['components'].map((child: any, ci: number) => sanitizeComponent(child, ci));
  if (type === 'columns' && Array.isArray(c['columns'])) {
    out['columns'] = c['columns']
      .filter((col: any) => col && typeof col === 'object')
      .map((col: any) => {
        const colObj = { ...col };
        const colComponents = Array.isArray(colObj['components']) ? colObj['components'] : [];
        colObj['components'] = colComponents.map((child: any, childIndex: number) => sanitizeComponent(child, childIndex));
        return colObj;
      });
  }
  return out;
}

function sanitizeFormsForFormio(plan: any) {
  const forms = Array.isArray(plan?.forms) ? plan.forms : [];
  return forms.map((form: any, formIndex: number) => {
    const safeId = typeof form?.id === 'string' && form.id.trim() ? form.id.trim() : `generated_form_${formIndex + 1}`;
    const components = Array.isArray(form?.components) ? form.components.map((component: any, ci: number) => sanitizeComponent(component, ci)) : [];
    return { id: safeId, components };
  });
}

function validatePlan(plan: any) {
  if (!plan) return 'No plan generated.';
  const types = (plan.activities || []).map((a: any) => a.type);
  const issues: string[] = [];
  if (!types.includes('start')) issues.push('Missing Start Activity');
  if (!types.includes('finish')) issues.push('Missing Finish Activity');
  if (issues.length > 0) return issues.join('; ');
  return 'Valid';
}

function buildActivities(builder: WorkflowBuilder, activities: any[]) {
  const idMap: Record<string, string> = {};
  for (const spec of activities || []) {
    const attrs = spec.attributes || {};
    let activity: any = null;
    if (spec.type === 'start') activity = new StartActivity(String(attrs['form_id'] ?? ''), attrs['resource_name_override'] ? String(attrs['resource_name_override']) : undefined);
    else if (spec.type === 'user') activity = new UserActivity(String(attrs['form_id'] ?? ''), attrs['addressee'] ? String(attrs['addressee']) : undefined, attrs['ontimeout'] ? String(attrs['ontimeout']) : undefined);
    else if (spec.type === 'rest') activity = new RestActivity(String(attrs['method'] ?? ''), String(attrs['apiUrl'] ?? ''), String(attrs['authType'] ?? ''));
    else if (spec.type === 'entity') activity = new EntityActivity(attrs['entity_type'] ? String(attrs['entity_type']) : undefined, attrs['operation'] ? String(attrs['operation']) : undefined, attrs['deleteobject'] ? Boolean(attrs['deleteobject']) : false);
    else if (spec.type === 'condition') activity = new ConditionActivity(String(attrs['expression'] ?? ''));
    else if (spec.type === 'log') activity = new LogActivity(attrs['message'] ? String(attrs['message']) : undefined, attrs['comment'] ? String(attrs['comment']) : undefined);
    else if (spec.type === 'finish') activity = new FinishActivity(attrs['setnotify'] ? String(attrs['setnotify']) : undefined);
    if (activity) idMap[spec.id] = builder.addActivity(activity);
  }
  return idMap;
}

function generateFolderName(request: string) {
  const r = request.toLowerCase();
  if (r.includes('laptop')) return 'laptop-request';
  if (r.includes('onboard')) return 'onboarding';
  if (r.includes('terminat')) return 'termination';
  if (r.includes('emergency')) return 'emergency-access';
  if (r.includes('access')) return 'access-workflow';
  if (r.includes('request')) return 'request-workflow';
  if (r.includes('approval')) return 'approval-workflow';
  return r.replace(/[^a-z0-9\s-_]/g, '').replace(/\s+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'workflow';
}

// Mermaid shape per activity type
const MERMAID_SHAPES: Record<string, [string, string]> = {
  'start':        ['([', '])'],
  'finish':       ['([', '])'],
  'user':         ['[', ']'],
  'rest':         ['[(', ')]'],
  'entity':       ['[(', ')]'],
  'condition':    ['{', '}'],
  'log':          ['[/', '/]'],
  'notification': ['[[', ']]'],
};

function safeNodeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

function generateMermaidDiagram(request: string, plan: any): string {
  const activities: any[] = Array.isArray(plan?.activities) ? plan.activities : [];
  const flows: any[] = Array.isArray(plan?.flows) ? plan.flows : [];

  if (activities.length === 0) {
    return `# Workflow Flow Diagram\n\n> No activities found in the generated plan.\n`;
  }

  const lines: string[] = ['flowchart TD'];

  // Emit node definitions
  for (const act of activities) {
    const id = safeNodeId(String(act.id || 'unknown'));
    const label = String(act.name || act.id || act.type || 'Step').replace(/"/g, "'");
    const type = String(act.type || '').toLowerCase();
    const [open, close] = MERMAID_SHAPES[type] ?? ['[', ']'];
    lines.push(`    ${id}${open}"${label}"${close}`);
  }

  lines.push('');

  // Emit edges
  for (const flow of flows) {
    const src = safeNodeId(String(flow.source || ''));
    const tgt = safeNodeId(String(flow.target || ''));
    if (!src || !tgt) continue;
    const label = flow.label ? ` -->|"${String(flow.label).replace(/"/g, "'")}"| ` : ' --> ';
    lines.push(`    ${src}${label}${tgt}`);
  }

  // Add styling classes
  lines.push('');
  lines.push('    classDef startFinish fill:#4CAF50,stroke:#388E3C,color:#fff');
  lines.push('    classDef userTask fill:#2196F3,stroke:#1565C0,color:#fff');
  lines.push('    classDef serviceTask fill:#FF9800,stroke:#E65100,color:#fff');
  lines.push('    classDef conditionTask fill:#9C27B0,stroke:#6A1B9A,color:#fff');
  lines.push('    classDef logTask fill:#607D8B,stroke:#37474F,color:#fff');

  const startIds = activities.filter((a) => a.type === 'start' || a.type === 'finish').map((a) => safeNodeId(a.id));
  const userIds = activities.filter((a) => a.type === 'user').map((a) => safeNodeId(a.id));
  const serviceIds = activities.filter((a) => ['rest', 'entity', 'notification'].includes(a.type)).map((a) => safeNodeId(a.id));
  const condIds = activities.filter((a) => a.type === 'condition').map((a) => safeNodeId(a.id));
  const logIds = activities.filter((a) => a.type === 'log').map((a) => safeNodeId(a.id));

  if (startIds.length) lines.push(`    class ${startIds.join(',')} startFinish`);
  if (userIds.length) lines.push(`    class ${userIds.join(',')} userTask`);
  if (serviceIds.length) lines.push(`    class ${serviceIds.join(',')} serviceTask`);
  if (condIds.length) lines.push(`    class ${condIds.join(',')} conditionTask`);
  if (logIds.length) lines.push(`    class ${logIds.join(',')} logTask`);

  const mermaidBlock = ['```mermaid', ...lines, '```'].join('\n');

  return [
    `# Workflow Flow Diagram`,
    ``,
    `> Generated from request: _${request}_`,
    ``,
    mermaidBlock,
    ``,
    `## Activity Legend`,
    ``,
    `| Shape | Colour | Activity Type |`,
    `|-------|--------|---------------|`,
    `| Stadium \`([ ])\` | Green | Start / Finish |`,
    `| Rectangle \`[ ]\` | Blue | User Task (Approval/Form) |`,
    `| Cylinder \`[( )]\` | Orange | REST / Entity (Service Task) |`,
    `| Diamond \`{ }\` | Purple | Condition (Branch) |`,
    `| Parallelogram \`[/ /]\` | Grey | Log / Audit |`,
  ].join('\n');
}

export async function runWorkflowAgent(request: string, modelId: string) {
  // ── Round 1: Deep understanding ──────────────────────────────────────────────
  const understanding = await generateJson(modelId, buildUnderstandingPrompt(request));

  // ── Round 2: Activity type selection ─────────────────────────────────────────
  const toolSelection = await generateJson(modelId, buildToolSelectorPrompt(understanding));

  // ── Round 3: Detailed activity design (IDs, attributes, forms) ───────────────
  const activityDetail = await generateJson(
    modelId,
    buildActivityDetailPrompt(request, understanding, toolSelection),
    PLANNING_SYSTEM_PROMPT,
  );
  const designedActivities: any[] = Array.isArray(activityDetail?.activities) ? activityDetail.activities : [];
  const designedForms: any[] = Array.isArray(activityDetail?.forms) ? activityDetail.forms : [];

  // ── Round 4: Flow design ──────────────────────────────────────────────────────
  const flowDesign = await generateJson(
    modelId,
    buildFlowDesignPrompt(understanding, designedActivities),
  );
  const designedFlows: any[] = Array.isArray(flowDesign?.flows) ? flowDesign.flows : [];

  // ── Round 5: Final plan assembly ──────────────────────────────────────────────
  let plan = await generateJson(
    modelId,
    buildPlanningPrompt(request, understanding, designedActivities, designedFlows, designedForms),
    PLANNING_SYSTEM_PROMPT,
  );

  // ── Round 6: Self-critique ────────────────────────────────────────────────────
  const critiqueResult = await generateJson(modelId, buildCritiquePrompt(request, plan));

  // ── Round 7: Conditional revision ────────────────────────────────────────────
  let wasRevised = false;
  if (critiqueResult?.needs_revision === true) {
    const revised = await generateJson(
      modelId,
      buildRevisionPrompt(request, plan, critiqueResult),
      PLANNING_SYSTEM_PROMPT,
    );
    if (revised && Array.isArray(revised.activities)) {
      plan = revised;
      wasRevised = true;
    }
  }

  // ── Build the workflow ────────────────────────────────────────────────────────
  const validationResult = validatePlan(plan);
  const builder = new WorkflowBuilder();
  const sanitizedForms = sanitizeFormsForFormio(plan);
  if (sanitizedForms.length > 0) {
    for (const form of sanitizedForms) builder.addForm(form.id, form.components || []);
  }
  const idMap = buildActivities(builder, plan?.activities || []);
  for (const flow of plan?.flows || []) {
    const source = idMap[flow.source];
    const target = idMap[flow.target];
    if (source && target) builder.addFlow(source, target);
  }

  // ── Generate Mermaid diagram from the final plan ──────────────────────────────
  const mermaidMd = generateMermaidDiagram(request, plan);

  const folderName = generateFolderName(request);
  return {
    workflowXml: builder.generateXml(),
    formsJson: builder.generateFormsJson(),
    mermaidMd,
    critique: validationResult,
    plan,
    folderName,
    agentInsights: {
      understanding,
      toolSelection,
      qualityScore: critiqueResult?.score ?? null,
      qualityIssues: critiqueResult?.issues ?? [],
      wasRevised,
    },
  };
}
