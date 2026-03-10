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

  generateXml(): string {
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
