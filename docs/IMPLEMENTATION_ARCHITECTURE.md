# Conversion Pipeline Implementation Architecture

## Executive Summary

This document provides a deep technical dive into the PRD-to-BPMN conversion implementation, including detailed code flows, data structures, and integration patterns.

---

## System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                       ELECTRON MAIN PROCESS                      │
│  (Node.js + TypeScript)                                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ IPC Handlers (ipcHandlers.ts)                             │ │
│  │ • workflow:convertPrd                                     │ │
│  │ • workflow:readFile                                       │ │
│  │ • workflow:listTree                                       │ │
│  └────────────────────┬─────────────────────────────────────┘ │
│                       │                                        │
│                       ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Conversion Engine (prdConverter.ts)                        │ │
│  │ ┌──────────────────────────────────────────────────────┐  │ │
│  │ │ extractAndAnalyzeFromPrdXml()                        │  │ │
│  │ │ ├─ Parse XML                                         │  │ │
│  │ │ ├─ Extract activities                               │  │ │
│  │ │ ├─ Extract forms                                    │  │ │
│  │ │ ├─ Extract data items                               │  │ │
│  │ │ ├─ Normalize transitions                            │  │ │
│  │ │ └─ Return structured result                         │  │ │
│  │ └──────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                       │                                        │
│         ┌─────────────┼─────────────┬────────────────┐        │
│         ▼             ▼             ▼                ▼        │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  │
│  │ LLM (Chat) │  │ BPMN     │  │ Forms     │  │ Storage  │  │
│  │ API        │  │ Gen      │  │ Gen       │  │ (I/O)    │  │
│  │            │  │          │  │           │  │          │  │
│  │summarize() │  │generate()│  │transform()│  │persist() │  │
│  └────────────┘  └──────────┘  └───────────┘  └──────────┘  │
│                       │             │              │         │
│         ┌─────────────┴─────────────┴──────────────┘         │
│         ▼                                                    │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Output Formatter (storage.ts)                             │ │
│  │ • Write XML files                                         │ │
│  │ • Write JSON files                                        │ │
│  │ • Write Markdown                                          │ │
│  │ • Create directory structure                              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                       │                                        │
└───────────────────────┼────────────────────────────────────────┘
                        │ IPC Events: progress
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                   ELECTRON RENDERER PROCESS                      │
│  (Angular + TypeScript in Chromium)                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Convert PRD Component (convert-prd.component.ts)          │ │
│  │ • File upload/paste input                                 │ │
│  │ • Model selection                                         │ │
│  │ • Progress display                                        │ │
│  │ • Result visualization                                    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ File Tree Component                                        │ │
│  │ • Browse output artifacts                                 │ │
│  │ • View generated files                                    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ BPMN/Form Viewers                                         │ │
│  │ • BPMN diagram rendering (bpmn-js)                        │ │
│  │ • Form schema viewer                                      │ │
│  │ • Summary markdown display                                │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Data Flow

### Request Flow Sequence

```
1. User Action (Upload/Paste)
   │
   ├─→ Validate input
   │
   ├─→ Create request with unique ID
   │
   └─→ Invoke IPC: workflow:convertPrd
       {
         content: string (XML),
         modelId?: string,
         fileName?: string,
         requestId: string
       }

2. Main Process (ipcHandlers.ts)
   │
   ├─→ Extract inputs
   │
   ├─→ Normalize results function setup
   │
   ├─→ Initialize progress emitter
   │
   ├─→ Call extractAndAnalyzeFromPrdXml(xml)
   │
   ├─→ Emit progress: "parsed"
   │
   ├─→ Optional: Call LLM for summarization
   │   ├─ Stream chat completion
   │   ├─ Build prompt with structured JSON
   │   ├─ Collect LLM response
   │   └─ Emit progress: "llm-summary-complete"
   │
   ├─→ Normalize results (handle single/array)
   │
   ├─→ Prepare output directory
   │   ├─ Get configured workflow output dir
   │   ├─ Create timestamped subdirectory
   │   └─ Emit progress: "output-ready"
   │
   ├─→ For each result:
   │   ├─ Write decoded XML
   │   ├─ Write BPMN workflow XML
   │   ├─ Write forms JSON
   │   ├─ Write forms individual files
   │   ├─ Write todo list markdown
   │   ├─ Write summary markdown
   │   └─ Emit progress: "saving-item"
   │
   ├─→ Emit progress: "complete"
   │
   └─→ Return response with all file paths

3. Renderer Process
   │
   ├─→ Receive response
   │
   ├─→ Display results
   │
   ├─→ Update file tree
   │
   ├─→ Render BPMN diagram
   │
   └─→ Display summaries and forms
```

