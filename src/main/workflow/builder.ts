import { randomUUID } from 'crypto';

// Dynamic require to avoid TypeScript module resolution issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('xmlbuilder2');

const NS_IAM = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const NS_IAM_1 = 'http://some-company/schema/bpmn/a';
const NS_BPMN = 'http://bpmn.io/schema/bpmn';
const NS_BPMNDI = 'http://www.omg.org/spec/BPMN/20100524/DI';
const NS_DC = 'http://www.omg.org/spec/DD/20100524/DC';
const NS_DI = 'http://www.omg.org/spec/DD/20100524/DI';

const TASK_WIDTH = 100;
const TASK_HEIGHT = 80;

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export class Activity {
  id: string;
  activityType: string;
  attributes: Record<string, unknown>;
  incoming: string[] = [];
  outgoing: string[] = [];

  constructor(activityType: string, attributes: Record<string, unknown>, activityId?: string) {
    this.id = activityId || makeId(activityType);
    this.activityType = activityType;
    this.attributes = attributes;
  }
}

export class StartActivity extends Activity {
  constructor(formId: string, resourceNameOverride?: string) {
    super('start-activity', {
      'form-id': formId,
      'resource-name-override': resourceNameOverride,
    });
  }
}

export class UserActivity extends Activity {
  constructor(formId: string, addressee?: string, ontimeout?: string, approverType = 'normal-approver') {
    super('user-activity', {
      'form-id': formId,
      addressee,
      ontimeout,
      'approver-type': approverType,
    });
  }
}

export class RestActivity extends Activity {
  constructor(method: string, apiUrl: string, authType: string) {
    super('rest-activity', {
      method,
      apiUrl,
      authType,
    });
  }
}

export class EntityActivity extends Activity {
  constructor(entityType?: string, operation?: string, deleteObject?: boolean) {
    super('entity-activity', {
      'entity-type': entityType,
      operation,
      deleteobject: deleteObject ?? false,
    });
  }
}

export class ConditionActivity extends Activity {
  constructor(expression: string) {
    super('condition-activity', { expression });
  }
}

export class LogActivity extends Activity {
  constructor(message?: string, comment?: string) {
    super('log-activity', { message, comment });
  }
}

export class FinishActivity extends Activity {
  constructor(setnotify?: string) {
    super('finish-activity', { setnotify });
  }
}

export class NotificationActivity extends Activity {
  constructor(templates?: string) {
    super('notification-activity', { templates });
  }
}

export class MessageActivity extends Activity {
  constructor(templates?: string, message?: string) {
    super('message-activity', { templates, message });
  }
}

export class SequenceFlow {
  id: string;
  sourceRef: string;
  targetRef: string;

  constructor(sourceRef: string, targetRef: string) {
    this.id = makeId('Flow');
    this.sourceRef = sourceRef;
    this.targetRef = targetRef;
  }
}

export class WorkflowBuilder {
  activities: Activity[] = [];
  flows: SequenceFlow[] = [];
  forms: Array<{ form: { id: string; components: Array<Record<string, unknown>> } }> = [];
  dataItems: Array<{ id: string; dataType?: string }> = [];
  processId: string = makeId('Process');

  addActivity(activity: Activity): string {
    this.activities.push(activity);
    return activity.id;
  }

  addFlow(sourceId: string, targetId: string) {
    const flow = new SequenceFlow(sourceId, targetId);
    this.flows.push(flow);

    const source = this.activities.find((a) => a.id === sourceId);
    if (source) {
      source.outgoing.push(flow.id);
    }

    const target = this.activities.find((a) => a.id === targetId);
    if (target) {
      target.incoming.push(flow.id);
    }
  }

  addForm(formId: string, components: Array<Record<string, unknown>>) {
    this.forms.push({ form: { id: formId, components } });
  }

  addDataItem(id: string, dataType?: string) {
    if (!id) return;
    this.dataItems.push({ id, dataType });
  }

