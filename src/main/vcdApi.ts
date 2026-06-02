// Robust vApp XML parser using fast-xml-parser
import { XMLParser } from 'fast-xml-parser';
import { PROXY_CLEANUP_SCRIPT } from './scripts/proxyCleanup';
import { ILM_SETUP_SCRIPT } from './scripts/ilmSetup';
import { IDM_SETUP_SCRIPT } from './scripts/idmSetup';
import { SLES_NETWORK_SCRIPT, UBUNTU_NETWORK_SCRIPT, RHEL_NETWORK_SCRIPT } from './scripts/networkSetup';
import { PACKAGE_INSTALL_SCRIPT } from './scripts/packageInstall';
import { SLES_PACKAGE_INSTALL_SCRIPT } from './scripts/slesPackageInstall';
import { FINALIZATION_SCRIPT } from './scripts/finalization';

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { BrowserWindow } from 'electron';
import { getVcdContext, setPendingForm, getPendingForm, VcdCreateForm } from './vcdStore';
import { rewriteEnvWithVmIp } from './envRewrite';
import { logApi } from './apiLogger';
import { attemptAutoReauth } from './vcdAuth';

let isAutoReauthInProgress = false;

/**
 * Parse vApp XML and return an array of vApp details.
 * Each vApp includes name, id, href, numberOfVMs, status, owner, and other useful fields.
 */
export function parseVAppRecordsXml(xml: string): Array<{
  name: string;
  id: string;
  href: string;
  numberOfVMs?: number;
  status?: string;
  owner?: string;
  vdcName?: string;
  description?: string;
  [key: string]: any;
}> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', allowBooleanAttributes: true });
  const root = parser.parse(xml);
  // The root is QueryResultRecords, vApp records are in QueryResultRecords.VAppRecord (array or single)
  let records = root?.QueryResultRecords?.VAppRecord;
  if (!records) return [];
  if (!Array.isArray(records)) records = [records];
  return records.map((rec: any) => {
    // Extract id from href (last segment after 'vapp-')
    let id = '';
    if (typeof rec.href === 'string') {
      const m = rec.href.match(/vapp-([a-f0-9\-]+)/i);
      id = m ? m[1] : rec.href;
    }
    return {
      name: rec.name || '',
      id,
      href: rec.href || '',
      numberOfVMs: rec.numberOfVMs !== undefined ? Number(rec.numberOfVMs) : undefined,
      status: rec.status,
      owner: rec.ownerName,
      vdcName: rec.vdcName,
      description: rec.description,
      ...rec,
    };
  });
}
interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function buildAgent(rejectUnauthorized?: boolean) {
  return new https.Agent({ rejectUnauthorized: rejectUnauthorized ?? false });
}

function httpsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 30000,
  rejectUnauthorized?: boolean
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    logApi({
      source: 'vcdApi.httpsRequest',
      stage: 'request',
      method,
      url,
      headers,
      requestBody: body,
    });

    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent: buildAgent(rejectUnauthorized),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          logApi({
            source: 'vcdApi.httpsRequest',
            stage: 'response',
            method,
            url,
            status: res.statusCode || 0,
            durationMs: Date.now() - startedAt,
            headers: res.headers as Record<string, unknown>,
            responseBody: data,
          });
          resolve({ status: res.statusCode || 0, headers: res.headers, body: data });
        });
      }
    );

    req.on('error', (err) => {
      logApi({
        source: 'vcdApi.httpsRequest',
        stage: 'error',
        method,
        url,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Notify renderer that VCD session has expired and user needs to re-authenticate.
 */
function notifySessionExpired(): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('vcd:session-expired');
  }
}

/**
 * Wrapper around httpsRequest that detects 401/403 errors and attempts auto-reauth.
 * If auto-reauth succeeds, retries the request once with the new token.
 * If auto-reauth fails, notifies the renderer to show the login modal.
 */
async function httpsRequestWithAutoReauth(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 30000,
  rejectUnauthorized?: boolean
): Promise<HttpResult> {
  const result = await httpsRequest(url, method, headers, body, timeoutMs, rejectUnauthorized);
  
  // Check if session expired (401 Unauthorized or 403 Forbidden)
  if (result.status === 401 || result.status === 403) {
    console.log(`[vcdApi] Got ${result.status}, attempting auto re-authentication...`);
    
    // Prevent concurrent re-auth attempts
    if (isAutoReauthInProgress) {
      console.log('[vcdApi] Auto re-auth already in progress, skipping...');
      return result;
    }
    
    try {
      isAutoReauthInProgress = true;
      const reauthSuccess = await attemptAutoReauth();
      
      if (reauthSuccess) {
        console.log('[vcdApi] Auto re-authentication successful, retrying request...');
        // Get updated context with new token and (possibly corrected) orgUuid
        const ctx = getVcdContext();
        const updatedHeaders: Record<string, string> = { ...headers, Authorization: `Bearer ${ctx.token}` };
        // Refresh X-VMWARE-VCLOUD-TENANT-CONTEXT — the orgUuid may have changed
        // after re-auth (e.g. was wrong before due to stale stored value).
        const tenantKey = Object.keys(updatedHeaders)
          .find((k) => k.toLowerCase() === 'x-vmware-vcloud-tenant-context');
        if (ctx.orgUuid) {
          // Overwrite whichever casing variant is already present, or add fresh
          if (tenantKey) updatedHeaders[tenantKey] = ctx.orgUuid;
          else updatedHeaders['x-vmware-vcloud-tenant-context'] = ctx.orgUuid;
        } else if (tenantKey) {
          // orgUuid is now empty — drop the header so VCD uses the auth context
          delete updatedHeaders[tenantKey];
        }
        // Retry the request with updated headers
        const retryResult = await httpsRequest(url, method, updatedHeaders, body, timeoutMs, rejectUnauthorized);
        return retryResult;
      } else {
        console.log('[vcdApi] Auto re-authentication failed, notifying renderer...');
        notifySessionExpired();
        return result;
      }
    } catch (error) {
      console.error('[vcdApi] Error during auto re-auth:', error);
      notifySessionExpired();
      return result;
    } finally {
      isAutoReauthInProgress = false;
    }
  }
  
  return result;
}

function jsonParseSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function baseHeaders(apiVersion: string, token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
  };
}

function addTenantHeaders(
  headers: Record<string, string>,
  orgName?: string,
  orgUuid?: string
): Record<string, string> {
  if (orgName) headers['x-vmware-vcloud-auth-context'] = orgName;
  if (orgUuid) headers['x-vmware-vcloud-tenant-context'] = orgUuid;
  return headers;
}

function sanitizeComputerName(vmName: string): string {
  const cleaned = vmName.replace(/[^a-zA-Z0-9\-.]/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || /^\d+$/.test(cleaned)) {
    return `vm-${cleaned || 'host'}`;
  }
  return cleaned;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}



function extractXmlSection(xml: string, tagName: string): string {
  const regex = new RegExp(`<(?:\\w+:)?${tagName}\\b[\\s\\S]*?<\\/(?:\\w+:)?${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[0] : '';
}

function replaceXmlTagValue(xml: string, tagName: string, value: string): string {
  const regex = new RegExp(`(<(?:\\w+:)?${tagName}\\b[^>]*>)([\\s\\S]*?)(<\\/(?:\\w+:)?${tagName}>)`, 'i');
  if (!regex.test(xml)) return xml;
  return xml.replace(regex, `$1${escapeXml(value)}$3`);
}

function extractXmlAttr(xml: string, tagName: string, attrName: string): string {
  const regex = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*\\b${attrName}="([^"]+)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function extractVcdErrorMessage(xml: string): string {
  if (!xml) return '';
  const messageMatch = xml.match(/<([\w:]+)?Message>([\s\S]*?)<\/[\w:]*Message>/i);
  const majorMatch = xml.match(/<([\w:]+)?MajorErrorCode>([\s\S]*?)<\/[\w:]*MajorErrorCode>/i);
  const minorMatch = xml.match(/<([\w:]+)?MinorErrorCode>([\s\S]*?)<\/[\w:]*MinorErrorCode>/i);
  const details = [
    messageMatch ? messageMatch[2].trim() : '',
    majorMatch ? `major=${majorMatch[2].trim()}` : '',
    minorMatch ? `minor=${minorMatch[2].trim()}` : '',
  ].filter(Boolean);
  return details.join(' | ');
}

const SLES_PATTERNS = ['sles_15', 'sles15', 'sles', 'suse', 'sp5', 'sp6', 'sp7'];

function isSlesTemplate(templateName?: string): boolean {
  if (!templateName) return false;
  const lower = templateName.toLowerCase();
  return SLES_PATTERNS.some((p) => lower.startsWith(p) || lower.includes(p));
}

function matchesOwner(ownerName: string, username: string): boolean {
  if (!ownerName || !username) return false;
  const ownerLower = ownerName.toLowerCase();
  const userLower = username.toLowerCase();
  return (
    ownerLower === userLower ||
    ownerLower.startsWith(`${userLower}@`) ||
    ownerLower.endsWith(`\\${userLower}`) ||
    ownerLower.endsWith(`/${userLower}`)
  );
}

async function queryRecords(
  recordType: string,
  pageSize = 128,
  extraFilter?: string,
  sortDesc?: string
): Promise<Record<string, unknown>[]> {
  const ctx = getVcdContext();
  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', recordType);
  url.searchParams.set('format', 'records');
  url.searchParams.set('pageSize', String(pageSize));
  if (extraFilter) url.searchParams.set('filter', extraFilter);
  if (sortDesc) url.searchParams.set('sortDesc', sortDesc);

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`query_records(${recordType}) failed: HTTP ${result.status}`);
  }
  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[] } | null;
  return data?.record || [];
}

export async function listVApps(pageSize = 100): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  // Build the exact query string as in the curl example
  const vdcId = ctx.vdcId || '';
  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', 'vApp');
  url.searchParams.append('type', 'vApp');
  url.searchParams.set('format', 'records');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('filterEncoded', 'true');
  url.searchParams.set('filter', `((isAutoNature==false;vdc==${vdcId}))`);
  url.searchParams.set('sortDesc', 'creationDate');
  url.searchParams.set('fields', 'metadata@SYSTEM:vmware.cloud.director.availability.protected,metadata@GENERAL:vmware.cloud.director.ui.badges.blue,metadata@GENERAL:vmware.cloud.director.ui.badges.red,metadata@GENERAL:vmware.cloud.director.ui.badges.orange,metadata@GENERAL:vmware.cloud.director.ui.badges.green,metadata@GENERAL:vmware.cloud.director.ui.badges.magenta');
  url.searchParams.set('links', 'true');

  // Build headers to match the curl example
  const headers: Record<string, string> = {
    'Accept': 'application/*+xml;version=40.0.0-alpha',
    'Accept-Language': 'en-US,en;q=0.9,en-IN;q=0.8',
    'Authorization': `Bearer ${ctx.token}`,
    'Content-Type': 'application/vnd.vmware.vcloud.vApp+xml;charset=utf-8',
    'X-Requested-With': 'XMLHttpRequest',
    'X-VMWARE-VCLOUD-AUTH-CONTEXT': ctx.orgName || '',
    'X-VMWARE-VCLOUD-TENANT-CONTEXT': ctx.orgUuid || '',
    'X-vCloud-Authorization': ctx.orgName || '',
    // Optionally add Referer, User-Agent, etc. if needed
  };
  // Remove any empty headers
  Object.keys(headers).forEach((k) => { if (!headers[k]) delete headers[k]; });

  const result = await httpsRequestWithAutoReauth(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`listVApps failed: HTTP ${result.status}`);
  }
  // Use robust XML parser to extract vApp records
  const xml = result.body;
  const vapps = parseVAppRecordsXml(xml);
  return { vapps };
}

async function getVappDetailsXml(vappHref: string): Promise<string> {
  const ctx = getVcdContext();
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(vappHref, 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`get_vapp_details failed: HTTP ${result.status}`);
  }
  return result.body || '';
}

async function getVmDetailsXml(vmHref: string): Promise<string> {
  const ctx = getVcdContext();
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(vmHref, 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`get_vm_details failed: HTTP ${result.status}`);
  }
  return result.body || '';
}

export async function listVms(pageSize = 100, saveToFile?: string): Promise<unknown> {
  const ctx = getVcdContext();
  const username = ctx.username || '';
  const records = await queryRecords(
    'vm',
    pageSize,
    username ? `ownerName==*${username}*;isVAppTemplate==false` : 'isVAppTemplate==false',
    'dateCreated'
  );

  const userVms = username
    ? records.filter((vm) => matchesOwner(String(vm.ownerName || ''), username))
    : records;

  // Normalize the VMs to extract powered_on status from the status field
  const normalizedVms = userVms.map((vm) => normalizeVmStatus(vm));

  if (saveToFile) {
    return { count: normalizedVms.length, vms: normalizedVms, save_to_file: saveToFile };
  }
  console.log(`Found ${normalizedVms.length} VMs for user ${username}, normalized vm details=${JSON.stringify(normalizedVms)}`);
  return { count: normalizedVms.length, vms: normalizedVms };
}

export async function getVmDetails(vmId: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const id = vmId.startsWith('http') ? vmId.split('/vm-')[1] : vmId;
  const url = `https://${ctx.host}/api/vApp/vm-${id}`;
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(url, 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`get_vm_details failed: HTTP ${result.status}`);
  }
  const data = jsonParseSafe(result.body) as Record<string, unknown> | null;
  if (!data) throw new Error('get_vm_details returned invalid JSON');
  return data;
}

export async function powerOnVm(vmHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const url = `${vmHref}/power/action/powerOn`;
  const headers = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`),
    'Content-Length': '0',
  };
  const result = await httpsRequestWithAutoReauth(url, 'POST', headers, '', 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`power_on failed: HTTP ${result.status}`);
  }
  return { status: 'success', action: 'powerOn', vm_href: vmHref };
}

export async function powerOffVm(vmHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const url = `${vmHref}/power/action/powerOff`;
  const headers = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`),
    'Content-Length': '0',
  };
  const result = await httpsRequestWithAutoReauth(url, 'POST', headers, '', 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`power_off failed: HTTP ${result.status}`);
  }
  return { status: 'success', action: 'powerOff', vm_href: vmHref };
}