---

## Detailed Implementation

### 1. Entry Point: IPC Handler

**File:** `src/main/ipcHandlers.ts`

```typescript
ipcMain.handle('workflow:convertPrd', async (_event, input: ConvertPrdInput) => {
  // 1. Extract and validate inputs
  const requestId = input.requestId || `convert-${Date.now()}`;
  const emitProgress = createProgressEmitter(mainWindow, requestId);
  
  try {
    // 2. Start conversion
    emitProgress('started', 'Starting PRD conversion', 2);
    
    // 3. Read input (file or content)
    let prdXml = input.content || '';
    if (!prdXml && input.filePath) {
      emitProgress('reading-file', `Reading: ${path.basename(input.filePath)}`);
      prdXml = await fs.readFile(input.filePath, 'utf8');
    }
    
    // 4. Extract PRD structure
    emitProgress('parsing', 'Extracting PRD structure', 18);
    const result = extractAndAnalyzeFromPrdXml(prdXml);
    const results = normalizeResults(result);  // Handle single or array
    
    emitProgress('parsed', 'PRD analysis complete', 30);
    
    // 5. Optional: LLM summarization
    if (input.modelId) {
      // ... (see LLM section below)
    }
    
    // 6. Save artifacts
    emitProgress('saving', 'Preparing artifacts', 72);
    const outputDir = await prepareOutputDirectory();
    
    // 7. Write all files
    for (const r of results) {
      await writeArtifacts(outputDir, r);
    }
    
    // 8. Return success
    return { success: true, outputDir, files: { ... } };
    
  } catch (err) {
    emitProgress('failed', `Error: ${err.message}`, 100);
    return { success: false, error: err.message };
  }
});
```

### 2. PRD Extraction Engine

**File:** `src/main/workflow/prdConverter.ts`