  generateXml(): string {
    this.normalizeGraph();

    const doc = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('iam:definitions', {
        'xmlns:iam': NS_IAM,
        'xmlns:iam_1': NS_IAM_1,
        'xmlns:bpmndi': NS_BPMNDI,
        'xmlns:dc': NS_DC,
        'xmlns:di': NS_DI,
        targetNamespace: NS_BPMN,
      });

    const process = doc.ele('iam:process', {
      id: this.processId,
      isExecutable: 'true',
    });

    // add data items as process children for variables
    for (const di of this.dataItems) {
      const attrs: Record<string, string> = { id: di.id };
      if (di.dataType) attrs['data-type'] = String(di.dataType);
      process.ele('iam:dataItem', attrs);
    }

    for (const activity of this.activities) {
      const act = process.ele(`iam_1:${activity.activityType}`, { id: activity.id });
      for (const [key, value] of Object.entries(activity.attributes)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'boolean') {
          act.att(key, value ? 'true' : 'false');
        } else {
          act.att(key, String(value));
        }
      }
      for (const incoming of activity.incoming) {
        act.ele('iam:incoming').txt(incoming);
      }
      for (const outgoing of activity.outgoing) {
        act.ele('iam:outgoing').txt(outgoing);
      }
    }

    for (const flow of this.flows) {
      process.ele('iam:sequenceFlow', {
        id: flow.id,
        sourceRef: flow.sourceRef,
        targetRef: flow.targetRef,
      });
    }

    this.appendBpmnDi(doc);

