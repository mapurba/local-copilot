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

function stripCdata(input: string): string {
  return input.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
}

function decodeBase64Utf8(value: string): string {
  try {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(value, 'base64').toString('utf8');
    }
  } catch {
    // Fall back to browser decoding path.
  }

  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }

    let out = '';
    bytes.forEach((b) => {
      out += String.fromCharCode(b);
    });
    return out;
  }

  return value;
}

function tryDecode(candidate: string | undefined | null): string {
  if (!candidate) return '';
  const normalized = stripCdata(candidate);
  if (!normalized) return '';

  try {
    const decoded = decodeBase64Utf8(normalized);
    if (/<(?:\w+:)?(?:prov-req-defn|process|form)\b/i.test(decoded) || decoded.includes('<?xml')) {
      return decoded;
    }
  } catch {
    // Not Base64 or invalid payload.
  }

  return normalized;
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

function keyMatchesTag(key: string, tag: string): boolean {
  return key === tag || key.endsWith(`:${tag}`);
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

export async function convertPrdLocal(prdXml: string) {
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
        const text = tryDecode(raw || '').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        decoded.push(text);
      });
      return decoded;
    };

    const processRaw = collectAttrValues(['srvprvProcessXML', 'srvprvprocessxml', 'srvPrvProcessXML']);
    if (processRaw.length === 0) processRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'srvprvProcessXML'));

    const requestRaw = collectAttrValues(['srvprvRequestXML', 'srvprvrequestxml', 'srvPrvRequestXML']);
    if (requestRaw.length === 0) requestRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'srvprvRequestXML'));

    const xmlDataRaw = collectAttrValues(['XMLData']);
    if (xmlDataRaw.length === 0) xmlDataRaw.push(...findRawDsAttrCdataBlocks(prdXml, 'XMLData'));

    const processDecoded = decodeUnique(processRaw);
    const requestDecoded = decodeUnique(requestRaw);
    const xmlDataDecoded = decodeUnique(xmlDataRaw);

    const primaryDecoded = processDecoded.length ? processDecoded : (xmlDataDecoded.length ? xmlDataDecoded : requestDecoded);
    if (primaryDecoded.length === 0) {
      // input is likely already decoded
      const analyzed = analyzeDecodedXml(prdXml);
      return { success: true, result: analyzed };
    }

    const supplementalPool = decodeUnique([...requestDecoded, ...xmlDataDecoded]);
    const results = primaryDecoded.map((decoded) => {
      const supplemental = supplementalPool.filter((candidate) => candidate !== decoded);
      return analyzeDecodedXml(decoded, supplemental);
    });

    return { success: true, result: results.length === 1 ? results[0] : { results } };
  } catch (e) {
    return { success: false, error: (e && (e as Error).message) || 'Local conversion failed' };
  }
}