```typescript
export function extractAndAnalyzeFromPrdXml(prdXml: string): PrdAnalysisResult {
  const result: PrdAnalysisResult = {
    processId: '',
    processVersion: '',
    processName: '',
    activities: [],
    dataItems: [],
    forms: [],
    links: [],
    decodedXml: prdXml
  };

  try {
    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(prdXml, 'text/xml');
    
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('Invalid XML');
    }

    // Extract process metadata
    const procDef = doc.querySelector('ProcessDefinition');
    result.processId = procDef?.getAttribute('id') || 'UNKNOWN';
    result.processVersion = procDef?.getAttribute('version') || '1.0';
    result.processName = procDef?.getAttribute('name') || result.processId;

    // Extract data items
    const dataItemsNode = procDef?.querySelector('DataItems');
    for (const item of dataItemsNode?.querySelectorAll('DataItem') || []) {
      result.dataItems.push({
        name: item.getAttribute('name') || '',
        dataType: item.getAttribute('dataType') || 'String',
        required: item.getAttribute('required') === 'true',
        default: item.getAttribute('default')
      });
    }

    // Extract activities
    const activitiesNode = procDef?.querySelector('Activities');
    for (const activity of activitiesNode?.querySelectorAll('Activity') || []) {
      result.activities.push({
        id: activity.getAttribute('id') || '',
        type: activity.getAttribute('type') || 'task',
        name: activity.getAttribute('name') || '',
        formId: activity.querySelector('FormId')?.textContent,
        addressee: parseAddressee(activity),
        timeout: parseTimeout(activity),
        notifyTemplate: activity.querySelector('NotifyTemplate')?.getAttribute('id')
      });
    }

    // Extract forms
    const formsNode = procDef?.querySelector('Forms');
    for (const form of formsNode?.querySelectorAll('Form') || []) {
      const formId = form.getAttribute('id');
      const fields: FormField[] = [];
      
      for (const field of form.querySelectorAll('Field')) {
        fields.push({
          name: field.getAttribute('name') || '',
          dataType: field.getAttribute('dataType') || 'string',
          required: field.getAttribute('required') === 'true',
          options: parseOptions(field)
        });
      }
      
      result.forms.push({
        id: formId,
        name: form.getAttribute('name') || formId,
        fields
      });
    }

    // Extract links/transitions
    const linksNode = procDef?.querySelector('Links');
    for (const link of linksNode?.querySelectorAll('Link') || []) {
      result.links.push({
        id: link.getAttribute('id') || '',
        sourceActivityId: link.getAttribute('sourceActivityId') || '',
        targetActivityId: link.getAttribute('targetActivityId') || '',
        condition: link.getAttribute('condition')
      });
    }

    // Pretty-print XML for storage
    result.decodedXml = prettifyXml(prdXml);

  } catch (err) {
    console.error('[PRD] Extraction failed:', err);
    throw err;
  }

  return result;
}
```

### 3. LLM Summarization

**File:** `src/main/ipcHandlers.ts` (LLM section)

```typescript
if (modelId && !isCancelled()) {
  emitProgress('llm-summary', 'Starting LLM analysis', 38);
  
  try {
    for (let i = 0; i < resultsArray.length; i++) {
      if (isCancelled()) return { success: false, error: 'Cancelled' };
      
      const r = resultsArray[i];
      emitProgress(
        'llm-summary-item',
        `Summarizing candidate ${i + 1}/${resultsArray.length}`,
        42 + (i / resultsArray.length * 22)
      );

      // Build structured prompt
      const structured = {
        processId: r.processId,
        processVersion: r.processVersion,
        forms: r.forms,
        activities: r.activities,
        links: r.links,
        dataItems: r.dataItems
      };

      const prompt = `You are a workflow expert. Analyze the PRD and produce:

1. TECHNICAL SUMMARY for engineers:
   - Process flow and conditions
   - Each activity: id, type, behavior, form, transitions
   - All data items and their usage
   - Exact form fields with types
   - Timeouts and notifications

2. BEGINNER-FRIENDLY EXPLANATION:
   - What this process accomplishes in plain language
   - Who is involved (roles)
   - Step-by-step walkthrough
   - Data collected and why
   - Key validation points

Be exhaustive with details. Here's the structured data:

${JSON.stringify(structured, null, 2)}`;

      // Stream LLM response
      let summary = '';
      await new Promise((resolve, reject) => {
        streamChatCompletion(
          modelId,
          [{ role: 'user', content: prompt }],
          (chunk) => { summary += chunk; },
          () => { resolve(null); },
          reject,
          undefined,
          'You are an expert workflow analyst.'
        );
      });

      // Auto-expand if too short
      if (summary.trim().length < 300) {
        const expandPrompt = `Expand your previous answer. Keep BOTH required sections...`;
        const expanded = await streamAndCollect(modelId, expandPrompt);
        if (expanded.trim().length > summary.trim().length) {
          summary = expanded;
        }
      }

      r.summary = summary;
    }
    
    emitProgress('llm-summary-complete', 'LLM analysis complete', 64);
    
  } catch (err) {
    console.warn('[IPC] LLM summary failed:', err);
    // Continue without summary on LLM error
  }
}
```

