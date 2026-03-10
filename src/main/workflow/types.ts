export interface FormField extends Record<string, unknown> {
  key: string;
  type: string;
  label: string;
  validate?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface FormSpec {
  id: string;
  components: FormField[];
}

export interface ActivitySpec {
  id: string;
  type: 'start' | 'user' | 'rest' | 'entity' | 'condition' | 'log' | 'finish';
  attributes: Record<string, unknown>;
}

export interface FlowSpec {
  source: string;
  target: string;
}

export interface WorkflowPlan {
  forms: FormSpec[];
  activities: ActivitySpec[];
  flows: FlowSpec[];
}

export interface AgentState {
  request: string;
  understanding?: Record<string, unknown>;
  selected_tools?: string[];
  plan?: WorkflowPlan | null;
  critique?: string;
  forms_json?: string;
  workflow_xml?: string;
}