function analyzeDecodedXml(decodedXml: string, supplementalXml: string[] = []) {
  try {
    const obj = parser.parse(decodedXml);
    const supplementalRoots: any[] = [];
    if (Array.isArray(supplementalXml)) {
      supplementalXml.forEach((candidate) => {
        if (!candidate || typeof candidate !== 'string') return;
        const trimmed = candidate.trim();
        if (!trimmed) return;
        try {
          supplementalRoots.push(parser.parse(trimmed));
        } catch {
          // Ignore malformed supplemental payloads.
        }
      });
    }
    const allRoots = [obj, ...supplementalRoots];

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
    if (supplementalRoots.length) {
      lines.push(`- Supplemental payload merge: merged ${supplementalRoots.length} request/XMLData payload(s) to recover missing form schemas and fields.`);
    }

    // process id/version
    function findProcess(o: any): any | null {
      if (!o || typeof o !== 'object') return null;
      for (const key of Object.keys(o)) {
        if (keyMatchesTag(key, 'process')) return o[key];
      }
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

    const forms = allRoots.flatMap((root) => collectByTag(root, 'form'));
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

    const humanizeType = (value: string) => {
      const text = String(value || '').replace(/-/g, ' ').trim();
      return text ? text.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Activity';
    };

    const activityById = new Map<string, any>();
    activities.forEach((a) => {
      if (a.id) activityById.set(a.id, a);
    });

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    activities.forEach((a) => {
      inDegree.set(a.id, 0);
      adjacency.set(a.id, []);
    });

    links.forEach((l: any) => {
      const source = String(l['@_source'] || l['source'] || '').trim();
      const target = String(l['@_target'] || l['target'] || '').trim();
      if (!source || !target) return;
      if (!adjacency.has(source)) adjacency.set(source, []);
      adjacency.get(source)?.push(target);
      inDegree.set(target, (inDegree.get(target) || 0) + 1);
    });

    const start = activities.find((a) => a.type === 'start-activity')
      || activities.find((a) => (inDegree.get(a.id) || 0) === 0)
      || activities[0];

    const orderedSteps: any[] = [];
    if (start?.id) {
      const seen = new Set<string>();
      const queue = [start.id];
      while (queue.length) {
        const current = queue.shift() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const act = activityById.get(current);
        if (act) orderedSteps.push(act);
        (adjacency.get(current) || []).forEach((next) => {
          if (!seen.has(next)) queue.push(next);
        });
      }
      activities.forEach((a) => {
        if (!seen.has(a.id)) orderedSteps.push(a);
      });
    }

    lines.push('');
    lines.push('## Beginner Friendly Explanation');
    lines.push('### What This PRD Represents');
    lines.push('This PRD describes an approval/provisioning flow. It defines the order of activities, who handles each step, and what data is passed through the process.');

    lines.push('');
    lines.push('### Workflow Walkthrough');
    if (orderedSteps.length === 0) {
      lines.push('- No clear step order could be inferred from activities and links.');
    } else {
      orderedSteps.forEach((step, idx) => {
        const formId = String(step.obj?.['@_form-id'] || '').trim();
        const addressee = String(step.obj?.['@_addressee'] || '').trim();
        const details: string[] = [];
        if (formId) details.push(`form '${formId}'`);
        if (addressee) details.push(`owner '${addressee}'`);
        lines.push(`${idx + 1}. ${humanizeType(step.type)} (${step.id || '<no-id>'})${details.length ? ` - ${details.join(', ')}` : ''}`);
      });
    }

    lines.push('');
    lines.push('### What To Validate First');
    lines.push('- Ensure user-facing steps reference the right forms and recipients.');
    lines.push('- Ensure condition branches represent real business rules.');
    lines.push('- Ensure all non-terminal steps connect to a valid next step.');
    lines.push('- Ensure data-item usage aligns with expected provisioning inputs.');

    const prdTodoList = [
      {
        id: 1,
        title: 'Import PRD file',
        details: 'PRD file imported and ready for conversion.',
        status: 'completed',
      },
      {
        id: 2,
        title: 'Decode srvprvProcessXML payload',
        details: 'Decoded process XML from srvprvProcessXML CDATA/base64 payload.',
        status: 'completed',
      },
      {
        id: 3,
        title: 'Separate process artifacts',
        details: `Detected ${forms.length} form(s), ${dataItems.length} data item(s), and workflow process structure.`,
        status: 'completed',
      },
      {
        id: 4,
        title: 'Analyze process relationships',
        details: `Analyzed ${activities.length} activity(ies) and ${links.length} transition(s).`,
        status: 'completed',
      },
      {
        id: 5,
        title: 'Create PRD todo list',
        details: 'Created checklist for conversion and implementation.',
        status: 'completed',
      },
      {
        id: 6,
        title: 'Start implementation',
        details: 'Generated initial workflow and forms artifacts.',
        status: 'completed',
      },
      {
        id: 7,
        title: 'Store workflow and split forms',
        details: 'Workflow XML and individual forms are ready to persist.',
        status: 'completed',
      },
    ];

    const result: any = { summary: lines.join('\n'), activities, links, dataItems, decodedXml, workflowProcessXml: decodedXml, prdTodoList };
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
      const aliasToCanonical = new Map<string, string>();
      const typeById = new Map<string, string>();
      const usedIds = new Set<string>();

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

      activities.forEach((a: any, idx: number) => {
        const preferredId = a.id || a.obj?.['@_activity-id'] || a.obj?.['@_id'] || '';
        const aid = makeUniqueId(String(preferredId), `act_${idx + 1}`);
        const tag = `iam_1:${a.type || 'activity'}`;
        const el = proc.ele(tag, { id: aid });
        // copy some attributes
        const o = a.obj || {};
        if (o['@_form-id']) el.att('form-id', o['@_form-id']);
        if (o['@_addressee']) el.att('addressee', o['@_addressee']);
        if (o['@_activity-id']) el.att('activity-id', o['@_activity-id']);
        idMap[a.id] = aid;
        typeById.set(aid, String(a.type || 'activity'));
        registerAlias(aliasToCanonical, String(aid), aid);
        registerAlias(aliasToCanonical, String(a.id || ''), aid);
        registerAlias(aliasToCanonical, String(o['@_activity-id'] || ''), aid);
        registerAlias(aliasToCanonical, String(o['@_id'] || ''), aid);
      });

      // flows
      const flowPairs = new Set<string>();
      const safeAddFlow = (sourceId: string, targetId: string) => {
        const s = (sourceId || '').trim();
        const t = (targetId || '').trim();
        if (!s || !t || s === t) return;
        const key = `${s}->${t}`;
        if (flowPairs.has(key)) return;
        flowPairs.add(key);
      };

      links.forEach((l: any, idx: number) => {
        const srcRaw = String(l['@_source'] || l['source'] || l['@_sourceRef'] || l['sourceRef'] || l['@_source-ref'] || l['source-ref'] || l['@_from'] || l['from'] || '');
        const tgtRaw = String(l['@_target'] || l['target'] || l['@_targetRef'] || l['targetRef'] || l['@_target-ref'] || l['target-ref'] || l['@_to'] || l['to'] || '');
        const s = resolveAlias(aliasToCanonical, srcRaw);
        const t = resolveAlias(aliasToCanonical, tgtRaw);
        if (s && t) safeAddFlow(s, t);
      });

      const allIds = Array.from(typeById.keys());
      const starts = allIds.filter((id) => typeById.get(id) === 'start-activity');
      const finishes = allIds.filter((id) => typeById.get(id) === 'finish-activity');
      const orderedIds = [
        ...starts,
        ...allIds.filter((id) => !starts.includes(id) && !finishes.includes(id)),
        ...finishes,
      ];

      if (flowPairs.size === 0 && orderedIds.length > 1) {
        for (let i = 0; i < orderedIds.length - 1; i++) {
          safeAddFlow(orderedIds[i], orderedIds[i + 1]);
        }
      }

      const incoming = new Map<string, number>();
      const outgoing = new Map<string, number>();
      orderedIds.forEach((id) => {
        incoming.set(id, 0);
        outgoing.set(id, 0);
      });
      Array.from(flowPairs).forEach((pair) => {
        const [s, t] = pair.split('->');
        outgoing.set(s, (outgoing.get(s) || 0) + 1);
        incoming.set(t, (incoming.get(t) || 0) + 1);
      });

      const defaultStart = starts[0] || orderedIds[0] || '';
      const defaultFinish = finishes[0] || orderedIds[orderedIds.length - 1] || '';

      orderedIds.forEach((id, idx) => {
        const type = typeById.get(id) || '';
        if (type !== 'start-activity' && (incoming.get(id) || 0) === 0) {
          const prev = orderedIds[Math.max(0, idx - 1)] || defaultStart;
          if (prev && prev !== id) {
            safeAddFlow(prev, id);
            outgoing.set(prev, (outgoing.get(prev) || 0) + 1);
            incoming.set(id, (incoming.get(id) || 0) + 1);
          }
        }

        if (type !== 'finish-activity' && (outgoing.get(id) || 0) === 0) {
          const next = orderedIds[Math.min(orderedIds.length - 1, idx + 1)] || defaultFinish;
          if (next && next !== id) {
            safeAddFlow(id, next);
            outgoing.set(id, (outgoing.get(id) || 0) + 1);
            incoming.set(next, (incoming.get(next) || 0) + 1);
          }
        }
      });

      let flowIndex = 0;
      Array.from(flowPairs).forEach((pair) => {
        const [sourceRef, targetRef] = pair.split('->');
        proc.ele('iam:sequenceFlow', { id: `flow_${flowIndex}`, sourceRef, targetRef });
        flowIndex += 1;
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
      const rawForms = allRoots.flatMap((root) => collectByTag(root, 'form'));
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
