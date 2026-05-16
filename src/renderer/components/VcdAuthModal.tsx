import React, { useState } from 'react';
import { Dialog, DialogHeader, DialogContent, DialogFooter, DialogDismissButton } from '@ux-aspects-universal/react/dialog';
import { Form, FormField, FormFieldLabel } from '@ux-aspects-universal/react/form';
import { TextInput } from '@ux-aspects-universal/react/text-input';
import { Button } from '@ux-aspects-universal/react/button';
import { Checkbox } from '@ux-aspects-universal/react/checkbox';

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
    <Dialog onClose={onClose} aria-label="Sign in to VCD" style={{ width: '520px' }}>
      <DialogHeader dismissButton={<DialogDismissButton onClick={onClose} />}>
        Sign in to VCD
      </DialogHeader>
      <DialogContent>
        <Form orientation="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormField>
              <FormFieldLabel>Organization</FormFieldLabel>
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
                style={{ width: '100%', marginTop: '4px' }}
              >
                {ORG_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </FormField>
            <FormField>
              <FormFieldLabel>API Version</FormFieldLabel>
              <TextInput
                value={apiVersion}
                onValueChange={setApiVersion}
                placeholder="38.0"
              />
            </FormField>
          </div>

          <FormField>
            <FormFieldLabel>Username</FormFieldLabel>
            <TextInput
              value={username}
              onValueChange={setUsername}
              placeholder="user"
            />
          </FormField>

          <FormField>
            <FormFieldLabel>Password</FormFieldLabel>
            <TextInput
              type="password"
              value={password}
              onValueChange={setPassword}
            />
          </FormField>

          <div style={{ fontSize: '12px', opacity: 0.6, marginTop: '4px' }}>
            Host is fixed to <strong>{VCD_HOST}</strong>
          </div>

          <Button flat size="small" onClick={() => setAdvanced((prev) => !prev)} style={{ marginTop: '8px', alignSelf: 'flex-start' }}>
            {advanced ? 'Hide advanced' : 'Show advanced defaults'}
          </Button>

          {advanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
              <FormField>
                <FormFieldLabel>VDC ID</FormFieldLabel>
                <TextInput value={vdcId} onValueChange={setVdcId} />
              </FormField>
              <FormField>
                <FormFieldLabel>Org UUID</FormFieldLabel>
                <TextInput value={orgUuid} onValueChange={setOrgUuid} />
              </FormField>
              <FormField>
                <FormFieldLabel>Network Name</FormFieldLabel>
                <TextInput value={networkName} onValueChange={setNetworkName} />
              </FormField>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <FormField>
                  <FormFieldLabel>Gateway</FormFieldLabel>
                  <TextInput value={gateway} onValueChange={setGateway} />
                </FormField>
                <FormField>
                  <FormFieldLabel>DNS Servers</FormFieldLabel>
                  <TextInput value={dnsServers} onValueChange={setDnsServers} placeholder="1.1.1.1,8.8.8.8" />
                </FormField>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <FormField>
                  <FormFieldLabel>Storage Profile ID</FormFieldLabel>
                  <TextInput value={storageProfileId} onValueChange={setStorageProfileId} />
                </FormField>
                <FormField>
                  <FormFieldLabel>Compute Policy ID</FormFieldLabel>
                  <TextInput value={computePolicyId} onValueChange={setComputePolicyId} />
                </FormField>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <Checkbox
                  isChecked={rejectUnauthorized}
                  onCheckedChange={setRejectUnauthorized}
                />
                Reject invalid TLS certs
              </label>
            </div>
          )}

          {error && (
            <div style={{ color: '#f87171', fontSize: '13px', padding: '10px 12px', borderRadius: '6px', background: 'rgba(127,29,29,0.2)', marginTop: '8px' }}>
              {error}
            </div>
          )}
        </Form>
      </DialogContent>
      <DialogFooter>
        <Button primary isDisabled={isSubmitting} onClick={submit} style={{ width: '100%' }}>
          {isSubmitting ? 'Signing in…' : 'Sign in to VCD'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

export default VcdAuthModal;
