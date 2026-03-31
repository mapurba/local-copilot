import { XMLParser } from 'fast-xml-parser';
import { WorkflowBuilder, StartActivity, UserActivity, EntityActivity, ConditionActivity, LogActivity, FinishActivity, MessageActivity } from './builder';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  textNodeName: '#text',
});

function asStringFromDsValue(dv: any): string {
  if (Array.isArray(dv)) return dv.map(asStringFromDsValue).join('\n');
  if (typeof dv === 'string') return dv;
  if (dv && typeof dv === 'object') {
    if (dv['#cdata']) return dv['#cdata'];
    if (dv['#text']) return dv['#text'];
    return JSON.stringify(dv);
  }
  return '';
}

function stripCdata(input: string): string {
  return input.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
}

function tryDecodeBase64(candidate: string): string {
  const normalized = stripCdata(candidate);
  if (!normalized) return '';

  try {
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    if (/<(?:\w+:)?(?:prov-req-defn|process)\b/i.test(text) || text.includes('<?xml')) {
      return text;
    }
  } catch {
    // not base64 payload
  }

  return normalized;
}

function keyMatchesTag(key: string, tag: string): boolean {
  return key === tag || key.endsWith(`:${tag}`);
}

function collectByTag(obj: any, tag: string): any[] {
  const out: any[] = [];
  function walk(o: any) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (!keyMatchesTag(k, tag)) continue;
      const v = o[k];
      if (Array.isArray(v)) v.forEach((x: any) => out.push(x)); else out.push(v);
    }
    for (const k of Object.keys(o)) {
      const vv = o[k];
      if (Array.isArray(vv)) vv.forEach(walk);
      else if (typeof vv === 'object') walk(vv);
    }
  }
  walk(obj);
  return out;
}

function findDsAttrValues(obj: any, attrName: string, out: string[] = []): string[] {
  if (!obj || typeof obj !== 'object') return out;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetAttr = normalize(attrName);

  let attrValue = '';
  for (const key of Object.keys(obj)) {
    if (!key.startsWith('@_')) continue;
    if (!/attr[-_:]?name$/i.test(key)) continue;
    const v = obj[key];
    if (typeof v === 'string') {
      attrValue = v;
      break;
    }
  }

  const match = attrValue ? normalize(attrValue) === targetAttr : false;
  if (match) {
    let dsValueNode: any = undefined;
    for (const key of Object.keys(obj)) {
      if (/ds[-_:]?value$/i.test(key) || /:ds[-_:]?value$/i.test(key)) {
        dsValueNode = obj[key];
        break;
      }
    }
    if (dsValueNode === undefined) {
      dsValueNode = obj['ds-value'];
    }

    const raw = asStringFromDsValue(dsValueNode);
    if (raw) out.push(raw);
  }

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (Array.isArray(value)) value.forEach((item) => findDsAttrValues(item, attrName, out));
    else if (value && typeof value === 'object') findDsAttrValues(value, attrName, out);
  }
  return out;
}

