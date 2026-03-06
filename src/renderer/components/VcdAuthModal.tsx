import React, { useState } from 'react';

const VCD_HOST = 'ban-vcd.otxlab.net';
const ORG_OPTIONS = ['ban2_identity_ilm', 'ban2_identity_edir', 'ban2_identity_idm'];
const VDC_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '34a51351-8747-4fef-966f-742a9b1ba059',
  ban2_identity_ilm: '7844a49e-a3f2-48c1-89a8-5850e23fe3ff',
  ban2_identity_idm: '023d9885-8ad6-4ef8-9154-2c1d8f9205d3',
};
const ORG_UUID_MAP: Record<string, string> = {
  ban2_identity_edir: '',
  ban2_identity_ilm: 'fbf2e477-e45e-41a4-be7d-d8b3bc3e4197',
  ban2_identity_idm: '',
};
const STORAGE_PROFILE_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '90895948-aca6-468f-9b3f-edc538b28300',
  ban2_identity_ilm: '1f35699f-390d-446f-a813-de772f2470b4',
  ban2_identity_idm: 'ae6341bb-b5b9-423e-9651-3ee1a57cf983',
};
const COMPUTE_POLICY_ID_MAP: Record<string, string> = {
  ban2_identity_edir: '99d7f24e-f634-40b4-bebe-e1e06d27c26f',
  ban2_identity_ilm: '0d22b7d1-67b7-4776-a05b-8d86ed36ef53',
  ban2_identity_idm: '9da3314f-2883-4083-94b5-c7b4af2b4878',
};
const DEFAULT_NETWORK = 'BAN2_Vlan90_lr0';
const DEFAULT_GATEWAY = '10.71.39.254';
const DEFAULT_DNS = '15.122.222.53';

interface VcdAuthModalProps {
  onComplete: (result: { connected: boolean; user?: string; org?: string; host?: string }) => void;
  onClose: () => void;
}

const VcdAuthModal: React.FC<VcdAuthModalProps> = ({ onComplete, onClose }) => {
  const [org, setOrg] = useState('ban2_identity_ilm');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiVersion, setApiVersion] = useState('38.0');
  const [vdcId, setVdcId] = useState(VDC_ID_MAP.ban2_identity_ilm);
  const [orgUuid, setOrgUuid] = useState(ORG_UUID_MAP.ban2_identity_ilm);
  const [networkName, setNetworkName] = useState(DEFAULT_NETWORK);
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY);
  const [dnsServers, setDnsServers] = useState(DEFAULT_DNS);
  const [storageProfileId, setStorageProfileId] = useState(STORAGE_PROFILE_ID_MAP.ban2_identity_ilm);
  const [computePolicyId, setComputePolicyId] = useState(COMPUTE_POLICY_ID_MAP.ban2_identity_ilm);
  const [rejectUnauthorized, setRejectUnauthorized] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setError('');
    setIsSubmitting(true);
    try {
      const result = await window.copilot.vcdSignIn({
        org: org.trim(),
        username: username.trim(),
        password,
        apiVersion: apiVersion.trim() || undefined,
        vdcId: vdcId.trim() || undefined,
        orgUuid: orgUuid.trim() || undefined,
        networkName: networkName.trim() || undefined,
        gateway: gateway.trim() || undefined,
        dnsServers: dnsServers.trim() || undefined,
        storageProfileId: storageProfileId.trim() || undefined,
        computePolicyId: computePolicyId.trim() || undefined,
        rejectUnauthorized,
      });
      onComplete(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to sign in to VCD.';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl p-8 w-[520px] shadow-2xl border border-gray-600">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">Sign in to VCD</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-gray-300">Organization</label>
              <select
                value={org}
                onChange={(e) => {
                  const value = e.target.value;
                  setOrg(value);
                  setVdcId(VDC_ID_MAP[value] || '');
                  setOrgUuid(ORG_UUID_MAP[value] || '');
                  setStorageProfileId(STORAGE_PROFILE_ID_MAP[value] || '');
                  setComputePolicyId(COMPUTE_POLICY_ID_MAP[value] || '');
                }}
                className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
              >
                {ORG_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-gray-300">API Version</label>
              <input
                value={apiVersion}
                onChange={(e) => setApiVersion(e.target.value)}
                placeholder="38.0"
                className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
              />
            </div>
          </div>
          <div>
            <label className="text-sm text-gray-300">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user"
              className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
            />
          </div>
          <div>
            <label className="text-sm text-gray-300">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
            />
          </div>

          <div className="text-xs text-gray-400">
            Host is fixed to <span className="text-gray-200">{VCD_HOST}</span>
          </div>

          <button
            type="button"
            onClick={() => setAdvanced((prev) => !prev)}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            {advanced ? 'Hide advanced' : 'Show advanced defaults'}
          </button>

          {advanced && (
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-300">VDC ID</label>
                <input
                  value={vdcId}
                  onChange={(e) => setVdcId(e.target.value)}
                  className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                />
              </div>
              <div>
                <label className="text-sm text-gray-300">Org UUID</label>
                <input
                  value={orgUuid}
                  onChange={(e) => setOrgUuid(e.target.value)}
                  className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                />
              </div>
              <div>
                <label className="text-sm text-gray-300">Network Name</label>
                <input
                  value={networkName}
                  onChange={(e) => setNetworkName(e.target.value)}
                  className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-300">Gateway</label>
                  <input
                    value={gateway}
                    onChange={(e) => setGateway(e.target.value)}
                    className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-300">DNS Servers</label>
                  <input
                    value={dnsServers}
                    onChange={(e) => setDnsServers(e.target.value)}
                    placeholder="1.1.1.1,8.8.8.8"
                    className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-300">Storage Profile ID</label>
                  <input
                    value={storageProfileId}
                    onChange={(e) => setStorageProfileId(e.target.value)}
                    className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-300">Compute Policy ID</label>
                  <input
                    value={computePolicyId}
                    onChange={(e) => setComputePolicyId(e.target.value)}
                    className="mt-1 w-full bg-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm border border-gray-600"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={rejectUnauthorized}
                  onChange={(e) => setRejectUnauthorized(e.target.checked)}
                  className="w-4 h-4"
                />
                Reject invalid TLS certs
              </label>
            </div>
          )}

          {error && (
            <p className="text-red-400 text-sm bg-red-900/20 rounded p-3">{error}</p>
          )}

          <button
            onClick={submit}
            disabled={isSubmitting}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white font-semibold py-3 px-4 rounded-lg transition-colors"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in to VCD'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VcdAuthModal;