export async function deleteVm(vmHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(vmHref, 'DELETE', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`delete_vm failed: HTTP ${result.status}`);
  }
  return { status: 'success', action: 'delete', vm_href: vmHref };
}

export async function listTemplates(nameFilter = ''): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const filter = nameFilter.trim()
    ? `((isExpired==false);(name==*${nameFilter.trim()}*))`
    : '((isExpired==false))';

  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', 'vAppTemplate');
  url.searchParams.set('format', 'records');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '128');
  url.searchParams.set('filterEncoded', 'true');
  url.searchParams.set('filter', filter);
  url.searchParams.set('sortAsc', 'name');
  url.searchParams.set('links', 'true');

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`list_templates failed: HTTP ${result.status}`);
  }

  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[]; total?: number } | null;
  const records = data?.record || [];

  const templates = records.map((t) => {
    const href = String(t.href || '');
    let templateId = href.includes('/vAppTemplate/') ? href.split('/vAppTemplate/').pop() || '' : '';
    for (const prefix of ['vappTemplate-', 'vm-']) {
      if (templateId.startsWith(prefix)) {
        templateId = templateId.slice(prefix.length);
        break;
      }
    }
    const other = (t.otherAttributes as Record<string, unknown> | undefined) || {};
    return {
      name: String(t.name || ''),
      template_id: templateId,
      catalog: String(t.catalogName || ''),
      status: String(t.status || ''),
      description: String(t.description || ''),
      cpus: other.numberOfCpus ?? '',
      memory_mb: other.memoryAllocationMB ?? '',
    };
  });

  return { count: templates.length, total: data?.total ?? templates.length, templates };
}

/**
 * Fetch raw vAppTemplate XML for a given template UUID.
 * Tries the vappTemplate path first, falls back to the vm- path if necessary.
 */
