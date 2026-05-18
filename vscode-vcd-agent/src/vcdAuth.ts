import https from 'https';
import * as vscode from 'vscode';
import { setVcdContext, clearVcdContext } from './vcdStore';
import {
  VCD_HOST,
  DEFAULT_ORG,
  API_VERSION,
  NETWORK_NAME,
  GATEWAY,
  DNS_SERVERS,
  getDefaultsForOrg,
} from './vcdConfig';
import { logApi } from './apiLogger';

export interface VcdLoginInput {
  host?: string;
  org: string;
  username: string;
  password: string;
  apiVersion?: string;
  vdcId?: string;
  orgUuid?: string;
  networkName?: string;
  gateway?: string;
  dnsServers?: string;
  storageProfileId?: string;
  computePolicyId?: string;
  rejectUnauthorized?: boolean;
}

interface StoredVcdSession {
  host: string;
  org: string;
  username: string;
  password?: string;
  token: string;
  apiVersion: string;
  vdcId?: string;
  orgUuid?: string;
  networkName?: string;
  gateway?: string;
  dnsServers?: string[];
  storageProfileId?: string;
  computePolicyId?: string;
  rejectUnauthorized?: boolean;
}

const SESSION_SECRET_KEY = 'vcd-agent.session';

let secretStorage: vscode.SecretStorage | null = null;

/** Called once from extension.ts activate() to inject VS Code SecretStorage. */
export function initVcdAuth(secrets: vscode.SecretStorage): void {
  secretStorage = secrets;
}

function getSecrets(): vscode.SecretStorage {
  if (!secretStorage) throw new Error('VCD auth not initialised — call initVcdAuth() first.');
  return secretStorage;
}

async function writeSession(session: StoredVcdSession): Promise<void> {
  await getSecrets().store(SESSION_SECRET_KEY, JSON.stringify(session));
}

async function readSession(): Promise<StoredVcdSession | null> {
  try {
    const raw = await getSecrets().get(SESSION_SECRET_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredVcdSession;
  } catch {
    return null;
  }
}

async function clearSession(): Promise<void> {
  await getSecrets().delete(SESSION_SECRET_KEY);
}

function buildUserId(username: string, org: string): string {
  const normalized = username.trim();
  if (normalized.includes('@') || normalized.includes('\\') || normalized.includes('/')) {
    return normalized;
  }
  return `${normalized}@${org.trim()}`;
}

async function vcdLoginRequest(
  input: VcdLoginInput
): Promise<{ token: string; orgUuid?: string }> {
  const apiVersion = input.apiVersion ?? API_VERSION;
  const userId = buildUserId(input.username, input.org);
  const host = input.host ?? VCD_HOST;
  const rejectUnauthorized = input.rejectUnauthorized ?? false;

  const credentials = Buffer.from(`${userId}:${input.password}`).toString('base64');
  const url = `https://${host}/cloudapi/1.0.0/sessions`;

  logApi({ source: 'vcdAuth.login', stage: 'request', method: 'POST', url });

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = https.request(
      {
        hostname: host,
        path: '/cloudapi/1.0.0/sessions',
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: `application/json;version=${apiVersion}`,
          'Content-Type': 'application/json',
        },
        rejectUnauthorized,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          logApi({
            source: 'vcdAuth.login',
            stage: 'response',
            method: 'POST',
            url,
            status: res.statusCode ?? 0,
            durationMs: Date.now() - startedAt,
          });

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`VCD login failed: HTTP ${res.statusCode} — ${data}`));
          }

          const token =
            res.headers['x-vmware-vcloud-access-token'] ??
            res.headers['x-vcloud-authorization'] ??
            '';
          if (!token) return reject(new Error('VCD login: no token in response headers'));

          let orgUuid: string | undefined;
          try {
            const body = JSON.parse(data) as { org?: { id?: string } };
            const match = body.org?.id?.match(/urn:vcloud:org:([a-f0-9-]+)/i);
            if (match) orgUuid = match[1];
          } catch {
            // non-fatal
          }

          resolve({ token: String(token), orgUuid });
        });
      }
    );
    req.on('error', (err) => {
      logApi({ source: 'vcdAuth.login', stage: 'error', url, error: err.message });
      reject(err);
    });
    req.end('{}');
  });
}

export async function vcdSignIn(input: VcdLoginInput): Promise<void> {
  const { token, orgUuid } = await vcdLoginRequest(input);
  const defaults = getDefaultsForOrg(input.org);

  const session: StoredVcdSession = {
    host: input.host ?? VCD_HOST,
    org: input.org,
    username: input.username,
    password: input.password, // stored in SecretStorage (encrypted by OS)
    token,
    apiVersion: input.apiVersion ?? API_VERSION,
    vdcId: input.vdcId ?? defaults.vdcId,
    orgUuid: orgUuid ?? input.orgUuid ?? defaults.orgUuid,
    networkName: input.networkName ?? NETWORK_NAME,
    gateway: input.gateway ?? GATEWAY,
    dnsServers: input.dnsServers
      ? input.dnsServers.split(',').map((s) => s.trim()).filter(Boolean)
      : DNS_SERVERS,
    storageProfileId: input.storageProfileId ?? defaults.storageProfileId,
    computePolicyId: input.computePolicyId ?? defaults.computePolicyId,
    rejectUnauthorized: input.rejectUnauthorized ?? false,
  };

  await writeSession(session);

  setVcdContext({
    host: session.host,
    token: session.token,
    apiVersion: session.apiVersion,
    orgName: session.org,
    username: session.username,
    orgUuid: session.orgUuid,
    vdcId: session.vdcId,
    networkName: session.networkName,
    gateway: session.gateway,
    dnsServers: session.dnsServers,
    storageProfileId: session.storageProfileId,
    computePolicyId: session.computePolicyId,
    rejectUnauthorized: session.rejectUnauthorized,
  });
}

/** Restore VCD context from stored session (called on extension activation). */
export async function vcdStatus(): Promise<{ connected: boolean; org?: string; host?: string }> {
  const session = await readSession();
  if (!session) return { connected: false };

  setVcdContext({
    host: session.host,
    token: session.token,
    apiVersion: session.apiVersion,
    orgName: session.org,
    username: session.username,
    orgUuid: session.orgUuid,
    vdcId: session.vdcId,
    networkName: session.networkName,
    gateway: session.gateway,
    dnsServers: session.dnsServers,
    storageProfileId: session.storageProfileId,
    computePolicyId: session.computePolicyId,
    rejectUnauthorized: session.rejectUnauthorized,
  });

  return { connected: true, org: session.org, host: session.host };
}

export async function vcdSignOut(): Promise<void> {
  await clearSession();
  clearVcdContext();
}

/** Re-authenticate using stored credentials (called when a 401 is received). */
export async function attemptAutoReauth(): Promise<boolean> {
  const session = await readSession();
  if (!session?.password) return false;
  try {
    await vcdSignIn({
      host: session.host,
      org: session.org,
      username: session.username,
      password: session.password,
      apiVersion: session.apiVersion,
      vdcId: session.vdcId,
      orgUuid: session.orgUuid,
      networkName: session.networkName,
      gateway: session.gateway,
      storageProfileId: session.storageProfileId,
      computePolicyId: session.computePolicyId,
      rejectUnauthorized: session.rejectUnauthorized,
    });
    return true;
  } catch {
    return false;
  }
}
