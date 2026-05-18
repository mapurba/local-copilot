import * as vscode from 'vscode';

export async function rewriteEnvWithVmIp(
  envContent: string,
  ipAddress: string,
  _modelId = 'gpt-4o'
): Promise<{ updatedEnv: string; changesSummary: string; rationale: string }> {
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
  if (!model) throw new Error('No Copilot model available for env rewrite.');

  const messages = [
    vscode.LanguageModelChatMessage.User(
      [
        'You update .env content for ILM deployments.',
        'Return the FULL .env content with only the specified keys updated.',
        'Replace hostnames in the following keys with the provided VM IP:',
        'TENANT_OSP_REDIRECT_URL, CALLBACK_SERVER, SECRETS_URL, ILM_CORE_REST_URL.',
        'Keep schemes, ports, paths, and all other lines intact.',
        'Return JSON only with keys: updatedEnv, changesSummary, rationale.',
        'changesSummary should be a short list of key updates.',
        'rationale must be brief and high-level (no chain-of-thought).',
        '',
        `VM_IP=${ipAddress}`,
        '---ENV---',
        envContent,
      ].join('\n')
    ),
  ];

  const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

  let content = '';
  for await (const chunk of response.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      content += chunk.value;
    }
  }

  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM did not return valid JSON for env rewrite.');

  const parsed = JSON.parse(jsonMatch[0]) as {
    updatedEnv?: string;
    changesSummary?: string;
    rationale?: string;
  };

  if (!parsed.updatedEnv || typeof parsed.updatedEnv !== 'string') {
    throw new Error('LLM did not return updatedEnv content.');
  }

  return {
    updatedEnv: parsed.updatedEnv,
    changesSummary: typeof parsed.changesSummary === 'string' ? parsed.changesSummary : '',
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}