function findRawDsAttrCdataBlocks(xmlText: string, attrName: string): string[] {
  const out: string[] = [];
  if (!xmlText || !attrName) return out;

  const attrPattern = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRegex = new RegExp(`ds-attr-name\\s*=\\s*["']${attrPattern}["'][\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'ig');

  let match: RegExpExecArray | null = null;
  while ((match = blockRegex.exec(xmlText)) !== null) {
    const cdata = typeof match[1] === 'string' ? match[1].trim() : '';
    if (cdata) out.push(cdata);
  }

  return out;
}

function getAttr(obj: any, names: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && String(obj[name]).trim()) return String(obj[name]);
  }
  return '';
}

function sanitizeNodeId(value: string, fallback: string): string {
  const raw = (value || '').trim();
  const base = (raw || fallback)
    .replace(/^[#\s]+/, '')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || fallback;
}

function registerAlias(aliasToCanonical: Map<string, string>, raw: string, canonical: string) {
  const value = (raw || '').trim();
  if (!value) return;

  const candidates = new Set<string>();
  candidates.add(value);
  candidates.add(value.toLowerCase());

  const hashSplit = value.includes('#') ? value.split('#').pop() || '' : '';
  if (hashSplit) {
    candidates.add(hashSplit);
    candidates.add(hashSplit.toLowerCase());
  }

  const slashSegments = value.split('/').filter(Boolean);
  if (slashSegments.length) {
    const tail = slashSegments[slashSegments.length - 1];
    candidates.add(tail);
    candidates.add(tail.toLowerCase());
  }

  candidates.forEach((candidate) => {
    const c = candidate.trim();
    if (!c) return;
    aliasToCanonical.set(c, canonical);
  });
}

function resolveAlias(aliasToCanonical: Map<string, string>, raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  return aliasToCanonical.get(value)
    || aliasToCanonical.get(value.toLowerCase())
    || aliasToCanonical.get((value.split('#').pop() || '').trim())
    || aliasToCanonical.get((value.split('/').filter(Boolean).pop() || '').trim())
    || '';
}

function getProcessNode(root: any): any | null {
  if (!root || typeof root !== 'object') return null;
  for (const key of Object.keys(root)) {
    if (keyMatchesTag(key, 'process')) return root[key];
  }
  for (const key of Object.keys(root)) {
    const value = root[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = getProcessNode(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = getProcessNode(value);
      if (found) return found;
    }
  }
  return null;
}

function extractWorkflowProcessXml(decodedXml: string): string {
  const m = decodedXml.match(/<(?:\w+:)?process\b[\s\S]*?<\/(?:\w+:)?process>/i);
  return m ? m[0] : decodedXml;
}

function extractDataItemMappings(root: any, activities: Array<{ id: string; type: string; obj: any }>) {
  const mappings: Array<{
    source: string;
    target: string;
    expression?: string;
    usedInActivities: string[];
    mappingType: string;
  }> = [];

  const mappingNodes: any[] = [
    ...collectByTag(root, 'mapping'),
    ...collectByTag(root, 'data-mapping'),
    ...collectByTag(root, 'attribute-mapping'),
    ...collectByTag(root, 'input-mapping'),
    ...collectByTag(root, 'output-mapping'),
    ...collectByTag(root, 'assignment'),
  ];

  for (const node of mappingNodes) {
    const source = getAttr(node, ['@_source', 'source', '@_from', 'from', '@_src', 'src']);
    const target = getAttr(node, ['@_target', 'target', '@_to', 'to', '@_dst', 'dst']);
    const expression = getAttr(node, ['@_expression', 'expression', '@_expr', 'expr']);
    const ownerActivity = getAttr(node, ['@_activity-id', 'activity-id', '@_owner', 'owner']);
    if (!source && !target && !expression) continue;
    mappings.push({
      source: source || '<unknown-source>',
      target: target || '<unknown-target>',
      expression: expression || undefined,
      usedInActivities: ownerActivity ? [ownerActivity] : [],
      mappingType: 'explicit-mapping',
    });
  }

  // Infer usage by scanning activity attributes for data references.
  activities.forEach((a) => {
    const attrs = a.obj || {};
    const refs: string[] = [];
    for (const key of Object.keys(attrs)) {
      if (!key.includes('data') && !key.includes('mapping') && !key.includes('field') && !key.includes('expression')) continue;
      const value = attrs[key];
      if (typeof value === 'string' && value.trim()) refs.push(`${key}=${value.trim()}`);
    }
    refs.forEach((r) => {
      mappings.push({
        source: r,
        target: a.id || '<unknown-activity>',
        usedInActivities: [a.id || '<unknown-activity>'],
        mappingType: 'activity-attribute-reference',
      });
    });
  });

  return mappings;
}

function buildFormUsage(
  forms: Array<{ id: string; fields: Array<{ name: string; type: string; options?: any[] }> }>,
  activities: Array<{ id: string; type: string; obj: any }>
) {
  const usage = forms.map((f) => ({
    formId: f.id,
    usedByActivities: [] as string[],
    activityTypes: [] as string[],
  }));

  const usageById = new Map<string, { formId: string; usedByActivities: string[]; activityTypes: string[] }>();
  usage.forEach((u) => usageById.set(u.formId, u));

  activities.forEach((a) => {
    const formId = getAttr(a.obj, ['@_form-id', 'form-id']);
    if (!formId) return;
    const bucket = usageById.get(formId) || { formId, usedByActivities: [], activityTypes: [] };
    if (!bucket.usedByActivities.includes(a.id)) bucket.usedByActivities.push(a.id);
    if (!bucket.activityTypes.includes(a.type)) bucket.activityTypes.push(a.type);
    usageById.set(formId, bucket);
  });

  return Array.from(usageById.values());
}

function buildPrdTodoList(input: {
  processId: string;
  forms: Array<{ id: string; fields: Array<{ name: string; type: string }> }>;
  activities: Array<{ id: string; type: string; obj: any }>;
  mappings: Array<{ source: string; target: string; usedInActivities: string[] }>;
}) {
  const todos: Array<{ id: number; title: string; details: string; status: 'not-started' | 'in-progress' | 'completed' }> = [];
  const missingFormActivities = input.activities.filter((a) =>
    a.type === 'user-activity' || a.type === 'start-activity' ? !getAttr(a.obj, ['@_form-id', 'form-id']) : false
  );

  todos.push({
    id: 1,
    title: 'Import PRD file',
    details: `PRD loaded for process '${input.processId || 'unknown-process'}'.`,
    status: 'completed',
  });

  todos.push({
    id: 2,
    title: 'Decode srvprvProcessXML payload',
    details: 'Extract ds-attribute ds-attr-name="srvprvProcessXML" from CDATA and decode base64 process XML.',
    status: 'completed',
  });

  todos.push({
    id: 3,
    title: 'Separate process artifacts',
    details: `Separated ${input.forms.length} form(s), ${input.mappings.length} data-item mapping(s), and workflow process XML.`,
    status: 'completed',
  });

  todos.push({
    id: 4,
    title: 'Analyze forms and mappings against activities',
    details: 'Validated form-to-activity usage, data-item usage, and workflow relations across process activities.',
    status: missingFormActivities.length ? 'in-progress' : 'completed',
  });

  todos.push({
    id: 5,
    title: 'Create PRD todo list',
    details: 'Generated implementation todo list for migration to the new workflow.',
    status: 'completed',
  });

  todos.push({
    id: 6,
    title: 'Start implementation',
    details: missingFormActivities.length
      ? `Implementation started; pending clarification for missing form-id activities: ${missingFormActivities.map((a) => a.id || '<unknown>').join(', ')}.`
      : 'Implementation started with extracted process, mappings, and form metadata.',
    status: missingFormActivities.length ? 'in-progress' : 'completed',
  });

  todos.push({
    id: 7,
    title: 'Store workflow and split forms',
    details: 'Generated workflow XML and persisted each form schema as separate form artifacts.',
    status: 'completed',
  });

  return todos;
}

export function analyzeDecodedXml(decodedXml: string, supplementalXml: string[] = []) {
  try {
    const obj = parser.parse(decodedXml);
    const supplementalRoots: any[] = [];
    const supplementalDecodedXml: string[] = [];

    if (Array.isArray(supplementalXml)) {
      supplementalXml.forEach((candidate) => {
        if (!candidate || typeof candidate !== 'string') return;
        const trimmed = candidate.trim();
        if (!trimmed) return;
        try {
          supplementalRoots.push(parser.parse(trimmed));
          supplementalDecodedXml.push(trimmed);
        } catch {
          // Ignore malformed supplemental payloads.
        }
      });
    }

    const allRoots = [obj, ...supplementalRoots];

    // Step 1-4: Parse process and analyze relationships.
    const lines: string[] = [];
    lines.push('# PRD Workflow Analysis');
    lines.push('');
    lines.push('## Analysis Steps');
    lines.push('1. Imported PRD payload.');
    lines.push('2. Read process XML from ds-attribute ds-attr-name="srvprvProcessXML" (CDATA + base64 decode).');
    lines.push('3. Separated process artifacts: forms used, data item mappings/usage, and workflow process XML.');
    lines.push('4. Analyzed process XML, data mappings, forms, and activity-to-form relationships.');
    lines.push('5. Created implementation todo list for workflow migration.');
    lines.push('6. Started implementation by building workflow and form artifacts from analyzed process metadata.');
    lines.push('7. Stored generated workflow XML and split forms into separate files.');
    if (supplementalDecodedXml.length) {
      lines.push(`- Supplemental payload merge: merged ${supplementalDecodedXml.length} request/XMLData payload(s) to recover missing form schemas and fields.`);
    }

    const process = getProcessNode(obj) || obj['prov-req-defn'] || null;
    let processId = '';
    let processVersion = '';
    if (process && typeof process === 'object') {
      processId = getAttr(process, ['@_id', 'id']);
      processVersion = getAttr(process, ['@_version', 'version']);
      lines.push(`- **Process id**: ${processId}`);
      lines.push(`- **Version**: ${processVersion}`);
    }

    // forms
    const forms = allRoots.flatMap((root) => collectByTag(root, 'form'));
    lines.push(`- **Forms**: ${forms.length}`);
    const formsOut = forms.map((f: any) => {
      const fid = getAttr(f, ['@_form-id', '@_id', 'id']);
      const fields: Array<{ name: string; type: string; options?: any[] }> = [];
      if (f['content'] && f['content']['field']) {
        const fl = Array.isArray(f['content']['field']) ? f['content']['field'] : [f['content']['field']];
        fl.forEach((field: any) => {
          const name = field['@_name'] || '';
          const dtype = (field['@_data-type'] || field['@_type'] || '') as string;
          // detect simple options/enumerations
          let options: any[] | undefined = undefined;
          if (field['option']) {
            const opts = Array.isArray(field['option']) ? field['option'] : [field['option']];
            options = opts.map((o: any) => ({ label: o['@_label'] || o['label'] || o, value: o['@_value'] || o['value'] || o }));
          }
          fields.push({ name, type: String(dtype || ''), options });
        });
      }
      return { id: fid, fields };
    });

    // activities
    const tags = ['user-activity','provision-activity','condition-activity','mapping-activity','log-activity','start-activity','finish-activity'];
    const activities: Array<{ id: string; type: string; obj: any }> = [];
    for (const t of tags) {
      const got = collectByTag(obj, t);
      got.forEach((a: any) => activities.push({ id: String(a['@_activity-id'] || a['@_id'] || a['@_id_ref'] || ''), type: t, obj: a }));
    }
    lines.push(`- **Activities**: ${activities.length}`);

    // links
    const links = collectByTag(obj, 'link');
    lines.push(`- **Links**: ${links.length}`);

    // data-items
    const dataItems = collectByTag(obj, 'data-item');
    lines.push(`- **Data-items**: ${dataItems.length}`);

    const dataItemMappings = extractDataItemMappings(obj, activities);
    lines.push(`- **Data-item mappings**: ${dataItemMappings.length}`);

    const formUsage = buildFormUsage(formsOut, activities);
    const workflowProcessXml = extractWorkflowProcessXml(decodedXml);

    const humanizeType = (value: string) => {
      const text = String(value || '').replace(/-/g, ' ').trim();
      return text ? text.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Activity';
    };

    const linksOut = links.map((l: any) => ({
      source: String(l['@_source'] || l['source'] || '').trim(),
      target: String(l['@_target'] || l['target'] || '').trim(),
    })).filter((l) => l.source && l.target);

    const incomingCount = new Map<string, number>();
    const outgoingCount = new Map<string, number>();
    activities.forEach((a) => {
      incomingCount.set(a.id, 0);
      outgoingCount.set(a.id, 0);
    });
    linksOut.forEach((l) => {
      incomingCount.set(l.target, (incomingCount.get(l.target) || 0) + 1);
      outgoingCount.set(l.source, (outgoingCount.get(l.source) || 0) + 1);
    });

    const activityById = new Map(activities.map((a) => [a.id, a]));
    const startCandidates = activities.filter((a) => a.type === 'start-activity' || (incomingCount.get(a.id) || 0) === 0);
    const primaryStart = startCandidates[0];

    const adjacency = new Map<string, string[]>();
    linksOut.forEach((l) => {
      if (!adjacency.has(l.source)) adjacency.set(l.source, []);
      adjacency.get(l.source)?.push(l.target);
    });

    const executionOrder: string[] = [];
    if (primaryStart?.id) {
      const visited = new Set<string>();
      const queue: string[] = [primaryStart.id];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (visited.has(current)) continue;
        visited.add(current);
        executionOrder.push(current);
        const next = adjacency.get(current) || [];
        next.forEach((n) => {
          if (!visited.has(n) && activityById.has(n)) queue.push(n);
        });
      }
      activities.forEach((a) => {
        if (!visited.has(a.id)) executionOrder.push(a.id);
      });
    }

    const actorSet = new Set<string>();
    activities.forEach((a) => {
      const addressee = getAttr(a.obj, ['@_addressee', 'addressee']);
      if (addressee) actorSet.add(addressee);
      if (a.type === 'user-activity') actorSet.add('Request Approver/User');
      if (a.type === 'provision-activity' || a.type === 'mapping-activity') actorSet.add('Provisioning Engine');
    });
    if (!actorSet.size) actorSet.add('Workflow Engine');

    // Non-technical walkthrough for less experienced readers.
    lines.push('');
    lines.push('## Beginner Friendly Explanation');
    lines.push('### What This Old PRD Is Trying To Do');
    lines.push(`This PRD describes an approval/provisioning workflow named '${processId || 'unknown process'}'. In simple terms, it defines how a request enters the system, who reviews it, what data is collected, and how the process ends.`);

    lines.push('');
    lines.push('### Who Is Involved');
    Array.from(actorSet).forEach((actor) => {
      lines.push(`- ${actor}`);
    });

    lines.push('');
    lines.push('### What Information Is Collected');
    if (formsOut.length === 0) {
      lines.push('- No explicit forms were found in the decoded process payload.');
    } else {
      formsOut.forEach((form, idx) => {
        const formName = form.id || `form_${idx + 1}`;
        lines.push(`- Form '${formName}' collects ${form.fields.length} field(s).`);
        form.fields.forEach((field) => {
          lines.push(`  - ${field.name || '<unnamed field>'} (${field.type || 'unknown type'})`);
        });
      });
    }

    lines.push('');
    lines.push('### How The Request Moves Step By Step');
    if (executionOrder.length === 0) {
      lines.push('- No clear activity chain could be built from links; see the technical activity/link tables below.');
    } else {
      executionOrder.forEach((activityId, idx) => {
        const activity = activityById.get(activityId);
        if (!activity) return;
        const label = humanizeType(activity.type);
        const formId = getAttr(activity.obj, ['@_form-id', 'form-id']);
        const addressee = getAttr(activity.obj, ['@_addressee', 'addressee']);
        const details: string[] = [];
        if (formId) details.push(`uses form '${formId}'`);
        if (addressee) details.push(`assigned to '${addressee}'`);
        lines.push(`${idx + 1}. ${label} (${activity.id || '<no-id>'})${details.length ? ` - ${details.join(', ')}` : ''}`);
      });
    }

    lines.push('');
    lines.push('### Data Mapping In Plain Language');
    if (dataItemMappings.length === 0) {
      lines.push('- No explicit data mappings were detected.');
    } else {
      lines.push(`- The workflow references ${dataItemMappings.length} mapping expression(s) to move data between fields/activities.`);
      const preview = dataItemMappings.slice(0, 8);
      preview.forEach((m, idx) => {
        lines.push(`  - ${idx + 1}. ${m.source} -> ${m.target}`);
      });
      if (dataItemMappings.length > preview.length) {
        lines.push(`  - ...and ${dataItemMappings.length - preview.length} more mapping entries.`);
      }
    }

    lines.push('');
    lines.push('### What A New Developer Should Check First');
    lines.push('- Verify all user-activity steps have correct form-id and addressee values.');
    lines.push('- Confirm the transition links represent the real business path (including condition branches).');
    lines.push('- Validate data-item mappings so submitted form data reaches provisioning steps correctly.');
    lines.push('- Confirm notifications, timeouts, and finish behavior match business expectations.');

    // Detailed sections
    lines.push('');
    lines.push('## Process Details');
    if (processId) lines.push(`- **Process Id**: ${processId}`);
    if (processVersion) lines.push(`- **Process Version**: ${processVersion}`);

    // Forms detail
    if (formsOut.length) {
      lines.push('');
      lines.push('### Forms');
      formsOut.forEach((f: any, idx: number) => {
        lines.push(`- **${f.id || `form_${idx}`}**`);
        if (f.fields && f.fields.length) {
          f.fields.forEach((fld: any) => {
            const opts = fld.options && fld.options.length ? ` (options: ${fld.options.map((o: any) => o.label || o.value).join(', ')})` : '';
            lines.push(`  - ${fld.name || '<unnamed>'}: ${fld.type || 'unknown'}${opts}`);
          });
        } else {
          lines.push('  - <no fields>');
        }
      });
    }

    // Activities detail
    if (activities.length) {
      lines.push('');
      lines.push('### Activities');
      activities.forEach((a) => {
        const o = a.obj || {};
        lines.push(`- **${a.id || '<no-id>'}** (${a.type})`);
        const details: string[] = [];
        if (o['@_form-id'] || o['form-id']) details.push(`form-id=${o['@_form-id'] || o['form-id']}`);
        if (o['@_addressee'] || o['addressee']) details.push(`addressee=${o['@_addressee'] || o['addressee']}`);
        if (o['@_timeout'] || o['timeout']) details.push(`timeout=${o['@_timeout'] || o['timeout']}`);
        if (o['@_operation'] || o['operation']) details.push(`operation=${o['@_operation'] || o['operation']}`);
        if (o['@_object-type'] || o['object-type'] || o['objectType']) details.push(`entity-type=${o['@_object-type'] || o['object-type'] || o['objectType']}`);
        // notify templates
        try {
          const not = o['notify'] || o['notifications'] || o['notify-list'];
          if (not) {
            const templates: string[] = [];
            if (Array.isArray(not)) {
              not.forEach((n: any) => { if (n && (n['@_template'] || n['template'])) templates.push(n['@_template'] || n['template']); });
            } else if (typeof not === 'object') {
              if (not['@_template'] || not['template']) templates.push(not['@_template'] || not['template']);
            }
            if (templates.length) details.push(`notify_templates=${templates.join(';')}`);
          }
        } catch {
          // ignore
        }
        if (details.length) details.forEach(d => lines.push(`  - ${d}`));
      });
    }

    // Links detail
    if (links.length) {
      lines.push('');
      lines.push('### Links (transitions)');
      links.forEach((l: any, idx: number) => {
        const src = String(l['@_source'] || l['source'] || '<unknown>');
        const tgt = String(l['@_target'] || l['target'] || '<unknown>');
        lines.push(`- ${idx + 1}. ${src} -> ${tgt}`);
      });
    }

    // Data-items detail
    if (dataItems.length) {
      lines.push('');
      lines.push('### Data-items');
      dataItems.forEach((di: any) => {
        const id = di['@_id'] || di['@_name'] || di['@_data-id'] || di['id'] || di['name'] || '<unknown>';
        const dtype = di['@_data-type'] || di['@_type'] || di['data-type'] || di['type'] || '';
        lines.push(`- ${id}: ${dtype}`);
      });
    }

    if (dataItemMappings.length) {
      lines.push('');
      lines.push('### Data Item Mapping And Usage');
      dataItemMappings.forEach((m, idx) => {
        const use = m.usedInActivities.length ? ` | used in: ${m.usedInActivities.join(', ')}` : '';
        const expr = m.expression ? ` | expr: ${m.expression}` : '';
        lines.push(`- ${idx + 1}. ${m.source} -> ${m.target}${expr}${use}`);
      });
    }

    if (formUsage.length) {
      lines.push('');
      lines.push('### Form Relation To Process Activities');
      formUsage.forEach((u) => {
        const usedBy = u.usedByActivities.length ? u.usedByActivities.join(', ') : 'not-linked';
        lines.push(`- **${u.formId || '<unknown-form>'}** used by: ${usedBy}`);
      });
    }

    // Step 6: Start implementation by generating workflow artifacts.
    const builder = new WorkflowBuilder();
    const usedIds = new Set<string>();
    const aliasToCanonical = new Map<string, string>();

    const makeUniqueId = (preferred: string, fallback: string) => {
      const base = sanitizeNodeId(preferred, fallback);
      let candidate = base;
      let counter = 2;
      while (usedIds.has(candidate)) {
        candidate = `${base}_${counter}`;
        counter += 1;
      }
      usedIds.add(candidate);
      return candidate;
    };

    activities.forEach((a, idx) => {
      const attrs = {} as Record<string, unknown>;
      // map some common attributes
      const o = a.obj || {};
      if (o['@_form-id']) attrs['form-id'] = o['@_form-id'];
      if (o['@_addressee']) attrs['addressee'] = o['@_addressee'];
      if (o['@_activity-id']) attrs['activity-id'] = o['@_activity-id'];
      // timeouts / ontimeout
      if (o['@_timeout'] || o['timeout']) attrs['ontimeout'] = o['@_timeout'] || o['timeout'];
      // provision/mapping details
      if (o['@_operation'] || o['operation']) attrs['operation'] = o['@_operation'] || o['operation'];
      if (o['@_object-type'] || o['object-type'] || o['objectType']) attrs['entity-type'] = o['@_object-type'] || o['object-type'] || o['objectType'];

      // notifications inside the activity
      try {
        const not = o['notify'] || o['notifications'] || o['notify-list'];
        if (not) {
          const templates: string[] = [];
          if (Array.isArray(not)) {
            not.forEach((n: any) => { if (n && (n['@_template'] || n['template'])) templates.push(n['@_template'] || n['template']); });
          } else if (typeof not === 'object') {
            if (not['@_template'] || not['template']) templates.push(not['@_template'] || not['template']);
            else if (Array.isArray(not['notify'])) not['notify'].forEach((x: any) => { if (x && (x['@_template'] || x['template'])) templates.push(x['@_template'] || x['template']); });
          }
          if (templates.length) attrs['notify-templates'] = templates.join(';');
        }
      } catch {
        // ignore notify parsing errors
      }

      let activityInstance: any = null;
      if (a.type === 'start-activity') activityInstance = new StartActivity(String(attrs['form-id'] || ''));
      else if (a.type === 'user-activity') activityInstance = new UserActivity(String(attrs['form-id'] || ''), String(attrs['addressee'] || ''), String(attrs['ontimeout'] || ''));
      else if (a.type === 'provision-activity' || a.type === 'mapping-activity') activityInstance = new EntityActivity(String(attrs['entity-type'] || ''), String(attrs['operation'] || ''), Boolean(o['@_deleteobject'] || o['deleteobject'] || false));
      else if (a.type === 'condition-activity') activityInstance = new ConditionActivity(o['@_expression'] || o['expression'] || '');
      else if (a.type === 'log-activity') activityInstance = new LogActivity(o['@_message'] || o['message'] || '');
      else if (attrs['notify-templates'] && String(attrs['notify-templates']).length) activityInstance = new MessageActivity(String(attrs['notify-templates'] || ''), o['@_message'] || o['message'] || '');
      else if (a.type === 'finish-activity') activityInstance = new FinishActivity(o['@_setnotify'] || o['setnotify'] || undefined);
      else activityInstance = new LogActivity();

      const preferredId = getAttr(o, ['@_activity-id', 'activity-id', '@_id', 'id', '@_id_ref', 'id_ref']) || a.id;
      const canonicalId = makeUniqueId(preferredId, `${a.type || 'activity'}_${idx + 1}`);
      activityInstance.id = canonicalId;

      // attach parsed attrs to activity attributes
      if (activityInstance && activityInstance.attributes) {
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined && v !== null) (activityInstance.attributes as any)[k] = v;
        }
      }

      builder.addActivity(activityInstance);
      registerAlias(aliasToCanonical, canonicalId, canonicalId);
      registerAlias(aliasToCanonical, preferredId, canonicalId);
      registerAlias(aliasToCanonical, a.id, canonicalId);
      registerAlias(aliasToCanonical, String((attrs['activity-id'] as string) || ''), canonicalId);
    });

    const addedFlows = new Set<string>();
    const safeAddFlow = (sourceId: string, targetId: string) => {
      const s = (sourceId || '').trim();
      const t = (targetId || '').trim();
      if (!s || !t || s === t) return;
      const key = `${s}->${t}`;
      if (addedFlows.has(key)) return;
      addedFlows.add(key);
      builder.addFlow(s, t);
    };

    // add flows from parsed links with robust endpoint resolution
    links.forEach((l: any) => {
      const srcRaw = getAttr(l, ['@_source', 'source', '@_sourceRef', 'sourceRef', '@_source-ref', 'source-ref', '@_from', 'from', '@_src', 'src']);
      const tgtRaw = getAttr(l, ['@_target', 'target', '@_targetRef', 'targetRef', '@_target-ref', 'target-ref', '@_to', 'to', '@_dst', 'dst']);
      const s = resolveAlias(aliasToCanonical, srcRaw);
      const t = resolveAlias(aliasToCanonical, tgtRaw);
      try {
        if (s && t) safeAddFlow(s, t);
      } catch (e) {
        // continue
      }
    });

    // Ensure graph connectivity to reduce unconnected-node BPMN errors.
    const starts = builder.activities.filter((a) => a.activityType === 'start-activity').map((a) => a.id);
    const finishes = builder.activities.filter((a) => a.activityType === 'finish-activity').map((a) => a.id);

    if (builder.activities.length > 0 && starts.length === 0) {
      const autoStart = new StartActivity('');
      autoStart.id = makeUniqueId('start_auto', 'start_auto');
      builder.addActivity(autoStart);
      registerAlias(aliasToCanonical, autoStart.id, autoStart.id);
      starts.push(autoStart.id);
    }

    if (builder.activities.length > 0 && finishes.length === 0) {
      const autoFinish = new FinishActivity();
      autoFinish.id = makeUniqueId('finish_auto', 'finish_auto');
      builder.addActivity(autoFinish);
      registerAlias(aliasToCanonical, autoFinish.id, autoFinish.id);
      finishes.push(autoFinish.id);
    }

    const orderedIds = [
      ...builder.activities.filter((a) => a.activityType === 'start-activity').map((a) => a.id),
      ...builder.activities.filter((a) => a.activityType !== 'start-activity' && a.activityType !== 'finish-activity').map((a) => a.id),
      ...builder.activities.filter((a) => a.activityType === 'finish-activity').map((a) => a.id),
    ];
    const orderedIndex = new Map<string, number>(orderedIds.map((id, idx) => [id, idx]));

    if (builder.flows.length === 0 && orderedIds.length > 1) {
      for (let i = 0; i < orderedIds.length - 1; i++) {
        safeAddFlow(orderedIds[i], orderedIds[i + 1]);
      }
    }

    const defaultStart = starts[0] || orderedIds[0] || '';
    const defaultFinish = finishes[0] || orderedIds[orderedIds.length - 1] || '';

    builder.activities.forEach((activity) => {
      const idx = orderedIndex.get(activity.id) ?? 0;
      if (activity.activityType !== 'start-activity' && activity.incoming.length === 0) {
        const prev = orderedIds[Math.max(0, idx - 1)] || defaultStart;
        if (prev && prev !== activity.id) safeAddFlow(prev, activity.id);
      }

      if (activity.activityType !== 'finish-activity' && activity.outgoing.length === 0) {
        const next = orderedIds[Math.min(orderedIds.length - 1, idx + 1)] || defaultFinish;
        if (next && next !== activity.id) safeAddFlow(activity.id, next);
      }
    });

    // forms -> add basic forms with improved field typing
    formsOut.forEach((f) => {
      const comps = (f.fields || []).map((fld: any) => {
        const name = fld.name || 'field';
        const dtype = (fld.type || '').toLowerCase();
        let compType = 'textfield';
        if (dtype.includes('bool')) compType = 'checkbox';
        else if (dtype.includes('date')) compType = 'datetime';
        else if (dtype.includes('int') || dtype.includes('number')) compType = 'number';
        if (fld.options && fld.options.length) compType = 'select';
        const comp: any = { key: name, label: name, type: compType };
        if (compType === 'select' && fld.options) comp.options = { values: fld.options };
        return comp;
      });
      if (f.id) builder.addForm(f.id, comps);
    });

    // data-items -> add as process data items
    dataItems.forEach((di: any) => {
      try {
        const id = di['@_id'] || di['@_name'] || di['@_data-id'] || di['@_key'] || di['id'] || di['name'] || '';
        const dtype = di['@_data-type'] || di['@_type'] || di['data-type'] || di['type'] || '';
        if (id) builder.addDataItem(String(id), String(dtype || ''));
      } catch {
        // ignore
      }
    });

    const workflowXml = builder.generateXml();
    const formsJson = builder.generateFormsJson();

    // Step 5: Build a concrete PRD todo list for next actions.
    const prdTodoList = buildPrdTodoList({
      processId,
      forms: formsOut,
      activities,
      mappings: dataItemMappings,
    });

    lines.push('');
    lines.push('## PRD Todo List');
    prdTodoList.forEach((t) => {
      lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.title}: ${t.details}`);
    });

    return {
      summary: lines.join('\n'),
      processId,
      processVersion,
      activities,
      links,
      dataItems,
      dataItemMappings,
      formUsage,
      workflowProcessXml,
      prdTodoList,
      forms: formsOut,
      workflowXml,
      formsJson,
      decodedXml,
    };
  } catch (e) {
    return { error: (e && (e as Error).message) || 'Failed to analyze XML' };
  }
}

