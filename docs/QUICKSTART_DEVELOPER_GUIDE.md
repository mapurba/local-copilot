# PRD Conversion - Quick Start Guide

## Overview

This guide helps developers quickly understand and work with the PRD-to-BPMN conversion system.

## 5-Minute Overview

**What it does:**
- Takes legacy PRD (Process Request Definition) XML files
- Converts them to modern BPMN 2.0 workflow format
- Extracts and generates form schemas
- Optionally summarizes with AI (GPT-4)
- Saves all artifacts to organized output directory

**Key entry point:**
```typescript
// From renderer process
const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXml,      // or filePath: '...'
  modelId: 'gpt-4',     // optional: enables AI summarization
  requestId: 'my-req-1' // optional: track this conversion
});

// Returns: { success: true, outputDir: '...', workflows: [...], forms: [...] }
```

## Common Tasks

### Task 1: Convert a Single PRD File

```typescript
import { ipcRenderer } from 'electron';
import * as fs from 'fs';

// 1. Read PRD file
const prdXml = fs.readFileSync('my-process.xml', 'utf8');

// 2. Invoke conversion
const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXml,
  fileName: 'my-process.xml'
});

// 3. Check results
if (result.success) {
  console.log(`✓ Converted to: ${result.outputDir}`);
  console.log(`  BPMN: ${result.workflows[0]}`);
  console.log(`  Forms: ${result.forms}`);
} else {
  console.error(`✗ Failed: ${result.error}`);
}
```

### Task 2: Add AI Summarization

```typescript
// Just add modelId parameter
const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXml,
  modelId: 'gpt-4-turbo',  // This enables AI
  fileName: 'process.xml'
});

// Result now includes:
// - result.summaries: Paths to AI-generated summaries
// - result.todos: Paths to extracted action items
```

### Task 3: Monitor Progress

```typescript
// Listen to progress events
ipcRenderer.on('workflow:convertPrd:progress', (_event, progress) => {
  console.log(`${progress.stage}: ${progress.message} (${progress.percent}%)`);
  
  // Stages: started, reading-file, parsing, parsed, 
  //         llm-summary, llm-summary-item, llm-summary-complete,
  //         saving, output-ready, saving-item, complete, cancelled
  
  if (progress.stage === 'complete') {
    console.log('✓ Done!', progress.details);
  }
});
```

### Task 4: Process Multiple PRDs

```typescript
const prds = [
  { path: 'proc1.xml', name: 'Approval' },
  { path: 'proc2.xml', name: 'Onboarding' }
];

const results = await Promise.all(
  prds.map(prd => 
    ipcRenderer.invoke('workflow:convertPrd', {
      filePath: prd.path,
      fileName: prd.name,
      modelId: 'gpt-4-turbo'
    })
  )
);

results.forEach((r, i) => {
  console.log(`${prds[i].name}: ${r.success ? '✓' : '✗'}`);
});
```

### Task 5: View Generated BPMN

```typescript
// Read BPMN XML from result
const bpmnPath = result.workflows[0];
const bpmnXml = await fs.promises.readFile(bpmnPath, 'utf8');

// Use BPMN viewer component to display
renderBpmnDiagram(bpmnXml);
```

### Task 6: Parse Generated Forms

```typescript
// Read forms JSON
const formsPath = result.forms.find(f => f.includes('forms-0.json'));
const formsJson = await fs.promises.readFile(formsPath, 'utf8');
const forms = JSON.parse(formsJson);

forms.forEach(form => {
  console.log(`Form: ${form.name}`);
  form.fields.forEach(field => {
    console.log(`  - ${field.name}: ${field.type}`);
  });
});
```

## File Organization

Output directory structure:
```
workflow-agent/output/converted-prd-{timestamp}/
├── decoded-0.xml           # Original PRD (formatted)
├── workflow-0.xml          # BPMN 2.0 workflow
├── forms-0.json            # All forms array
├── forms-0/                # Individual form files
│   ├── form1.json
│   └── form2.json
├── summary-0.md            # AI summary (if LLM used)
└── todo-0.md               # Action items
```

Access from result:
```typescript
result.decoded      // [paths to XML files]
result.workflows    // [paths to BPMN files]
result.forms        // [paths to JSON files]
result.summaries    // [paths to summaries]
result.todos        // [paths to todo lists]
```

## PRD XML Format Cheat Sheet

### Minimal PRD

```xml
<?xml version="1.0"?>
<PRD version="1.0">
  <ProcessDefinition id="MY_PROC" version="1.0" name="My Process">
    <Activities>
      <Activity id="START" type="start" name="Start" />
      <Activity id="TASK1" type="human" name="Review" />
      <Activity id="END" type="end" name="End" />
    </Activities>
  </ProcessDefinition>
</PRD>
```

### With Forms

```xml
<Forms>
  <Form id="form1" name="Request">
    <Fields>
      <Field name="title" dataType="string" required="true" />
      <Field name="amount" dataType="number" required="true" />
      <Field name="category" dataType="select" required="true">
        <Options>
          <Option value="A">Option A</Option>
          <Option value="B">Option B</Option>
        </Options>
      </Field>
    </Fields>
  </Form>
</Forms>
```