    return doc.end({ prettyPrint: true });
  }

  generateFormsJson(): string {
    if (this.forms.length === 1) {
      return JSON.stringify(this.forms[0], null, 2);
    }
    return JSON.stringify(this.forms, null, 2);
  }

  private normalizeGraph() {
    if (this.activities.length === 0) {
      return;
    }

    // Ensure activity IDs are unique and flow refs follow renamed IDs.
    const idRename = new Map<string, string>();
    const usedIds = new Set<string>();
    this.activities.forEach((activity, idx) => {
      const base = (activity.id || `${activity.activityType || 'activity'}_${idx + 1}`)
        .replace(/[^a-zA-Z0-9_\-.]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || `${activity.activityType || 'activity'}_${idx + 1}`;

      let nextId = base;
      let counter = 2;
      while (usedIds.has(nextId)) {
        nextId = `${base}_${counter}`;
        counter += 1;
      }

      usedIds.add(nextId);
      if (nextId !== activity.id) {
        idRename.set(activity.id, nextId);
        activity.id = nextId;
      }
    });

    if (idRename.size > 0) {
      this.flows.forEach((flow) => {
        if (idRename.has(flow.sourceRef)) {
          flow.sourceRef = idRename.get(flow.sourceRef) as string;
        }
        if (idRename.has(flow.targetRef)) {
          flow.targetRef = idRename.get(flow.targetRef) as string;
        }
      });
    }

    // Ensure at least one start and finish activity exist.
    let start = this.activities.find((a) => a.activityType === 'start-activity');
    let finish = this.activities.find((a) => a.activityType === 'finish-activity');

    if (!start) {
      start = new StartActivity('');
      this.activities.unshift(start);
    }
    if (!finish) {
      finish = new FinishActivity();
      this.activities.push(finish);
    }

    const activityById = new Map(this.activities.map((a) => [a.id, a]));

    // Keep only valid non-self flows and dedupe by source->target.
    const pairSet = new Set<string>();
    const normalizedFlows: SequenceFlow[] = [];
    for (const flow of this.flows) {
      if (!activityById.has(flow.sourceRef) || !activityById.has(flow.targetRef)) {
        continue;
      }
      if (flow.sourceRef === flow.targetRef) {
        continue;
      }
      const pair = `${flow.sourceRef}->${flow.targetRef}`;
      if (pairSet.has(pair)) {
        continue;
      }
      pairSet.add(pair);
      normalizedFlows.push(flow);
    }
    this.flows = normalizedFlows;

    const pushFlow = (sourceRef: string, targetRef: string) => {
      if (!activityById.has(sourceRef) || !activityById.has(targetRef)) {
        return;
      }
      if (sourceRef === targetRef) {
        return;
      }
      const sourceType = activityById.get(sourceRef)?.activityType;
      const targetType = activityById.get(targetRef)?.activityType;
      if (sourceType === 'finish-activity' || targetType === 'start-activity') {
        return;
      }
      const pair = `${sourceRef}->${targetRef}`;
      if (pairSet.has(pair)) {
        return;
      }
      pairSet.add(pair);
      this.flows.push(new SequenceFlow(sourceRef, targetRef));
    };

    const starts = this.activities.filter((a) => a.activityType === 'start-activity').map((a) => a.id);
    const finishes = this.activities.filter((a) => a.activityType === 'finish-activity').map((a) => a.id);
    const orderedIds = [
      ...starts,
      ...this.activities.filter((a) => a.activityType !== 'start-activity' && a.activityType !== 'finish-activity').map((a) => a.id),
      ...finishes,
    ];

    if (this.flows.length === 0 && orderedIds.length > 1) {
      for (let i = 0; i < orderedIds.length - 1; i++) {
        pushFlow(orderedIds[i], orderedIds[i + 1]);
      }
    }

    const incomingCount = new Map<string, number>();
    const outgoingCount = new Map<string, number>();
    orderedIds.forEach((id) => {
      incomingCount.set(id, 0);
      outgoingCount.set(id, 0);
    });
    this.flows.forEach((flow) => {
      incomingCount.set(flow.targetRef, (incomingCount.get(flow.targetRef) || 0) + 1);
      outgoingCount.set(flow.sourceRef, (outgoingCount.get(flow.sourceRef) || 0) + 1);
    });

    const defaultStart = starts[0] || orderedIds[0];
    const defaultFinish = finishes[0] || orderedIds[orderedIds.length - 1];
    orderedIds.forEach((id, idx) => {
      const type = activityById.get(id)?.activityType;

      if (type !== 'start-activity' && (incomingCount.get(id) || 0) === 0) {
        const prev = orderedIds[Math.max(0, idx - 1)] || defaultStart;
        if (prev && prev !== id) {
          pushFlow(prev, id);
          incomingCount.set(id, (incomingCount.get(id) || 0) + 1);
          outgoingCount.set(prev, (outgoingCount.get(prev) || 0) + 1);
        }
      }

      if (type !== 'finish-activity' && (outgoingCount.get(id) || 0) === 0) {
        const next = orderedIds[Math.min(orderedIds.length - 1, idx + 1)] || defaultFinish;
        if (next && next !== id) {
          pushFlow(id, next);
          outgoingCount.set(id, (outgoingCount.get(id) || 0) + 1);
          incomingCount.set(next, (incomingCount.get(next) || 0) + 1);
        }
      }
    });

    // Condition nodes should branch to at least two paths where possible.
    const pickAlternateBranchTarget = (conditionId: string, existingTargets: Set<string>): string => {
      const idx = orderedIds.indexOf(conditionId);
      if (idx >= 0) {
        for (let i = idx + 1; i < orderedIds.length; i++) {
          const candidate = orderedIds[i];
          if (candidate !== conditionId && !existingTargets.has(candidate) && activityById.get(candidate)?.activityType !== 'start-activity') {
            return candidate;
          }
        }
      }
      for (const candidate of orderedIds) {
        if (candidate !== conditionId && !existingTargets.has(candidate) && activityById.get(candidate)?.activityType !== 'start-activity') {
          return candidate;
        }
      }
      return defaultFinish;
    };

    this.activities
      .filter((activity) => activity.activityType === 'condition-activity')
      .forEach((condition) => {
        const targets = new Set(
          this.flows
            .filter((flow) => flow.sourceRef === condition.id)
            .map((flow) => flow.targetRef)
        );

        if (targets.size < 2 && orderedIds.length > 2) {
          const alternate = pickAlternateBranchTarget(condition.id, targets);
          if (alternate && alternate !== condition.id && !targets.has(alternate)) {
            pushFlow(condition.id, alternate);
            targets.add(alternate);
          }
        }
      });

    // Ensure every node is reachable from a start and can reach a finish.
    const buildAdjacency = () => {
      const next = new Map<string, string[]>();
      const prev = new Map<string, string[]>();
      orderedIds.forEach((id) => {
        next.set(id, []);
        prev.set(id, []);
      });
      this.flows.forEach((flow) => {
        if (!next.has(flow.sourceRef)) next.set(flow.sourceRef, []);
        if (!prev.has(flow.targetRef)) prev.set(flow.targetRef, []);
        next.get(flow.sourceRef)?.push(flow.targetRef);
        prev.get(flow.targetRef)?.push(flow.sourceRef);
      });
      return { next, prev };
    };

    const computeReachable = (seeds: string[], adjacency: Map<string, string[]>) => {
      const visited = new Set<string>();
      const queue: string[] = [];
      seeds.forEach((seed) => {
        if (!seed) return;
        if (visited.has(seed)) return;
        visited.add(seed);
        queue.push(seed);
      });

      while (queue.length > 0) {
        const current = queue.shift() as string;
        const neighbors = adjacency.get(current) || [];
        neighbors.forEach((neighbor) => {
          if (visited.has(neighbor)) return;
          visited.add(neighbor);
          queue.push(neighbor);
        });
      }

      return visited;
    };

    let adjacency = buildAdjacency();
    let reachableFromStart = computeReachable(starts, adjacency.next);
    orderedIds.forEach((id, idx) => {
      if (reachableFromStart.has(id)) return;
      const prevCandidate = orderedIds.slice(0, idx).reverse().find((candidate) => reachableFromStart.has(candidate) && candidate !== id);
      const source = prevCandidate || defaultStart;
      if (source && source !== id) {
        pushFlow(source, id);
        adjacency = buildAdjacency();
        reachableFromStart = computeReachable(starts, adjacency.next);
      }
    });

    let reachableToFinish = computeReachable(finishes, adjacency.prev);
    orderedIds.forEach((id) => {
      const type = activityById.get(id)?.activityType;
      if (type === 'finish-activity') return;
      if (reachableToFinish.has(id)) return;
      if (defaultFinish && id !== defaultFinish) {
        pushFlow(id, defaultFinish);
        adjacency = buildAdjacency();
        reachableToFinish = computeReachable(finishes, adjacency.prev);
      }
    });

    // Rebuild incoming/outgoing references from normalized flow set.
    this.activities.forEach((activity) => {
      activity.incoming = [];
      activity.outgoing = [];
    });

    this.flows.forEach((flow) => {
      const source = activityById.get(flow.sourceRef);
      const target = activityById.get(flow.targetRef);
      if (source) {
        source.outgoing.push(flow.id);
      }
      if (target) {
        target.incoming.push(flow.id);
      }
    });
  }

  private appendBpmnDi(doc: ReturnType<typeof create>) {
    const layout = this.calculateLayout();

    const diagram = doc.ele('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1' });
    const plane = diagram.ele('bpmndi:BPMNPlane', {
      id: 'BPMNPlane_1',
      bpmnElement: this.processId,
    });

    for (const activity of this.activities) {
      const [x, y] = layout[activity.id] ?? [100, 100];
      const shape = plane.ele('bpmndi:BPMNShape', {
        id: `${activity.id}_di`,
        bpmnElement: activity.id,
      });
      shape.ele('dc:Bounds', {
        x: String(x),
        y: String(y),
        width: String(TASK_WIDTH),
        height: String(TASK_HEIGHT),
      });
    }

    for (const flow of this.flows) {
      const [sx, sy] = layout[flow.sourceRef] ?? [0, 0];
      const [tx, ty] = layout[flow.targetRef] ?? [0, 0];

      const startX = sx + TASK_WIDTH;
      const startY = sy + TASK_HEIGHT / 2;
      const endX = tx;
      const endY = ty + TASK_HEIGHT / 2;

      const edge = plane.ele('bpmndi:BPMNEdge', {
        id: `${flow.id}_di`,
        bpmnElement: flow.id,
      });

      edge.ele('di:waypoint', { x: String(startX), y: String(startY) });
      edge.ele('di:waypoint', { x: String(endX), y: String(endY) });
    }
  }

  private calculateLayout(): Record<string, [number, number]> {
    const layout: Record<string, [number, number]> = {};
    const visited = new Set<string>();
    const queue: Array<{ id: string; x: number }> = [];
    const levelY: Record<number, number> = {};

    const start = this.activities.find((a) => a.incoming.length === 0) || this.activities[0];
    if (start) {
      queue.push({ id: start.id, x: 0 });
      visited.add(start.id);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const yIndex = levelY[current.x] ?? 0;
      levelY[current.x] = yIndex + 1;

      const xPos = current.x * 250 + 100;
      const yPos = yIndex * 150 + 100;
      layout[current.id] = [xPos, yPos];

      const activity = this.activities.find((a) => a.id === current.id);
      if (!activity) continue;

      for (const flowId of activity.outgoing) {
        const flow = this.flows.find((f) => f.id === flowId);
        if (!flow) continue;
        const targetId = flow.targetRef;
        if (!visited.has(targetId)) {
          visited.add(targetId);
          queue.push({ id: targetId, x: current.x + 1 });
        }
      }
    }

    let extraYIndex = Math.max(0, ...Object.values(levelY)) + 1;
    for (const activity of this.activities) {
      if (!layout[activity.id]) {
        layout[activity.id] = [100, extraYIndex * 150 + 100];
        extraYIndex += 1;
      }
    }

    return layout;
  }
}
