import { createJsonCompletion } from '../copilotChatApi';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';

export async function generateJson<T>(modelId: string, userPrompt: string, systemPrompt = DEFAULT_SYSTEM_PROMPT): Promise<T> {
  const result = await createJsonCompletion(modelId, systemPrompt, userPrompt);
  return result as T;
}
