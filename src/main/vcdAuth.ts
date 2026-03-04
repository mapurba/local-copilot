import https from 'https';
import { app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
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

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'vcd-session.json');
}

async function writeSession(session: StoredVcdSession): Promise<void> {
  const payload = JSON.stringify(session);
  const output = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(payload).toString('base64')
    : payload;
  const data = safeStorage.isEncryptionAvailable()
    ? { encrypted: true, data: output }
    : { encrypted: false, data: output };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getSessionPath(), JSON.stringify(data, null, 2), 'utf8');
}

async function readSession(): Promise<StoredVcdSession | null> {
  try {
    const raw = await fs.readFile(getSessionPath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: boolean; data?: string };
    if (!parsed?.data) return null;
    if (parsed.encrypted) {
      const buf = Buffer.from(parsed.data, 'base64');
      const json = safeStorage.decryptString(buf);
      return JSON.parse(json) as StoredVcdSession;
    }
    return JSON.parse(parsed.data) as StoredVcdSession;
  } catch {
    return null;
  }
}

async function clearSession(): Promise<void> {
  try {
    await fs.unlink(getSessionPath());
  } catch {
    // ignore
  }
}

function buildUserId(username: string, org: string): string {
  const normalized = username.trim();
  if (normalized.includes('@') || normalized.includes('\\') || normalized.includes('/')) {
    return normalized;
  }
  return `${normalized}@${org.trim()}`;
}

async function vcdLoginRequest(input: VcdLoginInput): Promise<string> {
  const apiVersion = input.apiVersion || API_VERSION;
  const userId = buildUserId(input.username, input.org);
  const credentials = Buffer.from(`${userId}:${input.password}`, 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: VCD_HOST,
        path: '/cloudapi/1.0.0/sessions',
        method: 'POST',
        headers: {
          Accept: `application/json;version=${apiVersion}`,
          Authorization: `Basic ${credentials}`,
        },
        rejectUnauthorized: input.rejectUnauthorized ?? false,
      },
      (res) => {
        const token =
          res.headers['x-vmware-vcloud-access-token'] ||
          res.headers['X-VMWARE-VCLOUD-ACCESS-TOKEN'] ||
          res.headers['x-vcloud-authorization'] ||
          res.headers['X-VCloud-Authorization'];
        if (token && typeof token === 'string') {
          resolve(token);
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          reject(new Error(`VCD login failed (HTTP ${res.statusCode}): ${body}`));
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

export async function vcdSignIn(input: VcdLoginInput): Promise<{ connected: boolean; user: string; org: string; host: string }> {
  if (!input.username || !input.password || !input.org) {
    throw new Error('org, username, and password are required.');
  }

  const apiVersion = input.apiVersion || API_VERSION;
  const orgName = input.org || DEFAULT_ORG;
  const orgDefaults = getDefaultsForOrg(orgName);
  const token = await vcdLoginRequest(input);
  const dnsServers = input.dnsServers
    ? input.dnsServers.split(',').map((s) => s.trim()).filter(Boolean)
    : DNS_SERVERS;

  const session: StoredVcdSession = {
    host: VCD_HOST,
    org: orgName,
    username: input.username,
    token,
    apiVersion,
    vdcId: input.vdcId || orgDefaults.vdcId,
    orgUuid: input.orgUuid || orgDefaults.orgUuid,
    networkName: input.networkName || NETWORK_NAME,
    gateway: input.gateway || GATEWAY,
    dnsServers,
    storageProfileId: input.storageProfileId || orgDefaults.storageProfileId,
    computePolicyId: input.computePolicyId || orgDefaults.computePolicyId,
    rejectUnauthorized: input.rejectUnauthorized ?? false,
  };

  await writeSession(session);
  setVcdContext({
    host: session.host,
    token: session.token,
    apiVersion: session.apiVersion,
    orgName: session.org,
    orgUuid: session.orgUuid,
    username: session.username,
    vdcId: session.vdcId,
    networkName: session.networkName,
    gateway: session.gateway,
    dnsServers: session.dnsServers,
    storageProfileId: session.storageProfileId,
    computePolicyId: session.computePolicyId,
    rejectUnauthorized: session.rejectUnauthorized,
  });

  return { connected: true, user: session.username, org: session.org, host: session.host };
}

export async function vcdStatus(): Promise<{ connected: boolean; user?: string; org?: string; host?: string }>{
  const session = await readSession();
  if (!session) {
    return { connected: false };
  }
  setVcdContext({
    host: session.host,
    token: session.token,
    apiVersion: session.apiVersion,
    orgName: session.org,
    orgUuid: session.orgUuid,
    username: session.username,
    vdcId: session.vdcId,
    networkName: session.networkName,
    gateway: session.gateway,
    dnsServers: session.dnsServers,
    storageProfileId: session.storageProfileId,
    computePolicyId: session.computePolicyId,
    rejectUnauthorized: session.rejectUnauthorized,
  });
  return { connected: true, user: session.username, org: session.org, host: session.host };
}

export async function vcdSignOut(): Promise<{ connected: false }> {
  await clearSession();
  clearVcdContext();
  return { connected: false };
}