### 4. BPMN Generation

**File:** `src/main/workflow/prdConverter.ts`

```typescript
function generateBpmnWorkflow(analysis: PrdAnalysisResult): string {
  const bpmn = createBpmnDocument();
  const process = bpmn.createProcess(analysis.processId, analysis.processName);

  // Create start event
  const startEvent = process.createStartEvent('Event_start', 'Start');
  let lastElement = startEvent;

  // Map each activity
  for (const activity of analysis.activities) {
    let newElement: BpmnElement;

    switch (activity.type) {
      case 'start':
        newElement = startEvent;
        break;
      
      case 'end':
        newElement = process.createEndEvent(
          `Event_end_${activity.id}`,
          activity.name
        );
        break;
      
      case 'form':
      case 'human':
        newElement = process.createUserTask(
          `Task_${activity.id}`,
          activity.name
        );
        if (activity.formId) {
          newElement.attachExtension('formRef', activity.formId);
        }
        
        // Add timeout boundary event if present
        if (activity.timeout) {
          const boundaryEvent = process.createBoundaryEvent(
            `Event_timeout_${activity.id}`,
            newElement.id
          );
          boundaryEvent.addTimerEventDefinition(activity.timeout.duration);
          newElement.attachBoundaryEvent(boundaryEvent);
        }
        break;
      
      case 'decision':
      case 'gateway':
        newElement = process.createExclusiveGateway(
          `Gateway_${activity.id}`,
          activity.name
        );
        break;
      
      case 'system':
        newElement = process.createServiceTask(
          `Task_${activity.id}`,
          activity.name
        );
        break;
      
      default:
        newElement = process.createUserTask(
          `Task_${activity.id}`,
          activity.name
        );
    }

    // Connect to previous element
    if (lastElement && lastElement !== newElement) {
      process.createSequenceFlow(
        `Flow_${lastElement.id}_${newElement.id}`,
        lastElement.id,
        newElement.id
      );
    }

    lastElement = newElement;
  }

  // Add transitions with conditions
  for (const link of analysis.links) {
    const flow = process.createSequenceFlow(
      `Flow_${link.id}`,
      link.sourceActivityId,
      link.targetActivityId
    );
    
    if (link.condition) {
      flow.addConditionExpression(link.condition);
    }
  }

  return bpmn.toXml();
}
```

### 5. Form Schema Generation

**File:** `src/main/workflow/prdConverter.ts`

```typescript
function generateFormSchemas(
  prdForms: PrdForm[],
  dataItems: PrdDataItem[]
): FormSchema[] {
  return prdForms.map(prdForm => ({
    id: prdForm.id,
    name: prdForm.name,
    fields: prdForm.fields.map(prdField => {
      const dataItem = dataItems.find(d => d.name === prdField.name);
      
      return {
        name: prdField.name,
        type: mapDataTypeToFieldType(prdField.dataType),
        label: humanize(prdField.name),
        required: prdField.required || dataItem?.required || false,
        
        // Add type-specific properties
        ...(prdField.dataType === 'select' && {
          options: prdField.options?.map(opt => ({
            value: opt.value,
            label: opt.label || opt.value
          })) || []
        }),
        
        ...(prdField.dataType === 'number' && {
          min: dataItem?.min,
          max: dataItem?.max,
          step: 1
        }),
        
        ...(prdField.dataType === 'string' && {
          minLength: 1,
          maxLength: dataItem?.maxLength || 255
        })
      };
    })
  }));
}

// Data type mapping
function mapDataTypeToFieldType(prdType: string): FormFieldType {
  const mapping: Record<string, FormFieldType> = {
    'String': 'text',
    'Integer': 'number',
    'Boolean': 'checkbox',
    'Date': 'date',
    'Double': 'number',
    'Long': 'number',
    'Decimal': 'number',
    'select': 'select',
    'textarea': 'textarea'
  };
  
  return mapping[prdType] || 'text';
}
```