export async function getTemplateXml(templateUuid: string): Promise<string> {
  const ctx = getVcdContext();
  const headers = addTenantHeaders(
    baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
    ctx.orgName,
    ctx.orgUuid
  );

  const vappUrl = `https://${ctx.host}/api/vAppTemplate/vappTemplate-${templateUuid}`;
  const vappResult = await httpsRequestWithAutoReauth(vappUrl, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
  if (vappResult.status >= 200 && vappResult.status < 300) {
    return vappResult.body || '';
  }

  // Fallback: try vm- URL
  const vmUrl = `https://${ctx.host}/api/vAppTemplate/vm-${templateUuid}`;
  const vmResult = await httpsRequestWithAutoReauth(vmUrl, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
  if (vmResult.status >= 200 && vmResult.status < 300) {
    return vmResult.body || '';
  }

  throw new Error(`get_template_xml failed: vappTemplate HTTP ${vappResult.status}, vm HTTP ${vmResult.status}`);
}

/**
 * Update a vAppTemplate XML body for the given template UUID.
 * Note: updating templates in-place may be restricted by the VCD server.
 */
export async function updateTemplateXml(templateUuid: string, xmlBody: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const url = `https://${ctx.host}/api/vAppTemplate/vappTemplate-${templateUuid}`;
  const headers = addTenantHeaders(
    baseHeaders(ctx.apiVersion, ctx.token, `application/vnd.vmware.vcloud.vAppTemplate+xml;version=${ctx.apiVersion}`),
    ctx.orgName,
    ctx.orgUuid
  );

  const result = await httpsRequestWithAutoReauth(url, 'PUT', headers, xmlBody, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`update_template failed: HTTP ${result.status} - ${result.body?.slice?.(0, 800) || ''}`);
  }
  return { status: result.status, body: result.body };
}

async function resolveTemplateVmHref(vappTemplateUuid: string): Promise<string> {
  const ctx = getVcdContext();
  const headers = addTenantHeaders(
    baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
    ctx.orgName,
    ctx.orgUuid
  );

  // Step 1: fetch the vAppTemplate and look for any href pointing to a child VM
  // (i.e. .../api/vAppTemplate/vm-<uuid>).  Search the entire XML body so the
  // match is independent of element name, namespace prefix, and attribute order.
  const vappUrl = `https://${ctx.host}/api/vAppTemplate/vappTemplate-${vappTemplateUuid}`;
  const vappResult = await httpsRequestWithAutoReauth(vappUrl, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
  if (vappResult.status >= 200 && vappResult.status < 300) {
    // Match href=".../api/vAppTemplate/vm-<uuid>" (double or single quotes)
    const vmHrefRe = /href=["']([^"']*\/api\/vAppTemplate\/vm-[^"']+)["']/i;
    const match = vappResult.body.match(vmHrefRe);
    if (match && match[1]) {
      console.log(`[resolveTemplateVmHref] Resolved child VM href: ${match[1]}`);
      return match[1];
    }
    // vAppTemplate XML found but contains no child vm- href.
    // Fall through to the vm- path — the UUID may double as the VM UUID.
    console.warn(`[resolveTemplateVmHref] vAppTemplate ${vappTemplateUuid} has no child vm- href in XML; trying vm- path`);
  }

  // Step 2: UUID may be the child VM UUID directly (stripped from vm-<uuid> by listTemplates)
  const vmUrl = `https://${ctx.host}/api/vAppTemplate/vm-${vappTemplateUuid}`;
  const vmResult = await httpsRequestWithAutoReauth(vmUrl, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
  if (vmResult.status >= 200 && vmResult.status < 300) {
    console.log(`[resolveTemplateVmHref] Resolved as direct VM href: ${vmUrl}`);
    return vmUrl;
  }

  // Neither path confirmed — return the vm- URL anyway and let the instantiate
  // call surface the real error with VCD's own error message.
  console.warn(`[resolveTemplateVmHref] Could not confirm template (vappTemplate HTTP ${vappResult.status}, vm HTTP ${vmResult.status}); proceeding with vm- URL`);
  return vmUrl;
}

/** ILM version → download artefact mapping */
const ILM_VERSION_MAP: Record<string, { url: string; full: string }> = {
  '1.3.0': {
    url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.3.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.3.0.0000/compose-1.3.0.0000.zip',
    full: '1.3.0.0000',
  },
  '1.2.0': {
    url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers-1.2.0/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.2.0.0000/compose-1.2.0.0000.zip',
    full: '1.2.0.0000',
  },
  '1.0.0': {
    url: 'https://blr-idm-jenkins.labs.blr.novell.com:8443/job/ILM/job/ilm-containers/lastSuccessfulBuild/artifact/com/opentext/ilm/compose/1.0.0.0000/compose-1.0.0.0000.zip',
    full: '1.0.0.0000',
  },
};

function getUnifiedCustomizationScript(
  ipAddress: string,
  gateway: string,
  dnsServers: string[],
  setupIlm = false,
  ilmVersion = 'latest',
  customEnvContent?: string,
  setupIdm = false,
  idmCustomEnvContent?: string,
  customScript?: string
): string {
  const ipWithCidr = ipAddress.includes('/') ? ipAddress : `${ipAddress}/21`;
  const dnsPrimary = dnsServers.length ? dnsServers[0] : '15.122.222.53';
  const dnsAll  = dnsServers.length ? dnsServers.join(' ') : dnsPrimary;
  const dnsYaml = dnsServers.length ? dnsServers.join('\n          - ') : dnsPrimary;
  const ilmEnabled       = setupIlm ? 'true' : 'false';
  const ilmVersionMapped = ilmVersion === 'latest' ? '1.3.0' : ilmVersion;
  const ilmEntry = ILM_VERSION_MAP[ilmVersionMapped] || ILM_VERSION_MAP['1.3.0'];
  const idmEnabled = setupIdm ? 'true' : 'false';

  // Single-quoted heredoc (<<'EOF_ENV') is fully literal — no bash interpolation,
  // so no escaping of $ or backticks is required.
  const envInjectionBlock = customEnvContent
    ? `if [ "$SETUP_ILM" = "true" ]; then\n  echo "Writing custom .env..." >> "$LOG"\n  cat > /root/uploaded.env <<'EOF_ENV'\n${customEnvContent}\nEOF_ENV\n  echo "Custom .env written." >> "$LOG"\nfi`
    : `# No custom .env provided; will use default .env from compose zip`;

  const idmEnvInjectionBlock = idmCustomEnvContent
    ? `if [ "$SETUP_IDM" = "true" ]; then\n  echo "Writing custom IDM .env..." >> "$LOG"\n  cat > /root/uploaded_idm.env <<'EOF_IDM_ENV'\n${idmCustomEnvContent}\nEOF_IDM_ENV\n  echo "Custom IDM .env written." >> "$LOG"\nfi`
    : `# No custom IDM .env provided; will use default .env from idm_compose zip`;

  let script = `#!/bin/bash
#scriptversion:20250302-unified-fixed-final
set -euo pipefail

LOG="/root/vcdcustlog"
touch "$LOG"
echo "Script Start" >> "$LOG"

# ── Error handler — logs failing line before finalizer runs ──────────────────
_vcd_on_error() {
    echo "[ERROR] Script failed at line $1: $2" | tee -a "$LOG" >&2
}
trap '_vcd_on_error $LINENO "$BASH_COMMAND"' ERR

# ── VCD post-customization guard ─────────────────────────────────────────────
if [ "x__DOLLAR_CURLY__1:-}" != "xpostcustomization" ]; then
    echo "Not a post-customization run — exiting." >> "$LOG"
    exit 0
fi

# ── ILM variables ────────────────────────────────────────────────────────────
SETUP_ILM="__ILM_ENABLED__"
ILM_VERSION="__ILM_VERSION__"
ILM_FULL_VERSION="__ILM_FULL_VERSION__"
ILM_COMPOSE_URL="__ILM_URL__"

# ── IDM variables ────────────────────────────────────────────────────────────
SETUP_IDM="__IDM_ENABLED__"

# ── Custom .env injection (ILM) ───────────────────────────────────────────────
__CUSTOM_ENV_INJECTION__

# ── Custom .env injection (IDM) ───────────────────────────────────────────────
__IDM_ENV_INJECTION__

# ── OS detection ─────────────────────────────────────────────────────────────
OS_TYPE="unknown"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
        sled|sles|suse|opensuse*)    OS_TYPE="sles"   ;;
        ubuntu|debian)               OS_TYPE="ubuntu" ;;
        rhel|centos|rocky|almalinux) OS_TYPE="rhel"   ;;
    esac
fi
echo "OS_TYPE=$OS_TYPE" >> "$LOG"

# ── Network interface detection ───────────────────────────────────────────────
primary_iface=$(ip -o link | awk '$2 != "lo:" && $2 !~ /^lo@/ {print $2; exit}' | sed 's/://' | sed 's/@.*//')
[ -z "$primary_iface" ] && primary_iface=eth0
echo "Primary interface: $primary_iface" >> "$LOG"

# ── OS-specific network configuration ──────────────────────────────────────────────
if [ "$OS_TYPE" = "sles" ]; then
${SLES_NETWORK_SCRIPT}
elif [ "$OS_TYPE" = "ubuntu" ]; then
${UBUNTU_NETWORK_SCRIPT}
elif [ "$OS_TYPE" = "rhel" ]; then
${RHEL_NETWORK_SCRIPT}
else
    echo "ERROR: Unsupported OS type: $OS_TYPE" >> "$LOG"
fi
${PROXY_CLEANUP_SCRIPT}
# ── SLES: Docker installation ────────────────────────────────────────────────
if [ "$OS_TYPE" = "sles" ]; then
${SLES_PACKAGE_INSTALL_SCRIPT}
fi
# ── Ubuntu: Docker installation ──────────────────────────────────────────────
if [ "$OS_TYPE" = "ubuntu" ]; then
${PACKAGE_INSTALL_SCRIPT}
fi

# ── Finalization function – registered as trap so it always runs ──────────────
_VCD_FINALIZED=false
_vcd_finalize() {
    [ "$_VCD_FINALIZED" = "true" ] && return 0
    _VCD_FINALIZED=true
    echo "Network configuration completed." >> "$LOG"
${FINALIZATION_SCRIPT}}
trap '_vcd_finalize' EXIT TERM

# ── ILM + IDM setup (runs on any OS that has Docker) ─────────────────────────
${ILM_SETUP_SCRIPT}
${IDM_SETUP_SCRIPT}

# ── Per-service custom script injection (if any) ─────────────────────────────
__CUSTOM_SCRIPT__

# ── Explicit finalization call at end of normal flow ─────────────────────────
_vcd_finalize
`;

  script = script.replace(/__CUSTOM_ENV_INJECTION__/g, envInjectionBlock);
  script = script.replace(/__IDM_ENV_INJECTION__/g, idmEnvInjectionBlock);
  script = script
    .replace(/__IP_WITH_CIDR__/g, ipWithCidr)
    .replace(/__GATEWAY__/g, gateway)
    .replace(/__DNS_ALL__/g, dnsAll)
    .replace(/__DNS_YAML__/g, dnsYaml)
    .replace(/__IP_ADDRESS__/g, ipAddress)
    .replace(/__ILM_ENABLED__/g, ilmEnabled)
    .replace(/__ILM_VERSION__/g, ilmVersionMapped)
    .replace(/__ILM_FULL_VERSION__/g, ilmEntry.full)
    .replace(/__ILM_URL__/g, ilmEntry.url)
    .replace(/__IDM_ENABLED__/g, idmEnabled)
    .replace(/__DOLLAR_CURLY__/g, '${');

  // Inject any per-service custom script just before the explicit finalization
  // call so that finalization runs after service install steps.
  script = script.replace(/__CUSTOM_SCRIPT__/g, customScript && String(customScript).trim() ? `\n\n${customScript}\n\n` : '');

  return script;
}

const ILM_ENV_KEYS = [
  'TENANT_OSP_REDIRECT_URL',
  'CALLBACK_SERVER',
  'SECRETS_URL',
  'ILM_CORE_REST_URL',
];

function normalizeIpAddress(ipAddress: string): string {
  return ipAddress.includes('/') ? ipAddress.split('/')[0] : ipAddress;
}

function replaceUrlHost(value: string, ipAddress: string): string {
  try {
    const url = new URL(value);
    url.hostname = ipAddress;
    return url.toString();
  } catch {
    const match = value.match(/^(https?:\/\/)([^\/:]+)(:\d+)?(\/.*)?$/i);
    if (match) {
      const prefix = match[1];
      const port = match[3] || '';
      const path = match[4] || '';
      return `${prefix}${ipAddress}${port}${path}`;
    }
    if (value.includes('lab')) {
      return value.replace(/\blab\b/g, ipAddress);
    }
    return value;
  }
}

function parseEnvMap(envContent: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of envContent.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map[key] = value;
  }
  return map;
}

function updateEnvContentManual(envContent: string, ipAddress: string): string {
  const lines = envContent.split(/\r?\n/);
  return lines.map((line) => {
    const match = line.match(/^(\s*([A-Z0-9_]+)\s*=\s*)(.*)$/);
    if (!match) return line;
    const key = match[2];
    if (!ILM_ENV_KEYS.includes(key)) return line;
    const rawValue = match[3].trim();
    const quote = rawValue.startsWith('"') && rawValue.endsWith('"') ? '"'
      : rawValue.startsWith("'") && rawValue.endsWith("'") ? "'" : '';
    const unquoted = quote ? rawValue.slice(1, -1) : rawValue;
    const replaced = replaceUrlHost(unquoted, ipAddress);
    const finalValue = quote ? `${quote}${replaced}${quote}` : replaced;
    return `${match[1]}${finalValue}`;
  }).join('\n');
}

function buildEnvChangesSummary(beforeEnv: string, afterEnv: string): string {
  const beforeMap = parseEnvMap(beforeEnv);
  const afterMap = parseEnvMap(afterEnv);
  const lines: string[] = [];
  for (const key of ILM_ENV_KEYS) {
    const beforeValue = beforeMap[key];
    const afterValue = afterMap[key];
    if (beforeValue && afterValue && beforeValue !== afterValue) {
      lines.push(`- ${key}: ${beforeValue} -> ${afterValue}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No changes detected in target keys.';
}

function isEnvUpdateComplete(originalEnv: string, updatedEnv: string): boolean {
  const originalLines = originalEnv.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  const updatedLines = updatedEnv.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (updatedLines.length === 0) return false;
  if (updatedLines.length < Math.max(3, Math.floor(originalLines.length * 0.7))) return false;
  return true;
}

async function waitForTask(taskHref: string, timeoutSec = 60): Promise<boolean> {
  if (!taskHref) return true;
  const ctx = getVcdContext();
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const result = await httpsRequestWithAutoReauth(taskHref, 'GET', headers, undefined, 15000, ctx.rejectUnauthorized);
    if (result.status !== 200) return false;
    if (result.body.includes('status="success"')) return true;
    if (result.body.includes('status="error"') || result.body.includes('status="aborted"')) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function updateHardwareItem(vmHref: string, sectionName: 'cpu' | 'memory', newValue: number): Promise<string> {
  const ctx = getVcdContext();
  const sectionUrl = `${vmHref}/virtualHardwareSection/${sectionName}`;
  const getHeaders = baseHeaders(
    ctx.apiVersion,
    ctx.token,
    `application/vnd.vmware.vcloud.rasdItem+xml;version=${ctx.apiVersion}`
  );
  const getRes = await httpsRequestWithAutoReauth(sectionUrl, 'GET', getHeaders, undefined, 30000, ctx.rejectUnauthorized);
  if (getRes.status < 200 || getRes.status >= 300) {
    throw new Error(`Failed to fetch ${sectionName} section: HTTP ${getRes.status}`);
  }
  let xml = getRes.body;
  xml = xml.replace(
    /(<(?:\w+:)?VirtualQuantity(?:\s[^>]*)?>)\d+(<\/(?:\w+:)?VirtualQuantity>)/,
    `$1${newValue}$2`
  );
  const label = sectionName === 'cpu' ? `${newValue} virtual CPU(s)` : `${newValue} MB of memory`;
  xml = xml.replace(
    /(<(?:\w+:)?ElementName(?:\s[^>]*)?>)[^<]*(<\/(?:\w+:)?ElementName>)/,
    `$1${label}$2`
  );

  if (!xml.includes('VirtualQuantity')) {
    throw new Error(`VirtualQuantity not found in ${sectionName} XML`);
  }

  const putHeaders = {
    ...baseHeaders(ctx.apiVersion, ctx.token, `application/vnd.vmware.vcloud.task+xml;version=${ctx.apiVersion}`),
    'Content-Type': 'application/vnd.vmware.vcloud.rasdItem+xml',
  };
  const putRes = await httpsRequestWithAutoReauth(sectionUrl, 'PUT', putHeaders, xml, 30000, ctx.rejectUnauthorized);
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`Failed to update ${sectionName}: HTTP ${putRes.status}`);
  }
  const match = putRes.body.match(/href="([^"]+)"/);
  return match?.[1] || '';
}

export async function checkVmStatus(vmName: string): Promise<Record<string, unknown>> {
  const name = vmName.trim();
  const result = await listVms(200);
  const vms = (result as { vms?: Record<string, unknown>[] }).vms ?? [];
  const needle = name.toLowerCase();
  const found = vms.find((vm) => String(vm.name || '').toLowerCase() === needle);
  if (!found) {
    return { found: false, vm_name: name };
  }
  return { found: true, vm: normalizeVmStatus(found) };
}

async function resolveVmHrefByName(nameOrHref: string): Promise<string> {
  if (nameOrHref.startsWith('http')) {
    return nameOrHref;
  }
  const ctx = getVcdContext();
  const trimmed = nameOrHref.trim();
  if (trimmed.startsWith('urn:vcloud:vm:')) {
    const id = trimmed.split('urn:vcloud:vm:')[1];
    if (id) return `https://${ctx.host}/api/vApp/vm-${id}`;
  }
  if (trimmed.startsWith('vm-')) {
    const id = trimmed.slice(3);
    if (id) return `https://${ctx.host}/api/vApp/vm-${id}`;
  }
  if (/^[a-f0-9-]{20,}$/i.test(trimmed)) {
    return `https://${ctx.host}/api/vApp/vm-${trimmed}`;
  }
  const username = ctx.username || '';
  const records = await queryRecords(
    'vm',
    200,
    username ? `ownerName==*${username}*;isVAppTemplate==false` : 'isVAppTemplate==false',
    'dateCreated'
  );
  const needle = nameOrHref.toLowerCase();
  const matches = records.filter((vm) => {
    const sameName = String(vm.name || '').toLowerCase() === needle;
    if (!sameName) return false;
    return username ? matchesOwner(String(vm.ownerName || ''), username) : true;
  });

  if (matches.length === 0) {
    throw new Error(`No VM named '${nameOrHref}' found for the current user.`);
  }
  if (matches.length > 1) {
    const hrefs = matches.map((vm) => String(vm.href || '?'));
    throw new Error(
      `Ambiguous: ${matches.length} VMs are named '${nameOrHref}'. Please use exact vm_href. Found hrefs: ${hrefs.join(', ')}`
    );
  }
  const href = String(matches[0].href || '');
  if (!href) {
    throw new Error(`VM '${nameOrHref}' was found but has no href.`);
  }
  return href;
}

function getVmIdFromHref(vmHref: string): string {
  if (!vmHref.includes('/vm-')) return '';
  return vmHref.split('/vm-')[1]?.split(/[/?#]/)[0] || '';
}

function parseSnapshotSectionXml(xml: string): Array<Record<string, unknown>> {
  const snapshots: Array<Record<string, unknown>> = [];
  const regex = /<Snapshot\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const href = attrs.match(/\bhref="([^"]+)"/i)?.[1] || '';
    const name = attrs.match(/\bname="([^"]+)"/i)?.[1] || '';
    const created = attrs.match(/\bcreated="([^"]+)"/i)?.[1] || '';
    const size = attrs.match(/\bsize="([^"]+)"/i)?.[1] || '';
    const poweredOn = attrs.match(/\bpoweredOn="([^"]+)"/i)?.[1] || '';
    snapshots.push({
      href,
      id: href.includes('/snapshot-') ? href.split('/snapshot-')[1] : href,
      name,
      created,
      size,
      powered_on: poweredOn.toLowerCase() === 'true',
    });
  }
  return snapshots;
}

