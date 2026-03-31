export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant. You always respond with valid JSON.';

export function buildUnderstandingPrompt(request: string) {
  return [
    'You are an expert NetIQ Workflow Analyst. Your task is to dissect the user request.',
    '',
    `User Request: "${request}"`,
    '',
    'Output a JSON object with:',
    '- "actors": Who are the users involved? (e.g., Manager, CISO, IT Admin)',
    '- "forms_needed": What data needs to be collected? (e.g., Justification, Laptop Model)',
    '- "external_integrations": Are there REST APIs or LDAP updates needed?',
    '- "logic": What conditions or branches exist? (e.g., "If cost > 500")',
    '- "summary": A one-sentence summary of the workflow goal.'
  ].join('\n');
}

export function buildToolSelectorPrompt(analysis: any) {
  return [
    'Based on this analysis of a workflow request, select the specific NetIQ Activity Types required.',
    '',
    `Analysis: ${JSON.stringify(analysis)}`,
    '',
    'Available NetIQ Types (Strict):',
    '- start (Always required)',
    '- user (For approvals or forms)',
    '- rest (For API calls)',
    '- entity (For LDAP/User updates)',
    '- condition (For logic branches)',
    '- log (For auditing)',
    '- finish (Always required)',
    '',
    'Output a JSON object with:',
    '- "selected_tools": ["start", "user", ...]',
    '- "reasoning": "Need user activity for manager approval, condition for cost check..."'
  ].join('\n');
}

export const PLANNING_SYSTEM_PROMPT = `You are the NetIQ Identity Governance (IGA) Workflow Architect.
Your mission is to convert natural language requests into a strict JSON plan for a workflow engine.

# System Instruction: The NetIQ IGA Workflow Agent

Identity: You are the NetIQ Identity Governance (IGA) Workflow Architect.
Mission: Convert natural language requests (e.g., "Create a laptop access workflow") into deployable NetIQ IGA artifacts.
Core capability: You do not write standard BPMN. You write a specialized NetIQ dialect of BPMN 2.0 using the iam and iam_1 namespaces, strictly adhering to the internal engine schema.

---

## 1. The Architectural Strategy (The Adapter Pattern)

You operate on a "Transpiler Model". You must bridge the gap between human intent and NetIQ's strict engine requirements.

- Input: "Manager Approval then Provisioning."
- Mental Translation: UserTask -> <iam_1:user-activity>, ServiceTask -> <iam_1:rest-activity> or <iam_1:entity-activity>.
- Output: A JSON object representing the plan.

---

## 2. The Source of Truth (Schema Definition)

CRITICAL RULE: You are forbidden from hallucinating XML tags. You may ONLY use the activity types and attributes defined in this internal JSON object. If a property (like method or authType) is marked required: true, you must include it.

{
  "prefix": "iam",
  "uri": "http://some-company/schema/bpmn/a",
  "types": [ /* truncated for brevity in prompt */ ]
}

---
`;

export function buildPlanningPrompt(request: string, understanding: any, tools: any[]) {
  return [
    `User Request: ${request}`,
    '',
    'Analyst Notes:',
    `- Summary: ${String(understanding.summary ?? '')}`,
    `- Actors: ${JSON.stringify(understanding.actors ?? [])}`,
    `- Logic: ${JSON.stringify(understanding.logic ?? [])}`,
    '',
    'Architectural Decision:',
    `- Use these tools: ${JSON.stringify(tools)}`,
    '',
    'Generate the full JSON Plan now.'
  ].join('\n');
}
