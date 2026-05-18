export const VCD_HOST = 'ban-vcd.otxlab.net';
export const DEFAULT_ORG = 'ban2_identity_ilm';
export const API_VERSION = '38.0';
export const NETWORK_NAME = 'BAN2_Vlan90_lr0';
export const NETWORK_ADAPTER_TYPE = 'VMXNET3';
export const IP_ALLOCATION_MODE = 'DHCP';
export const GATEWAY = '10.71.39.254';
export const DNS_SERVERS = ['15.122.222.53'];

export const ORG_OPTIONS = [
  'ban2_identity_ilm',
  'ban2_identity_edir',
  'ban2_identity_idm',
];

export const VDC_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '34a51351-8747-4fef-966f-742a9b1ba059',
  ban2_identity_ilm: '7844a49e-a3f2-48c1-89a8-5850e23fe3ff',
  ban2_identity_idm: '023d9885-8ad6-4ef8-9154-2c1d8f9205d3',
};

export const ORG_UUID_MAP: Record<string, string> = {
  ban2_identity_edir: '',
  ban2_identity_ilm: 'fbf2e477-e45e-41a4-be7d-d8b3bc3e4197',
  ban2_identity_idm: '',
};

export const STORAGE_PROFILE_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '90895948-aca6-468f-9b3f-edc538b28300',
  ban2_identity_ilm: '1f35699f-390d-446f-a813-de772f2470b4',
  ban2_identity_idm: 'ae6341bb-b5b9-423e-9651-3ee1a57cf983',
};

export const COMPUTE_POLICY_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '99d7f24e-f634-40b4-bebe-e1e06d27c26f',
  ban2_identity_ilm: '0d22b7d1-67b7-4776-a05b-8d86ed36ef53',
  ban2_identity_idm: '9da3314f-2883-4083-94b5-c7b4af2b4878',
};

export function getDefaultsForOrg(org: string) {
  return {
    vdcId: VDC_ID_MAP[org] || VDC_ID_MAP[DEFAULT_ORG],
    orgUuid: ORG_UUID_MAP[org] || ORG_UUID_MAP[DEFAULT_ORG],
    storageProfileId: STORAGE_PROFILE_ID_MAP[org] || STORAGE_PROFILE_ID_MAP[DEFAULT_ORG],
    computePolicyId: COMPUTE_POLICY_ID_MAP[org] || COMPUTE_POLICY_ID_MAP[DEFAULT_ORG],
  };
}
