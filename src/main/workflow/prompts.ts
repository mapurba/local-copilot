export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful AI assistant specializing in NetIQ Identity Governance workflows. Always respond with valid, well-structured JSON only — no markdown fences, no prose.';

// ─── Full activity schema used in system prompts ───────────────────────────────
export const ACTIVITY_SCHEMA = {
  types: [
    {
      type: 'start',
      tag: 'iam_1:start-activity',
      description: 'Initiates the workflow. Always required as the first activity.',
      attributes: {
        'form-id': { required: true, description: 'ID of the request form shown to the initiator' },
        'resource-name-override': { required: false, description: 'Optional display name override' },
      },
    },
    {
      type: 'user',
      tag: 'iam_1:user-activity',
      description: 'A human task for approvals, reviews, or data collection.',
      attributes: {
        'form-id': { required: true, description: 'ID of the form for this task' },
        addressee: { required: false, description: 'Role or expression for assignee (e.g. "manager", "${initiator.manager}")' },
        ontimeout: { required: false, description: 'Action on timeout: "approve" or "reject"' },
        'approver-type': { required: false, default: 'normal-approver', options: ['normal-approver', 'single-approver', 'all-approvers'] },
      },
    },
    {
      type: 'rest',
      tag: 'iam_1:rest-activity',
      description: 'Calls an external REST API.',
      attributes: {
        method: { required: true, options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        apiUrl: { required: true, description: 'The URL of the REST endpoint' },
        authType: { required: true, options: ['none', 'basic', 'oauth2', 'apikey'] },
      },
    },
    {
      type: 'entity',
      tag: 'iam_1:entity-activity',
      description: 'Creates, updates, or deletes an IAM entity (user, role, group).',
      attributes: {
        'entity-type': { required: false, options: ['user', 'role', 'group', 'permission'] },
        operation: { required: false, options: ['create', 'update', 'delete', 'assign', 'revoke'] },
        deleteobject: { required: false, type: 'boolean', default: false },
      },
    },
    {
      type: 'condition',
      tag: 'iam_1:condition-activity',
      description: 'Branches the workflow on a boolean expression. MUST have exactly 2 outgoing flows.',
      attributes: {
        expression: { required: true, description: 'Boolean expression e.g. "${form.cost} > 500" or "${approvalStatus} == \'approved\'"' },
      },
    },
    {
      type: 'log',
      tag: 'iam_1:log-activity',
      description: 'Writes an audit log entry.',
      attributes: {
        message: { required: false, description: 'Log message, supports expressions' },
        comment: { required: false, description: 'Additional comment' },
      },
    },
    {
      type: 'notification',
      tag: 'iam_1:notification-activity',
      description: 'Sends a notification email to a user or role.',
      attributes: {
        templates: { required: false, description: 'Notification template ID' },
      },
    },
    {
      type: 'finish',
      tag: 'iam_1:finish-activity',
      description: 'Terminates the workflow. Always required as the final activity.',
      attributes: {
        setnotify: { required: false, description: 'Notification to send on completion' },
      },
    },
  ],
};

// ─── System prompt shared across planning and revision calls ───────────────────
export const PLANNING_SYSTEM_PROMPT = `You are the NetIQ Identity Governance (IGA) Workflow Architect.
Your mission: convert natural language requests into a strict JSON plan for the workflow engine.
Always respond with valid JSON only — no markdown, no prose.

## Available Activity Types (STRICT — never use unlisted types)

${JSON.stringify(ACTIVITY_SCHEMA, null, 2)}

## Required output format

{
  "activities": [
    {
      "id": "snake_case_unique_id",
      "type": "start|user|rest|entity|condition|log|notification|finish",
      "name": "Human-readable label",
      "attributes": { /* attributes matching the type schema above */ }
    }
  ],
  "flows": [
    { "source": "activity_id", "target": "activity_id", "label": "optional: yes/no/approved/rejected" }
  ],
  "forms": [
    {
      "id": "form_id_matching_activity_form-id",
      "components": [
        { "type": "textfield|textarea|select|checkbox|number|email|datetime", "key": "field_key", "label": "Field Label", "validate": { "required": true } }
      ]
    }
  ]
}

## Hard rules
- ALWAYS include exactly one start activity and at least one finish activity.
- Condition activities MUST have exactly 2 outgoing flows (true/yes path and false/no path).
- Every form-id referenced in a start or user activity MUST have a matching entry in the forms array.
- Use meaningful IDs: "manager_approval", "cost_check", "provision_user", etc.
- All paths through the workflow must eventually reach a finish activity.`;

// ─── Round 1: Deep understanding ──────────────────────────────────────────────
export function buildUnderstandingPrompt(request: string) {
  return [
    'You are an expert NetIQ Identity Governance Workflow Analyst.',
    'Deeply analyse the following workflow request and extract all relevant details.',
    '',
    `User Request: "${request}"`,
    '',
    'Output a JSON object with:',
    '- "summary": A concise one-sentence summary of the workflow goal.',
    '- "actors": Array of all human participants, e.g. ["Requester", "Manager", "IT Admin"].',
    '- "steps": Ordered array of high-level workflow steps, e.g. ["Submit request form", "Manager approves", "Provision account"].',
    '- "forms_needed": Array of { "name": "Form Name", "purpose": "What it collects", "fields": ["Field 1", "Field 2"] }.',
    '- "conditions": Array of decision points, e.g. [{ "condition": "Cost > $500", "true_path": "CISO approval", "false_path": "Direct provision" }].',
    '- "integrations": Array of external systems, e.g. [{ "system": "LDAP", "action": "Create user account" }].',
    '- "notifications": Array of notification events, e.g. [{ "event": "request_approved", "recipient": "requester" }].',
    '- "timeouts": Any SLA/timeout rules, e.g. [{ "step": "Manager approval", "timeout": "48h", "action": "auto-approve" }].',
  ].join('\n');
}

// ─── Round 2: Activity type selection ─────────────────────────────────────────
export function buildToolSelectorPrompt(analysis: any) {
  return [
    'You are a NetIQ IGA Workflow Designer. Map each workflow step to the correct NetIQ activity type.',
    '',
    `Workflow Analysis:\n${JSON.stringify(analysis, null, 2)}`,
    '',
    'Available activity types:',
    '- "start"        : Initial request/trigger form (always needed)',
    '- "user"         : Human approval, review, or data collection task',
    '- "condition"    : Decision/branch based on a boolean expression',
    '- "rest"         : External REST API call',
    '- "entity"       : IAM entity operation (create/update/delete user, role, group)',
    '- "log"          : Audit logging step',
    '- "notification" : Send notification/email',
    '- "finish"       : Workflow end (always needed)',
    '',
    'Output a JSON object with:',
    '- "activity_plan": Array of { "step": "<step from analysis>", "type": "<activity_type>", "reason": "<why this type>" }.',
    '- "selected_tools": Array of unique activity types needed, e.g. ["start","user","condition","entity","finish"].',
    '- "reasoning": Overall explanation of the activity choices.',
  ].join('\n');
}

// ─── Round 3: Detailed activity design ────────────────────────────────────────
export function buildActivityDetailPrompt(request: string, understanding: any, toolPlan: any) {
  return [
    'You are a NetIQ IGA Workflow Architect. Design the full detail of every activity required.',
    '',
    `Original Request: ${request}`,
    '',
    `Workflow Understanding:\n${JSON.stringify(understanding, null, 2)}`,
    '',
    `Activity Plan:\n${JSON.stringify(toolPlan?.activity_plan ?? [], null, 2)}`,
    '',
    'For EACH activity in the plan output a complete specification with a unique ID, name, type, and all attributes.',
    'Also define the form components for every form-based activity.',
    '',
    'Output a JSON object with:',
    '- "activities": Array of { "id": "snake_case_id", "type": "...", "name": "Human Label", "attributes": { ...type-specific... } }.',
    '- "forms": Array of { "id": "form_id", "components": [...form.io components...] }.',
    '',
    'Key rules:',
    '- For user activities: set form-id to a form you define and addressee to the approver role/expression.',
    '- For condition activities: set expression to a meaningful boolean like "${form.cost} > 500".',
    '- For rest activities: method (GET/POST/PUT/DELETE), apiUrl, and authType are REQUIRED.',
    '- Every form referenced must be defined in the forms array.',
  ].join('\n');
}

// ─── Round 4: Flow design ─────────────────────────────────────────────────────
export function buildFlowDesignPrompt(understanding: any, activities: any[]) {
  return [
    'You are a NetIQ IGA Workflow Architect. Define all sequence flows between the designed activities.',
    '',
    `Workflow Steps: ${JSON.stringify(understanding.steps ?? [], null, 2)}`,
    `Decision Points: ${JSON.stringify(understanding.conditions ?? [], null, 2)}`,
    '',
    'Activities to connect:',
    JSON.stringify(activities.map((a) => ({ id: a.id, type: a.type, name: a.name })), null, 2),
    '',
    'Rules:',
    '- Condition activities MUST have exactly 2 outgoing flows (true/yes and false/no).',
    '- All paths must eventually reach a finish activity.',
    '- Rejection paths should lead to a notification or directly to finish.',
    '',
    'Output a JSON object with:',
    '- "flows": Array of { "source": "activity_id", "target": "activity_id", "label": "optional yes/no/approved/rejected" }.',
    '- "reasoning": Brief explanation of the flow design decisions.',
  ].join('\n');
}

// ─── Round 5: Final plan assembly ─────────────────────────────────────────────
export function buildPlanningPrompt(
  request: string,
  understanding: any,
  activities: any[],
  flows: any[],
  forms: any[],
) {
  return [
    `User Request: ${request}`,
    `Workflow Summary: ${String(understanding.summary ?? '')}`,
    '',
    'Assemble the final complete workflow plan using the designed activities, flows, and forms below.',
    'Ensure all IDs are consistent and every form-id reference has a matching form entry.',
    '',
    `Activities:\n${JSON.stringify(activities, null, 2)}`,
    `Flows:\n${JSON.stringify(flows, null, 2)}`,
    `Forms:\n${JSON.stringify(forms, null, 2)}`,
    '',
    'Output the complete JSON plan following the required format exactly.',
  ].join('\n');
}

// ─── Round 6: Self-critique ───────────────────────────────────────────────────
export function buildCritiquePrompt(request: string, plan: any) {
  return [
    'You are a NetIQ IGA Workflow Quality Reviewer. Carefully critique the following workflow plan.',
    '',
    `Original Request: "${request}"`,
    '',
    `Generated Plan:\n${JSON.stringify(plan, null, 2)}`,
    '',
    'Check for:',
    '1. Does the workflow fulfil ALL requirements from the original request?',
    '2. Are all condition activities properly branched (exactly 2 outgoing flows)?',
    '3. Are all form-id references defined in the forms array?',
    '4. Is there exactly one start and at least one finish activity?',
    '5. Are there dead-end activities (no outgoing flows, except finish)?',
    '6. Are required attributes present for every activity type?',
    '7. Are any important steps from the request missing?',
    '',
    'Output a JSON object with:',
    '- "score": Quality score 1-10.',
    '- "issues": Array of specific problems found (empty array if none).',
    '- "missing_steps": Array of steps from the request that are not covered.',
    '- "needs_revision": true if score < 7 or any critical issue exists, else false.',
    '- "revision_instructions": If needs_revision is true, specific instructions to fix the plan.',
  ].join('\n');
}

// ─── Round 7 (conditional): Revision ─────────────────────────────────────────
export function buildRevisionPrompt(request: string, plan: any, critique: any) {
  return [
    'You are a NetIQ IGA Workflow Architect. Revise the workflow plan based on the review feedback.',
    '',
    `Original Request: "${request}"`,
    '',
    'Review Feedback:',
    `- Score: ${critique.score}/10`,
    `- Issues: ${JSON.stringify(critique.issues ?? [])}`,
    `- Missing Steps: ${JSON.stringify(critique.missing_steps ?? [])}`,
    `- Instructions: ${critique.revision_instructions ?? 'Fix all identified issues.'}`,
    '',
    `Current Plan to Revise:\n${JSON.stringify(plan, null, 2)}`,
    '',
    'Fix ALL identified issues and missing steps. Output the complete revised JSON plan.',
  ].join('\n');
}
