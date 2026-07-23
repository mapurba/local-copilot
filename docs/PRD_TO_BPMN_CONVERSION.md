# PRD to BPMN Workflow Conversion Guide

## Overview

The Local Copilot Chat application includes a sophisticated **PRD (Process Request Definition) conversion engine** that transforms legacy XML-based process definitions into modern BPMN 2.0 (Business Process Model and Notation) compliant workflows with AI-generated forms. This document explains the complete conversion pipeline, architecture, and usage patterns.

## Table of Contents

1. [Conversion Architecture](#conversion-architecture)
2. [PRD XML Format](#prd-xml-format)
3. [Conversion Pipeline](#conversion-pipeline)
4. [BPMN Output Format](#bpmn-output-format)
5. [Forms Generation](#forms-generation)
6. [API Reference](#api-reference)
7. [Usage Examples](#usage-examples)
8. [Troubleshooting](#troubleshooting)

---

## Conversion Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│  User Interface (React/Angular)                             │
│  - Convert PRD Component                                    │
│  - File upload or paste XML                                │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────┐
│  IPC Bridge (ipcHandlers.ts)                               │
│  - Main process ↔ Renderer communication                    │
│  - workflow:convertPrd handler                             │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────┐
│  Conversion Engine (prdConverter.ts)                        │
│  - extractAndAnalyzeFromPrdXml()                           │
│  - Parses PRD XML structure                                │
│  - Validates and normalizes data                           │
└────────────┬────────────────────────────────────────────────┘
             │
             ├─────────────────────────────┬──────────────────┐
             ▼                             ▼                  ▼
    ┌──────────────┐           ┌──────────────────┐   ┌────────────┐
    │  Decoded XML │           │  LLM Summarizer  │   │  Activity  │
    │  Extraction  │           │  (optional)      │   │  Analyzer  │
    └──────────────┘           └──────────────────┘   └────────────┘
             │                         │                   │
             └─────────────────────────┼───────────────────┘
                                       ▼
                           ┌──────────────────────┐
                           │  BPMN Generator      │
                           │  - Workflow XML      │
                           │  - Forms JSON        │
                           │  - Todo List (Md)    │
                           └──────────────────────┘
                                       │
             ┌─────────────────────────┴────────────────────┐
             ▼                                               ▼
    ┌──────────────────┐                          ┌──────────────────┐
    │  Storage Layer   │                          │  Output Files    │
    │  (getWorkflow    │                          │  - workflow.xml  │
    │   OutputDir)     │                          │  - forms.json    │
    └──────────────────┘                          │  - summary.md    │
                                                  │  - todo.md       │
                                                  └──────────────────┘
```

### Key Classes and Functions

| Component | File | Purpose |
|-----------|------|---------|
| `extractAndAnalyzeFromPrdXml()` | `src/main/workflow/prdConverter.ts` | Main entry point: parses PRD XML and extracts structured data |
| `normalizeResults()` | `src/main/ipcHandlers.ts` | Handles variable result shapes (single object or array) |
| `streamChatCompletion()` | `src/main/copilotChatApi.ts` | Streams AI-generated summaries and form schemas |
| `generateJson()` | `src/main/workflow/llm.ts` | LLM-based JSON schema generation for forms |
| `WorkflowSchema` | `src/main/workflow/workflowschema.ts` | Validates and type-checks BPMN structure |
| `storage` functions | `src/main/workflow/storage.ts` | Manages workflow output directory and file persistence |

---

## PRD XML Format

### Legacy PRD Structure

Old PRD XML follows a hierarchical structure designed for enterprise workflow systems:

```xml
<?xml version="1.0"?>
<PRD version="1.0">
  <ProcessDefinition id="PROC_ID" version="1.0" name="Process Name">
    
    <!-- Global process-level data items -->
    <DataItems>
      <DataItem name="requestId" dataType="String" required="true" />
      <DataItem name="approvalStatus" dataType="String" default="pending" />
    </DataItems>

    <!-- Activities (process steps) -->
    <Activities>
      <Activity id="START" type="start" name="Start Process">
        <OutgoingTransition targetActivityId="SUBMIT_FORM" />
      </Activity>

      <Activity id="SUBMIT_FORM" type="form" name="Submit Request">
        <FormId>form1</FormId>
        <Addressee role="requester" />
        <OutgoingTransition targetActivityId="REVIEW" condition="status == 'submitted'" />
      </Activity>

      <Activity id="REVIEW" type="human" name="Manager Review">
        <Addressee role="manager" />
        <Timeout duration="2" unit="days" action="reassign" />
        <NotifyTemplate id="notify_review" />
        <OutgoingTransition targetActivityId="APPROVE" />
      </Activity>

      <Activity id="APPROVE" type="decision" name="Approval Decision">
        <Condition expression="approved == true">
          <OutgoingTransition targetActivityId="END_SUCCESS" />
        </Condition>
        <Condition expression="approved == false">
          <OutgoingTransition targetActivityId="END_REJECTED" />
        </Condition>
      </Activity>

      <Activity id="END_SUCCESS" type="end" name="Process Approved" />
      <Activity id="END_REJECTED" type="end" name="Process Rejected" />
    </Activities>

    <!-- Forms definition -->
    <Forms>
      <Form id="form1" name="Request Form">
        <Fields>
          <Field name="description" dataType="text" required="true" />
          <Field name="amount" dataType="number" required="true" />
          <Field name="category" dataType="select" required="true">
            <Options>
              <Option value="opt1">Option 1</Option>
              <Option value="opt2">Option 2</Option>
            </Options>
          </Field>
        </Fields>
      </Form>
    </Forms>

    <!-- Links/transitions with conditions -->
    <Links>
      <Link id="link1" sourceActivityId="SUBMIT_FORM" targetActivityId="REVIEW" 
            condition="status == 'submitted'" />
    </Links>
  </ProcessDefinition>
</PRD>
```

### Supported PRD Elements

#### Activity Types
- **start**: Marks the beginning of the process
- **end**: Marks the end of the process
- **form**: User fills out a form (interactive)
- **human**: Manual human task (review, decision)
- **decision**: Conditional branching
- **system**: Automated system task
- **provisioning**: Account/resource creation (ProvisioningOperation elements)

#### Data Items
- String, Integer, Boolean, Date, Long, Decimal, Double types
- Optional default values
- Required/optional flags
- Used throughout the process for data exchange

#### Transitions
- Source and target activities
- Optional XPath/JavaScript conditions
- Timeout behavior (reassign, escalate, abort)
- Notification templates

---

## Conversion Pipeline

### Stage 1: XML Parsing and Extraction

**Function:** `extractAndAnalyzeFromPrdXml(prdXml: string)`

```typescript
const result = extractAndAnalyzeFromPrdXml(prdXml);
```

**What it does:**
1. Parses XML using DOMParser or xml2js
2. Validates against PRD schema
3. Extracts structured data:
   - Process metadata (id, version, name)
   - Activities with types and properties
   - Data items (name, type, default value)
   - Forms and field definitions
   - Transitions/links with conditions
   - Notification templates

**Output Structure:**
```typescript
interface PrdAnalysisResult {
  processId: string;
  processVersion: string;
  processName: string;
  
  activities: Activity[];        // All process steps
  dataItems: DataItem[];          // Global variables
  forms: Form[];                  // Form definitions
  links: Link[];                  // Transitions
  notifyTemplates?: any[];        // Email/notification templates
  
  decodedXml: string;             // Pretty-printed original XML
  
  // Optional: AI-generated content (if LLM model provided)
  summary?: string;               // Markdown summary
  prdTodoList?: TodoItem[];       // Extracted action items
  
  // Generated artifacts:
  workflowXml?: string;           // BPMN 2.0 XML
  formsJson?: string;             // JSON form schemas
}
```

### Stage 2: Optional AI-Powered Summarization

**Triggered by:** Providing a `modelId` in the conversion request

```typescript
const result = await convertPrd({
  content: prdXml,
  modelId: 'gpt-4-turbo'  // Enables LLM summarization
});
```

**What the LLM does:**
1. Reads the extracted structured data (activities, forms, data items)
2. Generates a **Technical Summary**:
   - Process flow and logic
   - All activities with exact behavior
   - Conditions and transitions
   - Data mappings
   - Form field specifications
   
3. Generates a **Beginner-Friendly Explanation**:
   - Plain-English process intent
   - Who is involved (roles)
   - Step-by-step workflow walkthrough
   - Data collected and why
   - Key risks and validations

**Prompt Strategy:**
- First request: Concise summary
- If too short: Automatic expansion request with explicit guidance
- Ensures exhaustive coverage of all activities and transitions

### Stage 3: BPMN Generation

**Function:** Implicit in conversion flow, generates `workflowXml`

The extracted PRD data is transformed into BPMN 2.0:

- **PRD Activities** → **BPMN Tasks, Gateways, Events**
- **PRD Transitions** → **BPMN Sequence Flows**
- **PRD Conditions** → **BPMN Gateway Conditions**
- **PRD Timeouts** → **BPMN Timer Boundary Events**
- **PRD Forms** → **User Task Extensions**

Example mapping:

| PRD | BPMN |
|-----|------|
| `<Activity type="start">` | `<startEvent>` |
| `<Activity type="human">` | `<userTask>` |
| `<Activity type="decision">` | `<exclusiveGateway>` |
| `<Activity type="end">` | `<endEvent>` |
| `<Activity type="form">` | `<userTask>` with form binding |
| `<Timeout action="reassign">` | `<boundaryEvent type="timer">` with escalation |

### Stage 4: Forms Generation

Forms are extracted from PRD and optionally enhanced with AI:

```json
{
  "id": "form1",
  "name": "Request Form",
  "fields": [
    {
      "name": "description",
      "type": "text",
      "label": "Request Description",
      "required": true,
      "placeholder": "Enter a brief description"
    },
    {
      "name": "amount",
      "type": "number",
      "label": "Amount",
      "required": true,
      "min": 0,
      "max": 100000
    },
    {
      "name": "category",
      "type": "select",
      "label": "Category",
      "options": [
        { "value": "opt1", "label": "Option 1" },
        { "value": "opt2", "label": "Option 2" }
      ]
    }
  ]
}
```

### Stage 5: Artifact Persistence

All converted artifacts are saved to the output directory:

```
workflow-agent/output/converted-prd-{timestamp}/
├── decoded-0.xml              # Original PRD (pretty-printed)
├── workflow-0.xml             # BPMN 2.0 workflow
├── forms-0.json               # Forms array
├── forms-0/
│   ├── form1.json             # Individual form schema
│   └── form2.json
├── summary-0.md               # AI-generated summary (if LLM used)
├── todo-0.md                  # Extracted action items
└── notifyTemplates-0.json     # Email/notification templates
```

---

## BPMN Output Format

### Example BPMN 2.0 Workflow

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   id="Definitions_converted_prd"
                   targetNamespace="http://bpmn.io/schema/bpmn">

  <bpmn:process id="PROC_ID" name="Process Name" isExecutable="true">
    
    <!-- Start Event -->
    <bpmn:startEvent id="Event_start" name="Start Process">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>

    <!-- User Task: Form Submission -->
    <bpmn:userTask id="Task_submit_form" name="Submit Request">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
      <bpmn:extensionElements>
        <formRef>form1</formRef>
      </bpmn:extensionElements>
    </bpmn:userTask>

    <!-- User Task: Manual Review -->
    <bpmn:userTask id="Task_review" name="Manager Review">
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:outgoing>Flow_3</bpmn:outgoing>
      <!-- Boundary timer event for timeout -->
      <bpmn:boundaryEvent id="Event_timeout" attachedToRef="Task_review">
        <bpmn:timerEventDefinition>
          <bpmn:timeDuration>P2D</bpmn:timeDuration>
        </bpmn:timerEventDefinition>
        <bpmn:outgoing>Flow_escalate</bpmn:outgoing>
      </bpmn:boundaryEvent>
    </bpmn:userTask>

    <!-- Exclusive Gateway: Approval Decision -->
    <bpmn:exclusiveGateway id="Gateway_approve" name="Approved?">
      <bpmn:incoming>Flow_3</bpmn:incoming>
      <bpmn:outgoing>Flow_approve_yes</bpmn:outgoing>
      <bpmn:outgoing>Flow_approve_no</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <!-- End Events -->
    <bpmn:endEvent id="Event_end_success" name="Process Approved">
      <bpmn:incoming>Flow_approve_yes</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:endEvent id="Event_end_rejected" name="Process Rejected">
      <bpmn:incoming>Flow_approve_no</bpmn:incoming>
    </bpmn:endEvent>

    <!-- Sequence Flows -->
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Event_start" targetRef="Task_submit_form" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_submit_form" targetRef="Task_review" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_review" targetRef="Gateway_approve" />
    <bpmn:sequenceFlow id="Flow_approve_yes" sourceRef="Gateway_approve" targetRef="Event_end_success">
      <bpmn:conditionExpression>approved == true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_approve_no" sourceRef="Gateway_approve" targetRef="Event_end_rejected">
      <bpmn:conditionExpression>approved == false</bpmn:conditionExpression>
    </bpmn:sequenceFlow>

  </bpmn:process>

  <!-- Diagram info -->
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <!-- ... visual positioning info ... -->
  </bpmndi:BPMNDiagram>

</bpmn:definitions>
```

### BPMN Element Mapping Reference

| BPMN Element | Use Case | PRD Equivalent |
|--------------|----------|---|
| `startEvent` | Process entry point | `<Activity type="start">` |
| `endEvent` | Process completion | `<Activity type="end">` |
| `userTask` | Manual work by human | `<Activity type="form">` or `<Activity type="human">` |
| `serviceTask` | Automated work | `<Activity type="system">` |
| `exclusiveGateway` | If/then branching | `<Activity type="decision">` |
| `parallelGateway` | Parallel paths | `<Activity type="parallel">` |
| `sequenceFlow` | Transition | `<Link>` |
| `boundaryEvent` | Timeout/error handling | `<Timeout>` |
| `dataObject` | Process variable | `<DataItem>` |

---

## Forms Generation

### Form Schema Structure

Generated forms use a JSON schema compatible with Formio, JSON Forms, or React Hook Form:

```typescript
interface FormSchema {
  id: string;                           // Unique form identifier
  name: string;                         // Display name
  title?: string;                       // Form title
  description?: string;                 // Form description
  
  fields: FormField[];                  // Array of form fields
  
  validation?: {
    required?: string[];                // Required field names
    dependencies?: Record<string, any>; // Field dependencies
  };
}

interface FormField {
  name: string;                         // Field key in data object
  type: 'text' | 'number' | 'select' |  // Field type
        'checkbox' | 'radio' | 'date' | 
        'textarea' | 'email' | 'password';
  
  label: string;                        // Display label
  description?: string;                 // Help text
  placeholder?: string;                 // Placeholder text
  required?: boolean;                   // Is required
  
  // For select/radio:
  options?: Array<{
    value: string | number;
    label: string;
  }>;
  
  // For number fields:
  min?: number;
  max?: number;
  step?: number;
  
  // For text:
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  
  validation?: {
    type?: 'email' | 'url' | 'custom';
    message?: string;
    pattern?: RegExp;
  };
}
```

### AI-Generated Form Enhancements (Optional)

When LLM model is provided, the system can:

1. **Auto-generate field types** based on context
2. **Add validation rules** based on data usage
3. **Suggest default values** from process context
4. **Generate help text** explaining each field
5. **Group related fields** into sections

Example AI enhancement:
```json
{
  "name": "amount",
  "type": "number",
  "label": "Request Amount",
  "description": "The total amount being requested. Must be between $100 and $50,000.",
  "required": true,
  "min": 100,
  "max": 50000,
  "step": 0.01,
  "validation": {
    "pattern": "^[0-9]+(\\.[0-9]{2})?$",
    "message": "Please enter a valid amount with up to 2 decimal places"
  }
}
```

---

## API Reference

### Main IPC Handler

#### `workflow:convertPrd`

**Purpose:** Convert PRD XML to BPMN workflow and forms

**Request:**
```typescript
interface ConvertPrdRequest {
  content?: string;                    // Raw PRD XML (if pasting)
  filePath?: string;                   // Path to PRD XML file (if uploading)
  modelId?: string;                    // Optional: AI model for summarization
  fileName?: string;                   // Original filename for display
  requestId?: string;                  // Unique request ID (generated if not provided)
}
```

**Response:**
```typescript
interface ConvertPrdResponse {
  success: boolean;
  error?: string;
  
  // Only on success:
  outputDir?: string;                  // Directory where artifacts saved
  
  // Artifacts:
  decoded?: string[];                  // Paths to decoded XML files
  summaries?: string[];                // Paths to AI summaries
  workflows?: string[];                // Paths to BPMN XML files
  forms?: string[];                    // Paths to form JSON files
  todos?: string[];                    // Paths to todo lists
}
```

**Progress Events:**
The handler emits progress events via IPC:
```typescript
ipcRenderer.on('workflow:convertPrd:progress', (event, progress) => {
  console.log(`${progress.stage}: ${progress.message}`);
  console.log(`Progress: ${progress.percent}%`);
});
```

Progress stages:
- `started`: Conversion beginning
- `reading-file`: Reading input file
- `parsing`: Extracting PRD structure
- `parsed`: PRD analysis complete
- `llm-summary`: LLM starting
- `llm-summary-item`: Processing each candidate
- `llm-summary-complete`: LLM done
- `saving`: Preparing output
- `output-ready`: Output directory created
- `saving-item`: Writing individual artifacts
- `complete`: All done
- `cancelled`: User cancelled
- `failed`: Error occurred

### Supporting Functions

#### `extractAndAnalyzeFromPrdXml(prdXml: string)`

**File:** `src/main/workflow/prdConverter.ts`

```typescript
function extractAndAnalyzeFromPrdXml(prdXml: string): PrdAnalysisResult | PrdAnalysisResult[] {
  // Parses PRD XML
  // Extracts activities, forms, data items, transitions
  // Returns structured result(s)
}
```

#### `generateJson(prompt: string, model: string)`

**File:** `src/main/workflow/llm.ts`

```typescript
async function generateJson(prompt: string, model: string): Promise<any> {
  // Calls LLM to generate JSON (form schemas, etc.)
  // Parses and validates JSON response
  // Returns typed result
}
```

#### `streamChatCompletion(...)`

**File:** `src/main/copilotChatApi.ts`

```typescript
function streamChatCompletion(
  model: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  onComplete: () => void,
  onError: (err: Error) => void,
  tools?: any[],
  systemPrompt?: string
): void
```

---

## Usage Examples

### Example 1: Simple PRD Conversion (No LLM)

```typescript
// From renderer process
import { ipcRenderer } from 'electron';

const prdXml = `<?xml version="1.0"?>
  <PRD version="1.0">
    <ProcessDefinition id="TEST_PROC" ...>
      <!-- ... PRD content ... -->
    </ProcessDefinition>
  </PRD>`;

const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXml,
  fileName: 'test-process.xml'
});

if (result.success) {
  console.log(`Saved to: ${result.outputDir}`);
  console.log(`Workflows: ${result.workflows}`);
  console.log(`Forms: ${result.forms}`);
} else {
  console.error(`Conversion failed: ${result.error}`);
}
```

### Example 2: Conversion with AI Summarization

```typescript
const result = await ipcRenderer.invoke('workflow:convertPrd', {
  content: prdXml,
  modelId: 'gpt-4-turbo',  // Enable LLM
  requestId: 'user-request-123'
});

// Listen to progress
ipcRenderer.on('workflow:convertPrd:progress', (_event, progress) => {
  updateProgressBar(progress.percent);
  updateStatus(`${progress.stage}: ${progress.message}`);
  
  if (progress.stage === 'complete') {
    console.log(`Conversion complete!`);
    console.log(`Output directory: ${progress.details.outputDir}`);
  }
});
```

### Example 3: File Upload Conversion

```typescript
// User selects file in UI
const filePath = '/path/to/old-process.xml';

const result = await ipcRenderer.invoke('workflow:convertPrd', {
  filePath: filePath,
  fileName: 'old-process.xml',
  modelId: 'gpt-4-turbo'
});

// Read generated BPMN
const bpmnPath = result.workflows[0];
const bpmnContent = await fs.promises.readFile(bpmnPath, 'utf8');
renderBpmnDiagram(bpmnContent);  // Display in diagram viewer
```

### Example 4: Processing Multiple PRDs

```typescript
const prds = [
  { path: 'proc1.xml', name: 'Approval Process' },
  { path: 'proc2.xml', name: 'Onboarding' },
  { path: 'proc3.xml', name: 'Provisioning' }
];

for (const prd of prds) {
  try {
    const result = await ipcRenderer.invoke('workflow:convertPrd', {
      filePath: prd.path,
      fileName: prd.name,
      modelId: 'gpt-4-turbo'
    });
    
    console.log(`✓ ${prd.name}: ${result.workflows[0]}`);
  } catch (err) {
    console.error(`✗ ${prd.name}: ${err}`);
  }
}
```

---

## Advanced Topics

### Customizing BPMN Generation

To customize BPMN output, edit `src/main/workflow/prdConverter.ts`:

```typescript
// Example: Add custom BPMN extensions
function generateBpmnWorkflow(analysis: PrdAnalysisResult): string {
  // Create BPMN document
  // Add custom namespaces
  const bpmn = createBpmnDocument();
  
  // Map PRD elements to BPMN
  for (const activity of analysis.activities) {
    addActivityToBpmn(bpmn, activity, analysis);
  }
  
  for (const link of analysis.links) {
    addTransitionToBpmn(bpmn, link, analysis);
  }
  
  return bpmn.toXml();
}
```

### Extending Form Generation

Add custom field types in `src/main/workflow/prdConverter.ts`:

```typescript
const customFieldTypes = {
  'date-range': { type: 'object', properties: { start: 'date', end: 'date' } },
  'file-upload': { type: 'file', accept: '.pdf,.doc' },
  'signature': { type: 'signature', width: 400, height: 100 }
};
```

### Adding Custom Data Mappers

Define data transformations between PRD and BPMN:

```typescript
const dataMapper = {
  'oldDataType': { bpmnType: 'String', converter: (val) => String(val) },
  'customType': { bpmnType: 'Object', converter: (val) => JSON.parse(val) }
};
```

---

## Troubleshooting

### Issue: Conversion Fails with Parse Error

**Symptom:** `Failed to parse XML`

**Solution:**
1. Validate PRD XML syntax (use xmllint or online validator)
2. Ensure all required elements are present
3. Check character encoding (must be UTF-8)
4. Enable debug logging to see exact parse error

```typescript
// Enable debug logging
process.env.DEBUG = 'copilot:*';
```

### Issue: LLM Summary Takes Too Long

**Symptom:** Progress hangs at `llm-summary` stage

**Solution:**
1. Reduce the size of PRD (split into smaller processes)
2. Use a faster model (e.g., gpt-3.5-turbo instead of gpt-4)
3. Disable LLM summarization (`modelId` not provided)
4. Check network connectivity to LLM API

### Issue: Forms Not Generated

**Symptom:** `forms.json` empty or missing

**Solution:**
1. Verify PRD has `<Forms>` section
2. Check form field definitions have required attributes
3. Look for errors in conversion progress
4. Check output directory permissions

### Issue: BPMN Diagram Won't Render

**Symptom:** Error opening BPMN in diagram viewer

**Solution:**
1. Validate BPMN XML against BPMN 2.0 schema
2. Use https://bpmn.io/toolkit/bpmn-js/ to test
3. Check namespace declarations
4. Ensure all element IDs are unique

### Issue: Path Traversal Security Error

**Symptom:** `Path resolves outside workspace`

**Solution:**
1. Use relative paths from workspace root
2. Avoid `../` in file paths
3. Ensure output directory is within workspace
4. Check file permissions

---

## Best Practices

### 1. Validate PRD Before Conversion

```typescript
function validatePrd(xml: string): { valid: boolean; errors: string[] } {
  const errors = [];
  
  // Check XML syntax
  // Validate against PRD schema
  // Check required elements
  // Verify all references resolve
  
  return { valid: errors.length === 0, errors };
}
```

### 2. Use Meaningful Request IDs

```typescript
const requestId = `${userName}-${processName}-${Date.now()}`;
```

### 3. Monitor Progress for Long Conversions

```typescript
ipcRenderer.on('workflow:convertPrd:progress', (_event, progress) => {
  // Update UI with progress
  // Show current stage to user
  // Allow cancellation
});
```

### 4. Handle Large PRDs

```typescript
// Split large PRDs into smaller pieces
const procs = splitPrdByProcess(largePrdXml);
const results = await Promise.all(
  procs.map(proc => convertSingle(proc))
);
```

### 5. Verify Generated BPMN

```typescript
function verifyBpmn(bpmnXml: string): { valid: boolean; issues: string[] } {
  // Parse as XML
  // Check all transitions have targets
  // Validate gateway conditions
  // Ensure proper nesting
  return { valid: true, issues: [] };
}
```

---

## Performance Considerations

| Operation | Typical Time | Bottleneck |
|-----------|--------------|-----------|
| Small PRD parse (<100 KB) | <100ms | XML parsing |
| Medium PRD parse (100KB-1MB) | 100-500ms | Object building |
| Large PRD parse (>1MB) | 500ms-2s | Memory allocation |
| LLM summarization | 5-30s | Network latency |
| File I/O (save artifacts) | <500ms | Disk speed |

**Optimization tips:**
- Pre-parse XML incrementally for large files
- Cache LLM summaries for identical PRDs
- Use streaming file writes for large outputs
- Consider worker threads for CPU-intensive parsing

---

## Related Documentation

- [BPMN 2.0 Specification](https://www.omg.org/spec/BPMN/2.0/)
- [Copilot Chat API](./copilot-chat-api.md)
- [Workflow Agent](./workflow-agent.md)
- [Forms Schema](./forms-schema.md)

---

**Last Updated:** 2026-07-21  
**Version:** 1.0
