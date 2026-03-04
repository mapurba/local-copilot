import React, { useState } from 'react';

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
  });
  const [loading, setLoading] = useState(false);

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
    // Placeholder for IP allocation endpoint
    try {
      // const response = await fetch('/api/proxy/res-ip/allocate', {
      //   method: 'POST',
      //   body: JSON.stringify({ hostname: '' }),
      //   headers: { 'Content-Type': 'application/json' },
      // });
      // const data = await response.json();
      // if (data.status === 'success') {
      //   setFormData((prev) => ({ ...prev, ip_address: data.ip }));
      // }
    } catch (err) {
      console.error('Failed to fetch free IP:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
        <span className="text-sm font-semibold text-gray-200">New Virtual Machine</span>
      </div>

      {/* Form Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1.5">VM Name *</label>
          <input
            type="text"
            name="vm_name"
            value={formData.vm_name}
            onChange={handleChange}
            placeholder="e.g., my-vm-01"
            className="w-full bg-gray-700 text-gray-100 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1.5">Template ID</label>
          <input
            type="text"
            name="template_id"
            value={formData.template_id}
            onChange={handleChange}
            placeholder="Leave blank for default"
            className="w-full bg-gray-700 text-gray-100 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1.5">Network Name</label>
          <input
            type="text"
            name="network_name"
            value={formData.network_name}
            onChange={handleChange}
            placeholder="Leave blank for default"
            className="w-full bg-gray-700 text-gray-100 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1.5">
            IP Address <span className="text-gray-500">(MANUAL only)</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              name="ip_address"
              value={formData.ip_address}
              onChange={handleChange}
              placeholder="10.0.0.10"
              className="flex-1 bg-gray-700 text-gray-100 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
            />
            <button
              type="button"
              onClick={handleFetchFreeIp}
              className="px-3 py-2 bg-gray-700 text-gray-300 hover:bg-gray-600 text-xs rounded transition-colors border border-gray-600"
              title="Fetch free IP"
            >
              Fetch
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-300 mb-1.5">Power On After Create</label>
          <select
            name="power_on"
            value={formData.power_on}
            onChange={handleChange}
            className="w-full bg-gray-700 text-gray-100 text-sm rounded px-3 py-2 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      </div>

      {/* Submit Button */}
      <div className="px-4 py-3 bg-gray-800 border-t border-gray-700">
        <button
          type="submit"
          disabled={loading || !formData.vm_name.trim()}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded transition-colors text-sm"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
              Deploying...
            </span>
          ) : (
            'Deploy VM'
          )}
        </button>
      </div>
    </form>
  );
};

export default CreateVmForm;