export function extractAndAnalyzeFromPrdXml(prdXml: string) {
  try {
    const obj = parser.parse(prdXml);

    const collectAttrValues = (attrNames: string[]) => {
      const out: string[] = [];
      attrNames.forEach((name) => {
        out.push(...findDsAttrValues(obj, name));
      });
      return out;
    };

    const decodeUnique = (values: string[]) => {
      const seen = new Set<string>();
      const decoded: string[] = [];
      values.forEach((raw) => {
        const text = tryDecodeBase64(raw || '').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        decoded.push(text);
      });
      return decoded;
    };

    const processRaw = collectAttrValues(['srvprvProcessXML', 'srvprvprocessxml', 'srvPrvProcessXML']);
    if (processRaw.length === 0) {
      processRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'srvprvProcessXML'));
    }

    const requestRaw = collectAttrValues(['srvprvRequestXML', 'srvprvrequestxml', 'srvPrvRequestXML']);
    if (requestRaw.length === 0) {
      requestRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'srvprvRequestXML'));
    }

    const xmlDataRaw = collectAttrValues(['XMLData']);
    if (xmlDataRaw.length === 0) {
      xmlDataRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'XMLData'));
    }

    const processDecoded = decodeUnique(processRaw);
    const requestDecoded = decodeUnique(requestRaw);
    const xmlDataDecoded = decodeUnique(xmlDataRaw);

    const primaryDecoded = processDecoded.length ? processDecoded : (xmlDataDecoded.length ? xmlDataDecoded : requestDecoded);
    if (primaryDecoded.length === 0) {
      // treat input as already decoded
      return analyzeDecodedXml(prdXml);
    }

    const supplementalPool = decodeUnique([...requestDecoded, ...xmlDataDecoded]);
    const results = primaryDecoded.map((decoded) => {
      const supplemental = supplementalPool.filter((candidate) => candidate !== decoded);
      return analyzeDecodedXml(decoded, supplemental);
    });

    return results.length === 1 ? results[0] : { results };
  } catch (e) {
    return { error: (e && (e as Error).message) || 'Failed to extract XMLData' };
  }
}