### 6. Artifact Persistence

**File:** `src/main/ipcHandlers.ts` (artifact writing)

```typescript
async function writeArtifacts(outputDir: string, result: PrdAnalysisResult) {
  // Write decoded XML
  if (result.decodedXml) {
    const xmlPath = path.join(outputDir, 'decoded-0.xml');
    await fs.writeFile(xmlPath, result.decodedXml, 'utf8');
  }

  // Write BPMN workflow
  if (result.workflowXml) {
    const bpmnPath = path.join(outputDir, 'workflow-0.xml');
    await fs.writeFile(bpmnPath, result.workflowXml, 'utf8');
  }

  // Write forms JSON
  if (result.formsJson) {
    const formsPath = path.join(outputDir, 'forms-0.json');
    await fs.writeFile(formsPath, result.formsJson, 'utf8');
    
    // Split individual forms
    const formSchemas = JSON.parse(result.formsJson);
    const formsDir = path.join(outputDir, 'forms-0');
    await fs.mkdir(formsDir, { recursive: true });
    
    for (const form of formSchemas) {
      const formPath = path.join(formsDir, `${form.id}.json`);
      await fs.writeFile(formPath, JSON.stringify(form, null, 2), 'utf8');
    }
  }

  // Write summary
  if (result.summary) {
    const summaryPath = path.join(outputDir, 'summary-0.md');
    await fs.writeFile(summaryPath, result.summary, 'utf8');
  }

  // Write todo list
  if (result.prdTodoList?.length) {
    const todoLines = ['# PRD Todo List', ''];
    result.prdTodoList.forEach(todo => {
      const mark = todo.status === 'completed' ? 'x' : ' ';
      todoLines.push(`- [${mark}] ${todo.title}`);
    });
    
    const todoPath = path.join(outputDir, 'todo-0.md');
    await fs.writeFile(todoPath, todoLines.join('\n'), 'utf8');
  }
}
```

---

## Error Handling

### Error Scenarios

| Scenario | Handler | Recovery |
|----------|---------|----------|
| Invalid XML | DOMParser error catch | Return: `{ success: false, error: 'XML parse error' }` |
| Missing required element | Validation check | Log warning, set default value |
| LLM API timeout | Catch in stream handler | Continue without summary |
| File write permission denied | fs.writeFile catch | Return: `{ success: false, error: 'Permission denied' }` |
| User cancellation | `isCancelled()` check | Emit: `{ success: false, error: 'Cancelled' }` |
| Out of memory | Process crash prevention | Stream large files; split PRDs |

### Graceful Degradation

```typescript
// If LLM fails, continue with structural data
try {
  const summary = await getLlmSummary();
  result.summary = summary;
} catch (err) {
  console.warn('LLM failed, continuing:', err);
  // result.summary remains undefined - that's OK
}

// If forms extraction fails, continue without forms
try {
  result.formsJson = generateFormSchemas(analysis.forms);
} catch (err) {
  console.warn('Form generation failed:', err);
  // result.formsJson remains undefined
}

// Always return what we have
return { success: true, outputDir, ...results };
```

---

## Performance Optimization

### 1. Streaming Large Files

```typescript
// For large XML files, use streaming parser
const stream = fs.createReadStream(filePath);
const parser = new StreamingXmlParser();

parser.on('element', (element) => {
  // Process element incrementally
  if (element.tagName === 'Activity') {
    result.activities.push(parseActivity(element));
  }
});

stream.pipe(parser);
```

### 2. Memory-Efficient LLM Streaming

```typescript
// Don't buffer entire LLM response
let summary = '';
await streamChatCompletion(
  model,
  messages,
  (chunk) => {
    summary += chunk;  // Append chunks
    // Optional: flush to disk if too large
    if (summary.length > 10MB) {
      flushToFile();
      summary = '';
    }
  },
  onComplete,
  onError
);
```