### With Data Items

```xml
<DataItems>
  <DataItem name="requestId" dataType="String" required="true" />
  <DataItem name="status" dataType="String" default="pending" />
  <DataItem name="approvalDate" dataType="Date" />
</DataItems>
```

### With Transitions

```xml
<Links>
  <Link id="l1" sourceActivityId="START" targetActivityId="TASK1" />
  <Link id="l2" sourceActivityId="TASK1" targetActivityId="END" 
        condition="approved == true" />
</Links>
```

## Debugging

### Enable Debug Logging

```typescript
// In main process
process.env.DEBUG = 'copilot:workflow:*';
```

### Check What's Wrong

| Issue | Check |
|-------|-------|
| XML parse fails | Validate XML syntax: `xmllint file.xml` |
| No forms in output | Check if PRD has `<Forms>` section |
| BPMN won't render | Validate BPMN with https://bpmn.io |
| LLM summary missing | Check network, API key, model name |
| Files not saved | Check output directory permissions |
| Process hangs | Check for infinite loops, cancel timeout |

### Inspect Intermediate Results

```typescript
// Get the parsed structure before BPMN generation
import { extractAndAnalyzeFromPrdXml } from './workflow/prdConverter';

const analysis = extractAndAnalyzeFromPrdXml(prdXml);
console.log('Activities:', analysis.activities);
console.log('Forms:', analysis.forms);
console.log('DataItems:', analysis.dataItems);
console.log('Links:', analysis.links);
```

## Code Locations

| Task | File | Function |
|------|------|----------|
| Entry point | `src/main/ipcHandlers.ts` | `ipcMain.handle('workflow:convertPrd', ...)` |
| PRD parsing | `src/main/workflow/prdConverter.ts` | `extractAndAnalyzeFromPrdXml()` |
| BPMN generation | `src/main/workflow/prdConverter.ts` | `generateBpmnWorkflow()` |
| Forms generation | `src/main/workflow/prdConverter.ts` | `generateFormSchemas()` |
| LLM integration | `src/main/copilotChatApi.ts` | `streamChatCompletion()` |
| File storage | `src/main/workflow/storage.ts` | `getWorkflowOutputDir()` |
| UI component | `src/renderer/app/components/convert-prd/` | `ConvertPrdComponent` |

## Architecture Diagram

```
User Input (file/paste)
    ↓
Extract PRD structure
    ↓
Optional: AI summarization
    ├─ Generate technical summary
    └─ Generate beginner guide
    ↓
Generate BPMN workflow
    ├─ Map activities to BPMN elements
    ├─ Convert conditions
    └─ Add timeouts as boundary events
    ↓
Generate form schemas
    ├─ Extract form fields
    └─ Add validation rules
    ↓
Save artifacts
    ├─ Write XML files
    ├─ Write JSON files
    ├─ Write Markdown
    └─ Create output structure
    ↓
Return success + file paths
```

## Common Patterns

### Pattern 1: Upload File

```typescript
// In UI component
selectFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xml';
  input.onchange = async (e: any) => {
    const file = e.target.files[0];
    const content = await file.text();
    
    this.result = await ipcRenderer.invoke('workflow:convertPrd', {
      content,
      fileName: file.name
    });
  };
  input.click();
}
```

### Pattern 2: Paste XML

```typescript
// In UI component
@HostListener('paste', ['$event'])
onPaste(e: ClipboardEvent) {
  const xml = e.clipboardData?.getData('text');
  
  this.result = await ipcRenderer.invoke('workflow:convertPrd', {
    content: xml,
    fileName: 'pasted-process.xml'
  });
}
```

### Pattern 3: Display Results

```typescript
// In component
if (this.result.success) {
  // Show BPMN diagram
  this.bpmnXml = readFile(this.result.workflows[0]);
  this.displayBpmn();
  
  // Show forms
  const forms = JSON.parse(readFile(this.result.forms[0]));
  this.displayForms(forms);
  
  // Show summary
  const summary = readFile(this.result.summaries[0]);
  this.displaySummary(summary);
} else {
  this.error = this.result.error;
}
```

## Performance Tips

| Scenario | Tip |
|----------|-----|
| Large PRD (>10MB) | Split into smaller files |
| Slow LLM | Use gpt-3.5-turbo instead of gpt-4 |
| Memory issues | Process streaming; increase Node heap |
| Network timeout | Increase LLM timeout, add retry logic |
| File I/O slow | Use parallel writes with `Promise.all()` |

## Next Steps

1. **Read full docs:** See `PRD_TO_BPMN_CONVERSION.md` for complete reference
2. **Study implementation:** See `IMPLEMENTATION_ARCHITECTURE.md` for deep dive
3. **View examples:** Check `src/renderer/app/components/convert-prd/` for UI usage
4. **Run tests:** `npm test -- workflow` to test conversion engine
5. **Explore BPMN:** Visit https://bpmn.io/ to understand BPMN format

---

**Last Updated:** 2026-07-21  
**Version:** 1.0
