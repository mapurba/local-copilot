import { buildUnderstandingPrompt, buildToolSelectorPrompt, buildPlanningPrompt, PLANNING_SYSTEM_PROMPT } from './prompts';
import { generateJson } from './llm';
import { WorkflowBuilder, StartActivity, UserActivity, RestActivity, EntityActivity, ConditionActivity, LogActivity, FinishActivity, NotificationActivity, MessageActivity } from './builder';

function normalizeStringArray(value: any): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

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

export async function runWorkflowAgent(request: string, modelId: string) {
  const understanding = await generateJson(modelId, buildUnderstandingPrompt(request));
  const toolSelection = await generateJson(modelId, buildToolSelectorPrompt(understanding));
  const selectedTools = normalizeStringArray(toolSelection?.selected_tools);
  const plan = await generateJson(modelId, buildPlanningPrompt(request, understanding, selectedTools), PLANNING_SYSTEM_PROMPT);
  const critique = validatePlan(plan);
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
  const folderName = generateFolderName(request);
  return {
    workflowXml: builder.generateXml(),
    formsJson: builder.generateFormsJson(),
    critique,
    plan,
    folderName,
  };
}