export async function createSnapshot(
  vmNameOrHref: string,
  snapshotName?: string,
  memory = false,
  quiesce = false
): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const vmHref = await resolveVmHrefByName(vmNameOrHref);
  const vmId = getVmIdFromHref(vmHref);
  if (!vmId) throw new Error('create_snapshot failed: unable to resolve VM ID from href.');


  const name = snapshotName?.trim() || 'base';
  const urnVmId = `urn:vcloud:vm:${vmId}`;
  const cloudapiUrl = `https://${ctx.host}/cloudapi/1.0.0/vm/${urnVmId}/snapshots`;
  // Build headers to match the curl example exactly
  const jsonHeaders: Record<string, string> = {
    'Accept': 'application/json;version=40.0.0-alpha',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ctx.token}`,
    'x-vcloud-authorization': ctx.token,
    'x-vmware-vcloud-tenant-context': ctx.orgUuid || '',
  };
  // Remove Accept-Language and any other extra headers
  // Remove any undefined/empty headers
  Object.keys(jsonHeaders).forEach((k) => {
    if (!jsonHeaders[k]) delete jsonHeaders[k];
  });

  const body = JSON.stringify({
    name,
    memory,
    quiesce,
  });
  const res = await httpsRequestWithAutoReauth(cloudapiUrl, 'POST', jsonHeaders, body, 30000, ctx.rejectUnauthorized);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`create_snapshot failed: cloudapi vm snapshots HTTP ${res.status} - ${res.body.slice(0, 600)}`);
  }

  return {
    status: 'success',
    action: 'createSnapshot',
    vm_href: vmHref,
    vm_id: vmId,
    snapshot_name: name,
    endpoint: '/cloudapi/1.0.0/vm/{urn}/snapshots',
  };
}

export async function revertSnapshot(vmNameOrHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const vmHref = await resolveVmHrefByName(vmNameOrHref);
  const candidates = ['revertToCurrentSnapshot', 'revertToSnapshot'];

  for (const action of candidates) {
    const url = `${vmHref}/action/${action}`;
    const headers = {
      ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
      'Content-Length': '0',
    };
    const result = await httpsRequestWithAutoReauth(url, 'POST', headers, '', 30000, ctx.rejectUnauthorized);
    if (result.status >= 200 && result.status < 300) {
      return { status: 'success', action: 'revertSnapshot', vm_href: vmHref };
    }
    if (![404, 405].includes(result.status)) {
      throw new Error(`revert_snapshot failed: HTTP ${result.status} - ${result.body.slice(0, 400)}`);
    }
  }

  throw new Error('revert_snapshot failed: supported revert endpoint not available on this VCD API version.');
}

export async function listVmSnapshots(vmNameOrHref: string): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const vmHref = await resolveVmHrefByName(vmNameOrHref);
  const vmId = getVmIdFromHref(vmHref);
  const sectionUrl = `${vmHref}/snapshotSection`;
  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(sectionUrl, 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`list_vm_snapshots failed: HTTP ${result.status}`);
  }

  const snapshots = parseSnapshotSectionXml(result.body);
  return {
    vm_href: vmHref,
    vm_id: vmId,
    count: snapshots.length,
    snapshots,
  };
}

export async function listAllSnapshots(pageSize = 200): Promise<Record<string, unknown>> {
  try {
    const records = await queryRecords('snapshot', pageSize, undefined, 'dateCreated');
    const snapshots = records.map((s) => ({
      id: s.id || '',
      name: s.name || '',
      vm_name: s.vmName || s.containerName || '',
      created: s.dateCreated || s.created || '',
      owner: s.ownerName || '',
      href: s.href || '',
      status: s.status || '',
    }));
    return { count: snapshots.length, snapshots };
  } catch {
    // Fallback for VCD environments that do not expose snapshot records in query API.
    const vmResult = await listVms(pageSize);
    const vms = (vmResult as { vms?: Array<Record<string, unknown>> }).vms || [];
    const collected: Array<Record<string, unknown>> = [];

    for (const vm of vms) {
      const href = String(vm.href || '');
      if (!href) continue;
      try {
        const perVm = await listVmSnapshots(href);
        const snapshots = (perVm.snapshots as Array<Record<string, unknown>> | undefined) || [];
        snapshots.forEach((snap) => {
          collected.push({ ...snap, vm_name: vm.name || '', vm_href: href });
        });
      } catch {
        // Continue collecting from other VMs even if one VM does not expose snapshot info.
      }
    }

    return { count: collected.length, snapshots: collected };
  }
}

export async function createVmCopy(
  vmNameOrHref: string,
  newVmName: string,
  targetVappHref: string,
  powerOn = false,
  description?: string
): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const vmHref = await resolveVmHrefByName(vmNameOrHref);
  if (!targetVappHref) throw new Error('create_vm_copy failed: target vApp is required.');

  const [vmXml, vappXml] = await Promise.all([
    getVmDetailsXml(vmHref),
    getVappDetailsXml(targetVappHref),
  ]);

  const vappName = extractXmlAttr(vappXml, 'VApp', 'name') || 'Target vApp';
  const vappDescription = extractXmlSection(vappXml, 'Description');

  const sourceVmName = extractXmlAttr(vmXml, 'Vm', 'name') || vmNameOrHref;
  const rawGuestCustomization = extractXmlSection(vmXml, 'GuestCustomizationSection');
  const rawNetworkSection = extractXmlSection(vmXml, 'NetworkConnectionSection');
  const extractXmlTagValue = (xml: string, tagName: string) => {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
  };
  const buildGuestCustomizationSection = (section: string, computerName: string) => {
    const enabled = extractXmlTagValue(section, 'Enabled') || 'true';
    const changeSid = extractXmlTagValue(section, 'ChangeSid') || 'false';
    const joinDomainEnabled = extractXmlTagValue(section, 'JoinDomainEnabled') || 'false';
    const adminPasswordEnabled = extractXmlTagValue(section, 'AdminPasswordEnabled') || 'false';
    const adminPasswordAuto = extractXmlTagValue(section, 'AdminPasswordAuto') || 'false';
    const resetPasswordRequired = extractXmlTagValue(section, 'ResetPasswordRequired') || 'false';
    return [
      '<root:GuestCustomizationSection>',
      '<ns0:Info>Guest Customization Section</ns0:Info>',
      `<root:Enabled>${escapeXml(enabled)}</root:Enabled>`,
      `<root:ChangeSid>${escapeXml(changeSid)}</root:ChangeSid>`,
      `<root:JoinDomainEnabled>${escapeXml(joinDomainEnabled)}</root:JoinDomainEnabled>`,
      `<root:AdminPasswordEnabled>${escapeXml(adminPasswordEnabled)}</root:AdminPasswordEnabled>`,
      `<root:AdminPasswordAuto>${escapeXml(adminPasswordAuto)}</root:AdminPasswordAuto>`,
      `<root:ResetPasswordRequired>${escapeXml(resetPasswordRequired)}</root:ResetPasswordRequired>`,
      `<root:ComputerName>${escapeXml(computerName)}</root:ComputerName>`,
      '</root:GuestCustomizationSection>',
    ].join('');
  };
  const buildNoneNetworkSection = (section: string) => {
    if (!section) return '';
    const macAddress = extractXmlTagValue(section, 'MACAddress');
    const adapterType = extractXmlTagValue(section, 'NetworkAdapterType');
    const macTag = macAddress ? `<root:MACAddress>${escapeXml(macAddress)}</root:MACAddress>` : '';
    const adapterTag = adapterType ? `<root:NetworkAdapterType>${escapeXml(adapterType)}</root:NetworkAdapterType>` : '';
    return [
      '<root:NetworkConnectionSection>',
      '<ns0:Info>Network Connection Section</ns0:Info>',
      '<root:PrimaryNetworkConnectionIndex>0</root:PrimaryNetworkConnectionIndex>',
      '<root:NetworkConnection network="none">',
      '<root:NetworkConnectionIndex>0</root:NetworkConnectionIndex>',
      '<root:IpType>IPV4</root:IpType>',
      '<root:IsConnected>false</root:IsConnected>',
      macTag,
      '<root:IpAddressAllocationMode>NONE</root:IpAddressAllocationMode>',
      '<root:SecondaryIpAddressAllocationMode>NONE</root:SecondaryIpAddressAllocationMode>',
      adapterTag,
      '</root:NetworkConnection>',
      '</root:NetworkConnectionSection>',
    ].join('');
  };
  const guestCustomization = buildGuestCustomizationSection(rawGuestCustomization, newVmName || sourceVmName);
  const networkSection = buildNoneNetworkSection(rawNetworkSection);
  const hardwareSection = extractXmlSection(vmXml, 'VirtualHardwareSection');
  const storageProfileHref = extractXmlAttr(vmXml, 'StorageProfile', 'href');

  const descriptionBlock = description?.trim()
    ? `<root:Description>${escapeXml(description.trim())}</root:Description>`
    : vappDescription || `<root:Description>${escapeXml(vappName)}</root:Description>`;

  const storageProfileBlock = storageProfileHref
    ? `<root:StorageProfile href="${escapeXml(storageProfileHref)}"/>`
    : '';

  const buildXmlBody = (sections: string[]) => {
    const instantiationParams = sections
      .filter(Boolean)
      .map((section) => section.trim())
      .join('');

    return [
      `<root:RecomposeVAppParams xmlns:root="http://www.vmware.com/vcloud/v1.5" name="${escapeXml(vappName)}" xmlns:ns0="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ns1="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData" xmlns:ns2="http://www.vmware.com/schema/ovf">`,
      descriptionBlock,
      `<root:SourcedItem sourceDelete="false">`,
      `<root:Source href="${escapeXml(vmHref)}" name="${escapeXml(newVmName || sourceVmName)}"/>`,
      instantiationParams ? `<root:InstantiationParams>${instantiationParams}</root:InstantiationParams>` : '',
      storageProfileBlock,
      `<root:ReplaceTpm>false</root:ReplaceTpm>`,
      `</root:SourcedItem>`,
      `</root:RecomposeVAppParams>`,
    ].join('');
  };

  // Build headers to match the curl example exactly
  const xmlHeaders: Record<string, string> = {
    'Accept': 'application/*+xml;version=40.0.0-alpha',
    'Content-Type': 'application/vnd.vmware.vcloud.recomposeVAppParams+xml;charset=UTF-8',
    'Authorization': `Bearer ${ctx.token}`,
    'X-vCloud-Authorization': ctx.orgName || '',
    'X-VMWARE-VCLOUD-TENANT-CONTEXT': ctx.orgUuid || '',
    'X-VMWARE-VCLOUD-AUTH-CONTEXT': ctx.orgName || '',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
    'Referer': `https://${ctx.host}/tenant/${ctx.orgName}/vdcs/${ctx.vdcId}/vm`,
    'sec-ch-ua': '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  // Remove any empty headers
  Object.keys(xmlHeaders).forEach((k) => { if (!xmlHeaders[k]) delete xmlHeaders[k]; });

  const recomposeUrl = `${targetVappHref}/action/recomposeVApp`;

  const attemptRecompose = async (sections: string[]) => {
    const body = buildXmlBody(sections);
    const response = await httpsRequestWithAutoReauth(recomposeUrl, 'POST', xmlHeaders, body, 30000, ctx.rejectUnauthorized);
    return response;
  };

  const primarySections = [guestCustomization, networkSection, hardwareSection];
  const primaryResult = await attemptRecompose(primarySections);
  if (primaryResult.status < 200 || primaryResult.status >= 300) {
    // Retry with minimal instantiation params to handle incompatible network/hardware sections.
    const fallbackSections = [guestCustomization];
    const fallbackResult = await attemptRecompose(fallbackSections);
    if (fallbackResult.status < 200 || fallbackResult.status >= 300) {
      const primaryMessage = extractVcdErrorMessage(primaryResult.body);
      const fallbackMessage = extractVcdErrorMessage(fallbackResult.body);
      throw new Error(
        `create_vm_copy failed: HTTP ${primaryResult.status} - ${primaryMessage || primaryResult.body.slice(0, 400)} ` +
        `(fallback failed: HTTP ${fallbackResult.status} - ${fallbackMessage || fallbackResult.body.slice(0, 400)})`
      );
    }
  }

  return {
    status: 'success',
    action: 'copyVm',
    vm_href: vmHref,
    new_vm_name: newVmName,
    target_vapp_href: targetVappHref,
    power_on_requested: powerOn,
  };
}

