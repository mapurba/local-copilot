import { XMLParser } from 'fast-xml-parser';
import { WorkflowBuilder, StartActivity, UserActivity, EntityActivity, ConditionActivity, LogActivity, FinishActivity, MessageActivity } from './builder';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  textNodeName: '#text',
});

function tryDecode(candidate: string | undefined | null): string {
  if (!candidate) return '';
  let s = candidate;
  s = s.replace(/^<!\[CDATA\[|\]\]>$/g, '');
  s = s.trim();
  try {
    const buf = Buffer.from(s, 'base64');
    const text = buf.toString('utf8');
    if (text.includes('<prov-req-defn') || text.includes('<process') || text.includes('<?xml')) {
      return text;
    }
  } catch (e) {
    // ignore
  }
  return s;
}

function findXmlDataObjects(obj: any, results: any[] = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (obj['@_ds-attr-name'] === 'XMLData') {
    const dv = obj['ds-value'];
    if (dv) results.push(dv);
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) v.forEach((item) => findXmlDataObjects(item, results));
    else if (typeof v === 'object') findXmlDataObjects(v, results);
  }
  return results;
}

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

function collectByTag(obj: any, tag: string): any[] {
  const out: any[] = [];
  function walk(o: any) {
    if (!o || typeof o !== 'object') return;
    if (o[tag]) {
      const v = o[tag];
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

export function analyzeDecodedXml(decodedXml: string) {
  try {
    const obj = parser.parse(decodedXml);

    // summary text (simple)
    const lines: string[] = [];
    lines.push('# Workflow Summary');

    // process id/version
    function findProcess(o: any): any | null {
      if (!o || typeof o !== 'object') return null;
      if (o['process']) return o['process'];
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (Array.isArray(v)) {
          for (const item of v) {
            const r = findProcess(item);
            if (r) return r;
          }
        } else if (typeof v === 'object') {
          const r = findProcess(v);
          if (r) return r;
        }
      }
      return null;
    }

    const process = findProcess(obj) || obj['prov-req-defn'] || null;
    let processId = '';
    let processVersion = '';
    if (process && typeof process === 'object') {
      processId = process['@_id'] || '';
      processVersion = process['@_version'] || '';
      lines.push(`- **Process id**: ${processId}`);
      lines.push(`- **Version**: ${processVersion}`);
    }

    // forms
    const forms = collectByTag(obj, 'form');
    lines.push(`- **Forms**: ${forms.length}`);
    const formsOut = forms.map((f: any) => {
      const fid = f['@_form-id'] || f['@_id'] || '';
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

    // Build BPMN using WorkflowBuilder
    const builder = new WorkflowBuilder();

    const idMap: Record<string, string> = {};
    activities.forEach((a) => {
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

      // attach parsed attrs to activity attributes
      if (activityInstance && activityInstance.attributes) {
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined && v !== null) (activityInstance.attributes as any)[k] = v;
        }
      }

      const assigned = builder.addActivity(activityInstance);
      idMap[a.id || assigned] = assigned;
    });

    // add flows
    links.forEach((l: any) => {
      const src = String(l['@_source'] || l['source'] || '');
      const tgt = String(l['@_target'] || l['target'] || '');
      const s = idMap[src] || src;
      const t = idMap[tgt] || tgt;
      try {
        if (s && t) builder.addFlow(s, t);
      } catch (e) {
        // continue
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

    return {
      summary: lines.join('\n'),
      processId,
      processVersion,
      activities,
      links,
      dataItems,
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
    const dsValues = findXmlDataObjects(obj);
    if (dsValues.length === 0) {
      // treat input as already decoded
      const decoded = prdXml;
      return analyzeDecodedXml(decoded);
    }

    const results = dsValues.map((dv) => {
      const s = asStringFromDsValue(dv);
      const decoded = tryDecode(s);
      return analyzeDecodedXml(decoded);
    });

    return { results };
  } catch (e) {
    return { error: (e && (e as Error).message) || 'Failed to extract XMLData' };
  }
}
