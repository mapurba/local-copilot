import { XMLParser } from 'fast-xml-parser';
import { create } from 'xmlbuilder2';

const NS_IAM = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const NS_IAM_1 = 'http://some-company/schema/bpmn/a';
const NS_BPMNDI = 'http://www.omg.org/spec/BPMN/20100524/DI';
const NS_DC = 'http://www.omg.org/spec/DD/20100524/DC';
const NS_DI = 'http://www.omg.org/spec/DD/20100524/DI';

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
  // Try Node Buffer when available (rare in renderer); otherwise use atob
  try {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      const buf = Buffer.from(s, 'base64');
      const text = buf.toString('utf8');
      if (text.includes('<prov-req-defn') || text.includes('<process') || text.includes('<?xml')) return text;
    } else if (typeof atob === 'function') {
      try {
        const text = atob(s);
        if (text.includes('<prov-req-defn') || text.includes('<process') || text.includes('<?xml')) return text;
      } catch {
        // not valid base64 for atob
      }
    }
  } catch (e) {
    // ignore decode errors
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

export async function convertPrdLocal(prdXml: string) {
  try {
    const obj = parser.parse(prdXml);
    const dsValues = findXmlDataObjects(obj);
    if (dsValues.length === 0) {
      // input is likely already decoded
      const decoded = prdXml;
      const analyzed = analyzeDecodedXml(decoded);
      return { success: true, result: analyzed };
    }

    const results = dsValues.map((dv) => {
      const s = asStringFromDsValue(dv);
      const decoded = tryDecode(s);
      const analyzed = analyzeDecodedXml(decoded);
      return analyzed;
    });

    return { success: true, result: { results } };
  } catch (e) {
    return { success: false, error: (e && (e as Error).message) || 'Local conversion failed' };
  }
}

function analyzeDecodedXml(decodedXml: string) {
  try {
    const obj = parser.parse(decodedXml);
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
    if (process && typeof process === 'object') {
      const id = process['@_id'] || '';
      const version = process['@_version'] || '';
      lines.push(`- **Process id**: ${id}`);
      lines.push(`- **Version**: ${version}`);
    }

    const forms = collectByTag(obj, 'form');
    lines.push(`- **Forms**: ${forms.length}`);

    const tags = ['user-activity','provision-activity','condition-activity','mapping-activity','log-activity','start-activity','finish-activity'];
    const activities: any[] = [];
    for (const t of tags) {
      const got = collectByTag(obj, t);
      got.forEach((a: any) => activities.push({ id: String(a['@_activity-id'] || a['@_id'] || a['@_id_ref'] || ''), type: t, obj: a }));
    }
    lines.push(`- **Activities**: ${activities.length}`);

    const links = collectByTag(obj, 'link');
    lines.push(`- **Links**: ${links.length}`);

    const dataItems = collectByTag(obj, 'data-item');
    lines.push(`- **Data-items**: ${dataItems.length}`);

    const result: any = { summary: lines.join('\n'), activities, links, dataItems, decodedXml };
    // also generate a simple BPMN and forms.json for renderer preview
    try {
      const doc = create({ version: '1.0', encoding: 'UTF-8' })
        .ele('iam:definitions', {
          'xmlns:iam': NS_IAM,
          'xmlns:iam_1': NS_IAM_1,
          'xmlns:bpmndi': NS_BPMNDI,
          'xmlns:dc': NS_DC,
          'xmlns:di': NS_DI,
          targetNamespace: 'http://bpmn.io/schema/bpmn',
        });

      const proc = doc.ele('iam:process', { id: 'Process_1', isExecutable: 'true' });

      // activities -> elements
      const idMap: Record<string, string> = {};
      activities.forEach((a: any, idx: number) => {
        const aid = a.id || `act_${idx}`;
        const tag = `iam_1:${a.type || 'activity'}`;
        const el = proc.ele(tag, { id: aid });
        // copy some attributes
        const o = a.obj || {};
        if (o['@_form-id']) el.att('form-id', o['@_form-id']);
        if (o['@_addressee']) el.att('addressee', o['@_addressee']);
        if (o['@_activity-id']) el.att('activity-id', o['@_activity-id']);
        idMap[a.id] = aid;
      });

      // flows
      links.forEach((l: any, idx: number) => {
        const src = String(l['@_source'] || l['source'] || '');
        const tgt = String(l['@_target'] || l['target'] || '');
        const s = idMap[src] || src || `act_${idx}_s`;
        const t = idMap[tgt] || tgt || `act_${idx}_t`;
        proc.ele('iam:sequenceFlow', { id: `flow_${idx}`, sourceRef: s, targetRef: t });
      });

      // data-items
      dataItems.forEach((di: any) => {
        try {
          const id = di['@_id'] || di['@_name'] || di['@_data-id'] || di['id'] || '';
          if (id) proc.ele('iam:dataItem', { id: String(id) });
        } catch {}
      });

      const workflowXml = doc.end({ prettyPrint: true });

      // simple forms.json
      const forms: any[] = [];
      const rawForms = collectByTag(obj, 'form');
      rawForms.forEach((f: any) => {
        const fid = f['@_form-id'] || f['@_id'] || `form_${forms.length}`;
        const fields: any[] = [];
        if (f['content'] && f['content']['field']) {
          const fl = Array.isArray(f['content']['field']) ? f['content']['field'] : [f['content']['field']];
          fl.forEach((field: any) => {
            const name = field['@_name'] || 'field';
            const dtype = (field['@_data-type'] || field['@_type'] || '').toLowerCase();
            let type = 'textfield';
            if (dtype.includes('bool')) type = 'checkbox';
            else if (dtype.includes('date')) type = 'datetime';
            else if (dtype.includes('int') || dtype.includes('number')) type = 'number';
            const comp: any = { key: name, label: name, type };
            if (field['option']) {
              const opts = Array.isArray(field['option']) ? field['option'] : [field['option']];
              comp.options = { values: opts.map((o: any) => ({ label: o['@_label'] || o['label'] || o, value: o['@_value'] || o['value'] || o })) };
            }
            fields.push(comp);
          });
        }
        forms.push({ form: { id: fid, components: fields } });
      });

      result.workflowXml = workflowXml;
      result.formsJson = JSON.stringify(forms.length === 1 ? forms[0] : forms, null, 2);
    } catch (e) {
      // ignore BPMN generation errors in fallback
    }

    return result;
  } catch (e) {
    return { error: (e && (e as Error).message) || 'Failed to analyze decoded XML' };
  }
}