export async function updateVmResources(vmId: string, cpuCount?: number, ramMb?: number): Promise<Record<string, unknown>> {
  const MAX_CPU = 4;
  const MAX_RAM_MB = 20480;

  if (cpuCount !== undefined && (cpuCount < 1 || cpuCount > MAX_CPU)) {
    throw new Error(`CPU count must be between 1 and ${MAX_CPU}`);
  }
  if (ramMb !== undefined && (ramMb < 512 || ramMb > MAX_RAM_MB)) {
    throw new Error(`RAM must be between 512 MB and ${MAX_RAM_MB} MB`);
  }
  if (!cpuCount && !ramMb) {
    return { status: 'noop', message: 'No updates requested' };
  }

  const vmHref = await resolveVmHrefByName(vmId);
  const id = vmHref.includes('/vm-') ? vmHref.split('/vm-')[1] : vmId;
  const vmData = await getVmDetails(id);
  const vmStatus = vmData.status;

  const wasPoweredOn = vmStatus === 4 || vmStatus === '4';
  if (wasPoweredOn) {
    await powerOffVm(vmHref);
    await new Promise((r) => setTimeout(r, 5000));
    for (let i = 0; i < 20; i += 1) {
      const details = await getVmDetails(id);
      if (details.status === 8 || details.status === '8') break;
      await new Promise((r) => setTimeout(r, 3000));
      if (i === 19) throw new Error('Timed out waiting for VM to power off');
    }
  }

  const applied: Record<string, unknown> = {};
  if (cpuCount) {
    const taskHref = await updateHardwareItem(vmHref, 'cpu', cpuCount);
    await waitForTask(taskHref);
    applied.num_cpus = cpuCount;
  }
  if (ramMb) {
    const taskHref = await updateHardwareItem(vmHref, 'memory', ramMb);
    await waitForTask(taskHref);
    applied.memory_mb = ramMb;
  }

  if (wasPoweredOn) {
    await powerOnVm(vmHref);
    applied.powered_on = true;
  }

  return { status: 'success', vm_id: id, vm_href: vmHref, ...applied };
}