### 3. Parallel Artifact Writing

```typescript
// Write multiple artifacts in parallel
await Promise.all([
  fs.writeFile(xmlPath, result.decodedXml),
  fs.writeFile(bpmnPath, result.workflowXml),
  fs.writeFile(formsPath, result.formsJson),
  fs.writeFile(summaryPath, result.summary)
]);
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('PRD Extraction', () => {
  it('should parse valid PRD XML', () => {
    const result = extractAndAnalyzeFromPrdXml(validPrdXml);
    expect(result.processId).toBe('TEST_PROC');
    expect(result.activities.length).toBeGreaterThan(0);
  });

  it('should handle missing optional elements', () => {
    const result = extractAndAnalyzeFromPrdXml(minimalPrdXml);
    expect(result.success).toBe(true);
    expect(result.dataItems).toEqual([]);
  });

  it('should throw on invalid XML', () => {
    expect(() => {
      extractAndAnalyzeFromPrdXml('<invalid>');
    }).toThrow();
  });
});

describe('BPMN Generation', () => {
  it('should generate valid BPMN XML', () => {
    const analysis = extractAndAnalyzeFromPrdXml(validPrdXml);
    const bpmn = generateBpmnWorkflow(analysis);
    
    expect(bpmn).toContain('bpmn:definitions');
    expect(bpmn).toContain('bpmn:process');
    expect(bpmn).toContain('bpmn:startEvent');
  });
});
```

### Integration Tests

```typescript
describe('Conversion Pipeline', () => {
  it('should convert PRD end-to-end', async () => {
    const result = await convertPrd({
      content: validPrdXml,
      modelId: 'test-model'
    });
    
    expect(result.success).toBe(true);
    expect(result.outputDir).toBeDefined();
    expect(result.workflows.length).toBeGreaterThan(0);
    expect(result.forms.length).toBeGreaterThan(0);
  });

  it('should handle large PRDs', async () => {
    const largePrd = generateLargePrd(1000);  // 1000 activities
    const result = await convertPrd({
      content: largePrd
    });
    
    expect(result.success).toBe(true);
  });
});
```

---

## Monitoring and Debugging

### Debug Logging

```typescript
// Enable debug output
process.env.DEBUG = 'copilot:workflow:*';

console.log('[PRD] Starting extraction');
console.log('[PRD] Found activities:', analysis.activities.length);
console.log('[PRD] Found forms:', analysis.forms.length);
console.log('[PRD] Generation complete in', Date.now() - startTime, 'ms');
```

### Progress Tracking

```typescript
// Monitor conversion progress in renderer
ipcRenderer.on('workflow:convertPrd:progress', (_event, progress) => {
  logger.debug('Conversion progress:', {
    stage: progress.stage,
    percent: progress.percent,
    message: progress.message,
    details: progress.details
  });
});
```

### Performance Metrics

```typescript
const metrics = {
  parseTime: 0,
  extractTime: 0,
  llmTime: 0,
  bpmnGenTime: 0,
  formsGenTime: 0,
  writeTime: 0
};

// Wrap each stage
metrics.parseTime = time(() => parser.parse(xml));
metrics.extractTime = time(() => extractAndAnalyze(xml));
// ... etc

console.table(metrics);
```

---

## Related Files

- **Main converter:** `src/main/workflow/prdConverter.ts`
- **IPC handlers:** `src/main/ipcHandlers.ts`
- **LLM integration:** `src/main/copilotChatApi.ts`
- **Storage:** `src/main/workflow/storage.ts`
- **UI component:** `src/renderer/app/components/convert-prd/convert-prd.component.ts`
- **BPMN viewer:** `src/renderer/app/components/workflow-builder-viewer/`
- **Form viewer:** `src/renderer/app/components/formio-builder-viewer/`

---

**Last Updated:** 2026-07-21  
**Version:** 1.0
