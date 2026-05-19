export interface VcdContext {
  host: string;
  token: string;
  apiVersion: string;
  orgName?: string;
  orgUuid?: string;
  username?: string;
  vdcId?: string;
  networkName?: string;
  gateway?: string;
  dnsServers?: string[];
  storageProfileId?: string;
  computePolicyId?: string;
  rejectUnauthorized?: boolean;
}

export interface VcdCreateForm {
  vm_name: string;
  template_id: string;
  template_name?: string;
  network_name?: string;
  ip_allocation_mode?: string;
  ip_address?: string;
  gateway?: string;
  dns_servers?: string;
  power_on?: boolean;
  storage_profile_id?: string;
  compute_policy_id?: string;
  setup_ilm?: boolean;
  ilm_version?: string;
  custom_env_content?: string;
  setup_idm?: boolean;
  idm_custom_env_content?: string;
}

let vcdContext: VcdContext | null = null;
let pendingForm: VcdCreateForm | null = null;

export function setVcdContext(partial: Partial<VcdContext>): VcdContext {
  const current = vcdContext || {
    host: '',
    token: '',
    apiVersion: '38.0',
    rejectUnauthorized: false,
  };
  vcdContext = { ...current, ...partial };
  return vcdContext;
}

export function getVcdContext(): VcdContext {
  if (!vcdContext || !vcdContext.host || !vcdContext.token) {
    throw new Error('VCD context not configured. Call set_vcd_context with host and token.');
  }
  return vcdContext;
}

export function clearVcdContext(): void {
  vcdContext = null;
}

export function setPendingForm(form: VcdCreateForm | null): void {
  pendingForm = form;
}

export function getPendingForm(): VcdCreateForm | null {
  return pendingForm;
}