export async function createVmFromTemplate(params: {
  vdc_id: string;
  template_vm_id: string;
  vm_name: string;
  template_name?: string;
  org_name?: string;
  org_uuid?: string;
  network_name: string;
  ip_address: string;
  gateway: string;
  dns_servers: string[];
  power_on: boolean;
  ip_allocation_mode: string;
  network_adapter_type: string;
  storage_profile_id: string;
  compute_policy_id: string;
  setup_ilm?: boolean;
  ilm_version?: string;
  custom_script?: string;
  custom_env_content?: string;
  setup_idm?: boolean;
  idm_custom_env_content?: string;
}): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();

  const templateHref = await resolveTemplateVmHref(params.template_vm_id);
  // Extract UUID from the last path segment, stripping either 'vm-' or 'vappTemplate-' prefix
  let childVmUuid = templateHref.split('/').pop() || '';
  for (const prefix of ['vappTemplate-', 'vm-']) {
    if (childVmUuid.startsWith(prefix)) {
      childVmUuid = childVmUuid.slice(prefix.length);
      break;
    }
  }

  const storageProfileHref = `https://${ctx.host}/api/vdcStorageProfile/${params.storage_profile_id}`;
  const isManualIp = String(params.ip_allocation_mode || '').toUpperCase() === 'MANUAL';
  const ipSection = isManualIp && params.ip_address
    ? `<IpAddress>${params.ip_address}</IpAddress>`
    : '<IpAddress/>';
  console.log('ipSection:', ipSection);
  let envUpdateInfo: {
    updatedEnv: string;
    changesSummary: string;
    rationale: string;
    usedFallback: boolean;
  } | null = null;

  const normalizedIp = normalizeIpAddress(params.ip_address);
  let updatedEnvContent = params.custom_env_content;

  if (params.setup_ilm && params.custom_env_content) {
    if (!normalizedIp) {
      updatedEnvContent = params.custom_env_content;
      envUpdateInfo = {
        updatedEnv: params.custom_env_content,
        changesSummary: 'VM IP unavailable. No .env updates applied.',
        rationale: 'Skipped update because VM IP was not provided.',
        usedFallback: true,
      };
    } else {
      try {
        const llmResult = await rewriteEnvWithVmIp(params.custom_env_content, normalizedIp);
        if (!isEnvUpdateComplete(params.custom_env_content, llmResult.updatedEnv)) {
          throw new Error('LLM returned incomplete .env content.');
        }
        updatedEnvContent = llmResult.updatedEnv;
        envUpdateInfo = {
          updatedEnv: llmResult.updatedEnv,
          changesSummary: llmResult.changesSummary || buildEnvChangesSummary(params.custom_env_content, llmResult.updatedEnv),
          rationale: llmResult.rationale || 'Updated ILM endpoints to use the VM IP.',
          usedFallback: false,
        };
      } catch (err) {
        const fallbackEnv = updateEnvContentManual(params.custom_env_content, normalizedIp);
        updatedEnvContent = fallbackEnv;
        envUpdateInfo = {
          updatedEnv: fallbackEnv,
          changesSummary: buildEnvChangesSummary(params.custom_env_content, fallbackEnv),
          rationale: 'LLM update failed. Applied manual host replacement instead.',
          usedFallback: true,
        };
        console.warn('[ILM] LLM update failed, using fallback:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Build the unified customization script and inject any per-service
  // custom script so it runs before the explicit finalization call.
  const customizationScript = getUnifiedCustomizationScript(
    params.ip_address,
    params.gateway,
    params.dns_servers,
    params.setup_ilm,
    params.ilm_version,
    updatedEnvContent,
    params.setup_idm,
    params.idm_custom_env_content,
    params.custom_script
  );

  const computerName = sanitizeComputerName(params.vm_name);
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<InstantiateVmTemplateParams
    xmlns="http://www.vmware.com/vcloud/v1.5"
    xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
    name="${params.vm_name}"
    powerOn="${String(params.power_on).toLowerCase()}">
    <Description>VM created from template</Description>
    <SourcedVmTemplateItem>
        <Source
            href="${templateHref}"
            id="urn:vcloud:vm:${childVmUuid}"
            type="application/vnd.vmware.vcloud.vm+xml"/>
        <VmTemplateInstantiationParams>
            <NetworkConnectionSection>
                <ovf:Info/>
                <PrimaryNetworkConnectionIndex>0</PrimaryNetworkConnectionIndex>
                <NetworkConnection network="${params.network_name}">
                    <NetworkConnectionIndex>0</NetworkConnectionIndex>
                    <IpAddress/>
                    <IpType>IPV4</IpType>
                    <IsConnected>true</IsConnected>
                    <IpAddressAllocationMode>DHCP</IpAddressAllocationMode>
                    <NetworkAdapterType>VMXNET3</NetworkAdapterType>
                  </NetworkConnection>
            </NetworkConnectionSection>
            <GuestCustomizationSection>
                <ovf:Info>Specifies Guest OS Customization Settings</ovf:Info>
                <Enabled>true</Enabled>
                <ChangeSid>false</ChangeSid>
                <JoinDomainEnabled>false</JoinDomainEnabled>
                <UseOrgSettings>false</UseOrgSettings>
                <AdminPasswordEnabled>false</AdminPasswordEnabled>
                <AdminPasswordAuto>false</AdminPasswordAuto>
                <AdminAutoLogonEnabled>false</AdminAutoLogonEnabled>
                <AdminAutoLogonCount>0</AdminAutoLogonCount>
                <ResetPasswordRequired>false</ResetPasswordRequired>
                <CustomizationScript><![CDATA[${customizationScript}]]></CustomizationScript>
                <ComputerName>${computerName}</ComputerName>
            </GuestCustomizationSection>
        </VmTemplateInstantiationParams>
        <StorageProfile
            href="${storageProfileHref}"
            type="application/vnd.vmware.vcloud.vdcStorageProfile+xml"/>
    </SourcedVmTemplateItem>
    <AllEULAsAccepted>true</AllEULAsAccepted>
    <ComputePolicy>
        <VmSizingPolicy
            href="urn:vcloud:vdcComputePolicy:${params.compute_policy_id}"
            id="urn:vcloud:vdcComputePolicy:${params.compute_policy_id}"/>
    </ComputePolicy>
</InstantiateVmTemplateParams>`;

  const headers = addTenantHeaders(
    {
      ...baseHeaders(ctx.apiVersion, ctx.token, `application/*+xml;version=${ctx.apiVersion}`),
      'Content-Type': 'application/*+xml;charset=UTF-8',
    },
    params.org_name || ctx.orgName,
    params.org_uuid || ctx.orgUuid
  );

  const url = `https://${ctx.host}/api/vdc/${params.vdc_id}/action/instantiateVmFromTemplate`;
  const result = await httpsRequestWithAutoReauth(url, 'POST', headers, xmlPayload, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    // Extract the VCD error message from the XML if present
    const msgMatch = result.body.match(/message="([^"]+)"/);
    const vcdMsg = msgMatch ? msgMatch[1] : result.body.slice(0, 800);
    throw new Error(`create_vm failed: HTTP ${result.status} - ${vcdMsg}`);
  }
  return {
    status: 'success',
    status_code: result.status,
    response_text: result.body.slice(0, 500),
    env_update: envUpdateInfo,
    env_update_message: envUpdateInfo
      ? 'Understood custom .env. Modified with VM IP. See env_update for details.'
      : undefined,
  };
}

export async function createVmDraft(form: VcdCreateForm): Promise<Record<string, unknown>> {
  console.log('[createVmDraft] Called with form:', JSON.stringify(form, null, 2));
  // Accept and store custom_env_content if present
  setPendingForm(form);
  const response = {
    type: 'vm_create_form',
    message: 'Review the VM details and confirm to create the VM.',
    form,
  };
  console.log('[createVmDraft] Returning response:', JSON.stringify(response, null, 2));
  return response;
}

export async function createVmConfirmed(): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const form = getPendingForm();
  if (!form) {
    return { status: 'error', message: 'No pending VM form found. Create a draft first.' };
  }
  if (!ctx.vdcId) {
    return { status: 'error', message: 'Missing VDC ID. Set vdc_id via set_vcd_context.' };
  }
  if (!form.template_id) {
    return { status: 'error', message: 'Missing template_id in draft. Create a draft with a template first.' };
  }
  const networkName = form.network_name || ctx.networkName;
  if (!networkName) {
    return { status: 'error', message: 'Missing network name. Set network_name via set_vcd_context or draft.' };
  }
  const gateway = form.gateway || ctx.gateway || '';
  const ipAddress = form.ip_address || '10.71.33.180';
  const dnsList = (form.dns_servers ? form.dns_servers.split(',') : ctx.dnsServers) || ['15.122.222.53'];
  const storageProfileId = form.storage_profile_id || ctx.storageProfileId || '';
  const computePolicyId = form.compute_policy_id || ctx.computePolicyId || '';
  if (!storageProfileId || !computePolicyId) {
    return { status: 'error', message: 'Missing storage_profile_id or compute_policy_id. Set via set_vcd_context.' };
  }

  const result = await createVmFromTemplate({
    vdc_id: ctx.vdcId,
    template_vm_id: form.template_id,
    vm_name: form.vm_name,
    template_name: form.template_name || '',
    org_name: ctx.orgName,
    org_uuid: ctx.orgUuid,
    network_name: networkName,
    ip_address: ipAddress,
    gateway,
    dns_servers: dnsList,
    power_on: form.power_on ?? true,
    ip_allocation_mode: form.ip_allocation_mode || 'DHCP',
    network_adapter_type: 'VMXNET3',
    storage_profile_id: storageProfileId,
    compute_policy_id: computePolicyId,
    setup_ilm: form.setup_ilm,
    ilm_version: form.ilm_version,
    custom_env_content: form.custom_env_content,
    setup_idm: form.setup_idm,
    idm_custom_env_content: form.idm_custom_env_content,
  });

  setPendingForm(null);
  return { status: 'success', result };
}

export async function listTasks(minutesAgo = 60, pageSize = 50): Promise<Record<string, unknown>> {
  const ctx = getVcdContext();
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  const iso = since.toISOString();

  const url = new URL(`https://${ctx.host}/api/query`);
  url.searchParams.set('type', 'task');
  url.searchParams.set('format', 'records');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('filterEncoded', 'true');
  url.searchParams.set('filter', `startDate=gt=${iso}`);
  url.searchParams.set('sortDesc', 'startDate');
  url.searchParams.set('links', 'true');

  const headers = baseHeaders(ctx.apiVersion, ctx.token, `application/*+json;version=${ctx.apiVersion}`);
  const result = await httpsRequestWithAutoReauth(url.toString(), 'GET', headers, undefined, 30000, ctx.rejectUnauthorized);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`list_tasks failed: HTTP ${result.status}`);
  }

  const data = jsonParseSafe(result.body) as { record?: Record<string, unknown>[]; total?: number } | null;
  const records = data?.record || [];
  const items = records.map((t) => ({
    name: t.name,
    status: t.status,
    operation: t.operation,
    ownerName: t.ownerName,
    startDate: t.startDate,
    href: t.href,
  }));

  return { count: items.length, total: data?.total ?? items.length, since_minutes_ago: minutesAgo, tasks: items };
}

export function normalizeVmStatus(vm: Record<string, unknown>): Record<string, unknown> {
  const name = String(vm.name || 'Unknown');
  const href = String(vm.href || '');
  const rawStatus = String(vm.status || '');

  // Parse the status field to determine power state
  // Status values: "POWERED_ON", "POWERED_OFF", etc.
  const statusNormalized = rawStatus.toLowerCase().replace(/\s+|_/g, '');
  const poweredOn = ['4', 'poweredon', 'poweron', 'on'].includes(statusNormalized);

  // Prefer guestOs, fallback to detectedGuestOs, then other fields
  const osType = vm.guestOs || vm.detectedGuestOs || vm.osType || vm.guestOsType || vm['os type'] || '';
  const osVersion = vm.osVersion || vm.guestOsVersion || vm['os version'] || '';

  return {
    name,
    status: rawStatus,
    powered_on: poweredOn,
    href,
    ip: vm.ipAddress || vm.ip || '',
    owner: vm.ownerName || '',
    osType: typeof osType === 'string' ? osType : '',
    osVersion: typeof osVersion === 'string' ? osVersion : '',
  };
}

export function buildCreateFormFromInput(form: Partial<VcdCreateForm>): VcdCreateForm {
  const ctx = getVcdContext();
  return {
    vm_name: form.vm_name || '',
    template_id: form.template_id || '',
    template_name: form.template_name || '',
    network_name: form.network_name || ctx.networkName || '',
    ip_allocation_mode: form.ip_allocation_mode || 'DHCP',
    ip_address: form.ip_address || '',
    gateway: form.gateway || ctx.gateway || '',
    dns_servers: form.dns_servers || (ctx.dnsServers ? ctx.dnsServers.join(',') : ''),
    power_on: form.power_on ?? true,
    storage_profile_id: form.storage_profile_id || ctx.storageProfileId || '',
    compute_policy_id: form.compute_policy_id || ctx.computePolicyId || '',
    setup_ilm: form.setup_ilm ?? false,
    ilm_version: form.ilm_version || 'latest',
    custom_env_content: form.custom_env_content,
    setup_idm: form.setup_idm ?? false,
    idm_custom_env_content: form.idm_custom_env_content,
  };
}

export function shouldUseSlesScript(templateName?: string): boolean {
  return isSlesTemplate(templateName);
}

/**
 * Allocate a free IP from the IP registrar service
 * @returns Allocated IP address or error
 */
export async function allocateFreeIp(): Promise<{ success: boolean; ip?: string; error?: string }> {
  const REMOTE_URL = 'http://164.99.91.31:5100/api/res-ip/allocate';
  
  return new Promise((resolve) => {
    const parsed = new URL(REMOTE_URL);
    const payload = JSON.stringify({});
    
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 5100,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };

    console.log('[IP Allocator] Requesting free IP from:', REMOTE_URL);
    
    const startedAt = Date.now();
    logApi({
      source: 'vcdApi.allocateFreeIp',
      stage: 'request',
      method: 'POST',
      url: REMOTE_URL,
      headers: options.headers as Record<string, unknown>,
      requestBody: payload,
    });

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      
      res.on('end', () => {
        logApi({
          source: 'vcdApi.allocateFreeIp',
          stage: 'response',
          method: 'POST',
          url: REMOTE_URL,
          status: res.statusCode || 0,
          durationMs: Date.now() - startedAt,
          headers: res.headers as Record<string, unknown>,
          responseBody: data,
        });
        console.log('[IP Allocator] Response status:', res.statusCode);
        console.log('[IP Allocator] Response body:', data.substring(0, 500));
        
        if (res.statusCode !== 200 && res.statusCode !== 201) {
          resolve({
            success: false,
            error: `IP allocation failed with status ${res.statusCode}: ${data}`,
          });
          return;
        }
        
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          
          // Check various response formats
          if (parsed.ip && typeof parsed.ip === 'string') {
            resolve({ success: true, ip: parsed.ip });
          } else if (parsed.allocated_ip && typeof parsed.allocated_ip === 'string') {
            resolve({ success: true, ip: parsed.allocated_ip });
          } else if (parsed.address && typeof parsed.address === 'string') {
            resolve({ success: true, ip: parsed.address });
          } else {
            resolve({
              success: false,
              error: 'No IP address found in response',
            });
          }
        } catch (e) {
          resolve({
            success: false,
            error: `Failed to parse response: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    });

    req.on('error', (err) => {
      logApi({
        source: 'vcdApi.allocateFreeIp',
        stage: 'error',
        method: 'POST',
        url: REMOTE_URL,
        durationMs: Date.now() - startedAt,
        error: err.message,
      });
      console.error('[IP Allocator] Request error:', err);
      resolve({
        success: false,
        error: `Cannot reach IP allocation service: ${err.message}`,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: 'IP allocation service timed out',
      });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Get all free (unallocated) IPs from the IP registrar service.
 * Calls GET http://164.99.91.31:5100/api/res-ip/free
 * @returns Array of free IP strings, or error
 */
export async function getFreeIps(): Promise<{ success: boolean; ips?: string[]; count?: number; error?: string }> {
  const FREE_URL = 'http://164.99.91.31:5100/api/res-ip/free';

  return new Promise((resolve) => {
    const parsed = new URL(FREE_URL);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 5100,
      path: parsed.pathname,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    };

    console.log('[IP Pool] Fetching free IPs from:', FREE_URL);
    const startedAt = Date.now();
    logApi({
      source: 'vcdApi.getFreeIps',
      stage: 'request',
      method: 'GET',
      url: FREE_URL,
      headers: options.headers as Record<string, unknown>,
    });

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        logApi({
          source: 'vcdApi.getFreeIps',
          stage: 'response',
          method: 'GET',
          url: FREE_URL,
          status: res.statusCode || 0,
          durationMs: Date.now() - startedAt,
          responseBody: data,
        });

        if (res.statusCode !== 200) {
          resolve({ success: false, error: `Free IPs request failed with status ${res.statusCode}: ${data}` });
          return;
        }

        try {
          const body = JSON.parse(data) as unknown;
          // Handle: array of strings, array of objects with ip/address field, or { ips: [...] }
          let ips: string[] = [];
          if (Array.isArray(body)) {
            ips = body.map((item) => {
              if (typeof item === 'string') return item;
              if (typeof item === 'object' && item !== null) {
                const o = item as Record<string, unknown>;
                return String(o.ip ?? o.address ?? o.ipAddress ?? '');
              }
              return '';
            }).filter(Boolean);
          } else if (typeof body === 'object' && body !== null) {
            const o = body as Record<string, unknown>;
            const arr = o.ips ?? o.free_ips ?? o.freeIps ?? o.addresses ?? o.data;
            if (Array.isArray(arr)) {
              ips = (arr as unknown[]).map((item) =>
                typeof item === 'string' ? item : String((item as Record<string, unknown>).ip ?? (item as Record<string, unknown>).address ?? '')
              ).filter(Boolean);
            }
          }
          resolve({ success: true, ips, count: ips.length });
        } catch (e) {
          resolve({ success: false, error: `Failed to parse free IPs response: ${e instanceof Error ? e.message : String(e)}` });
        }
      });
    });

    req.on('error', (err) => {
      logApi({ source: 'vcdApi.getFreeIps', stage: 'error', method: 'GET', url: FREE_URL, durationMs: Date.now() - startedAt, error: err.message });
      resolve({ success: false, error: `Cannot reach IP pool service: ${err.message}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'IP pool service timed out' }); });
    req.end();
  });
}
