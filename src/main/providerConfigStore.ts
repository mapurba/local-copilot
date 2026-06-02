import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export type AiProvider = 'copilot' | 'bedrock';

export const BEDROCK_MODEL_IDS = [
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'amazon.nova-pro-v1:0',
] as const;

export interface BedrockConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  modelId?: string;
}

export interface ProviderConfig {
  provider: AiProvider;
  bedrock: BedrockConfig;
}

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: 'copilot',
  bedrock: {
    region: '',
    modelId: BEDROCK_MODEL_IDS[0],
  },
};

function storePath(): string {
  return path.join(app.getPath('userData'), 'provider-config.json');
}

function normalize(input?: Partial<ProviderConfig>): ProviderConfig {
  const provider = input?.provider === 'bedrock' ? 'bedrock' : 'copilot';
  const bedrock = input?.bedrock ?? {};
  const modelId = BEDROCK_MODEL_IDS.includes(bedrock.modelId as (typeof BEDROCK_MODEL_IDS)[number])
    ? bedrock.modelId
    : DEFAULT_PROVIDER_CONFIG.bedrock.modelId;

  return {
    provider,
    bedrock: {
      accessKeyId: bedrock.accessKeyId?.trim() || '',
      secretAccessKey: bedrock.secretAccessKey?.trim() || '',
      region: bedrock.region?.trim() || '',
      modelId,
    },
  };
}

function readStore(): ProviderConfig {
  const p = storePath();
  if (!fs.existsSync(p)) {
    return DEFAULT_PROVIDER_CONFIG;
  }

  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
    return normalize(parsed);
  } catch {
    return DEFAULT_PROVIDER_CONFIG;
  }
}

function writeStore(config: ProviderConfig): void {
  const p = storePath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
}

export function getProviderConfig(): ProviderConfig {
  return readStore();
}

export function getProviderConfigView(): {
  provider: AiProvider;
  bedrock: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    modelId: string;
    configured: boolean;
  };
} {
  const config = readStore();
  return {
    provider: config.provider,
    bedrock: {
      accessKeyId: config.bedrock.accessKeyId || '',
      secretAccessKey: config.bedrock.secretAccessKey || '',
      region: config.bedrock.region || '',
      modelId: config.bedrock.modelId || BEDROCK_MODEL_IDS[0],
      configured: isBedrockConfigured(config.bedrock),
    },
  };
}

export function isBedrockConfigured(cfg: BedrockConfig): boolean {
  return Boolean(cfg.accessKeyId?.trim() && cfg.secretAccessKey?.trim() && cfg.region?.trim() && cfg.modelId?.trim());
}

export function setProvider(provider: AiProvider): ProviderConfig {
  const existing = readStore();
  const next: ProviderConfig = {
    ...existing,
    provider,
  };
  writeStore(next);
  return next;
}

export function saveBedrockConfig(input: BedrockConfig): ProviderConfig {
  const existing = readStore();
  const modelId = BEDROCK_MODEL_IDS.includes(input.modelId as (typeof BEDROCK_MODEL_IDS)[number])
    ? input.modelId
    : existing.bedrock.modelId || BEDROCK_MODEL_IDS[0];

  const next = normalize({
    ...existing,
    provider: 'bedrock',
    bedrock: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: input.region,
      modelId,
    },
  });
  writeStore(next);
  return next;
}
