import React, { useState } from 'react';
import { Form, FormField, FormFieldLabel } from '@ux-aspects-universal/react/form';
import { TextInput } from '@ux-aspects-universal/react/text-input';
import { Button } from '@ux-aspects-universal/react/button';
import { Checkbox } from '@ux-aspects-universal/react/checkbox';

interface CreateVmFormProps {
  onSubmit?: (formData: Record<string, unknown>) => void;
  onStatusChange?: (message: string, type: 'success' | 'error' | 'info') => void;
}


const CreateVmForm: React.FC<CreateVmFormProps> = ({ onSubmit, onStatusChange }) => {
  const [formData, setFormData] = useState({
    vm_name: '',
    template_id: '',
    network_name: '',
    ip_address: '',
    power_on: 'true',
    setup_ilm: false,
    ilm_version: '',
    custom_env_content: '',
  });
  const [loading, setLoading] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      setFormData((prev) => ({
        ...prev,
        custom_env_content: typeof result === 'string' ? result : ''
      }));
    };
    reader.readAsText(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.vm_name.trim()) {
      onStatusChange?.('VM name is required', 'error');
      return;
    }

    setLoading(true);
    onStatusChange?.('Submitting VM creation request...', 'info');

    try {
      // Send to chat interface with VCD tools enabled
      // The chat will handle create_vm_draft and show the review form
      onSubmit?.(formData);
      onStatusChange?.('VM creation request sent. Review the form in chat.', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create VM';
      onStatusChange?.(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleFetchFreeIp = async () => {
    try {
      const result = await window.copilot.allocateFreeIp();
      if (result.success && typeof result.ip === 'string') {
        setFormData((prev) => ({
          ...prev,
          ip_address: result.ip ?? prev.ip_address,
        }));
      } else {
        console.error('[CreateVmForm] Failed to allocate IP:', result.error);
        alert(`Failed to allocate IP: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('[CreateVmForm] Error allocating IP:', err);
      alert(`Error allocating IP: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full min-h-0 bg-gray-900">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-gray-200">New Virtual Machine</span>
      </div>

      {/* Form Fields */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <Form orientation="vertical">
          <FormField>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 500 }}>
              <Checkbox
                isChecked={!!formData.setup_ilm}
                onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, setup_ilm: checked }))}
              />
              Setup ILM
            </label>
          </FormField>

          {formData.setup_ilm && (
            <>
              <FormField>
                <FormFieldLabel>ILM Version</FormFieldLabel>
                <TextInput
                  name="ilm_version"
                  value={formData.ilm_version}
                  onValueChange={(v) => setFormData((prev) => ({ ...prev, ilm_version: v }))}
                  placeholder="e.g., 1.3.0 or latest"
                />
              </FormField>
              <FormField>
                <FormFieldLabel>Custom .env File (optional)</FormFieldLabel>
                <input
                  type="file"
                  accept=".env,text/plain"
                  onChange={handleFileChange}
                  className="w-full text-xs text-gray-400"
                />
                {formData.custom_env_content && (
                  <div className="mt-1 text-xs text-green-400">.env file loaded ({formData.custom_env_content.length} chars)</div>
                )}
              </FormField>
            </>
          )}

          <FormField>
            <FormFieldLabel isRequired>VM Name</FormFieldLabel>
            <TextInput
              name="vm_name"
              value={formData.vm_name}
              onValueChange={(v) => setFormData((prev) => ({ ...prev, vm_name: v }))}
              placeholder="e.g., my-vm-01"
            />
          </FormField>

          <FormField>
            <FormFieldLabel>Template ID</FormFieldLabel>
            <TextInput
              name="template_id"
              value={formData.template_id}
              onValueChange={(v) => setFormData((prev) => ({ ...prev, template_id: v }))}
              placeholder="Leave blank for default"
            />
          </FormField>

          <FormField>
            <FormFieldLabel>Network Name</FormFieldLabel>
            <TextInput
              name="network_name"
              value={formData.network_name}
              onValueChange={(v) => setFormData((prev) => ({ ...prev, network_name: v }))}
              placeholder="Leave blank for default"
            />
          </FormField>

          <FormField>
            <FormFieldLabel>IP Address <span className="text-gray-500">(MANUAL only)</span></FormFieldLabel>
            <div style={{ display: 'flex', gap: '8px' }}>
              <TextInput
                name="ip_address"
                value={formData.ip_address}
                onValueChange={(v) => setFormData((prev) => ({ ...prev, ip_address: v }))}
                placeholder="10.0.0.10"
              />
              <Button secondary size="small" type="button" onClick={handleFetchFreeIp} title="Fetch free IP">
                Fetch
              </Button>
            </div>
          </FormField>

          <FormField>
            <FormFieldLabel>Power On After Create</FormFieldLabel>
            <select
              name="power_on"
              value={formData.power_on}
              onChange={handleChange}
              style={{ width: '100%' }}
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </FormField>
        </Form>
      </div>

      {/* Submit Button */}
      <div className="px-4 py-3 bg-gray-800 border-t border-gray-700">
        <Button primary isDisabled={loading || !formData.vm_name.trim()} type="submit"
          style={{ width: '100%' }}
          iconBefore={loading ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : undefined}
        >
          {loading ? 'Deploying...' : 'Deploy VM'}
        </Button>
      </div>
    </form>
  );
};

export default CreateVmForm;
