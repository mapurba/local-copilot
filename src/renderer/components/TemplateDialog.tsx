import React, { useState } from 'react';
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@ux-aspects-universal/react/dialog';
import { Button } from '@ux-aspects-universal/react/button';

interface TemplateDialogProps {
  open: boolean;
  vmName: string;
  os?: string;
  initialTemplateId?: string;
  initialTemplateName?: string;
  onSubmit: (templateId: string, templateName?: string) => void;
  onCancel: () => void;
}

const TemplateDialog: React.FC<TemplateDialogProps> = ({
  open,
  vmName,
  os,
  initialTemplateId = '',
  initialTemplateName = '',
  onSubmit,
  onCancel,
}) => {
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [templateName, setTemplateName] = useState(initialTemplateName);

  const handleSubmit = () => {
    if (templateId.trim()) {
      onSubmit(templateId.trim(), templateName.trim() || undefined);
    }
  };

  if (!open) return null;
  return (
    <Dialog onClose={onCancel} aria-label="Select Template">
      <DialogHeader>Template Required for {vmName}{os ? ` (${os})` : ''}</DialogHeader>
      <DialogContent>
        <div className="flex flex-col gap-3">
          <label>
            Template ID (required):
            <input
              className="w-full px-2 py-1 rounded border border-gray-600 bg-gray-900 text-gray-100"
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              placeholder="Enter template ID"
              autoFocus
            />
          </label>
          <label>
            Template Name (optional):
            <input
              className="w-full px-2 py-1 rounded border border-gray-600 bg-gray-900 text-gray-100"
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              placeholder="Enter template name"
            />
          </label>
        </div>
      </DialogContent>
      <DialogFooter>
        <Button secondary onClick={onCancel}>Cancel</Button>
        <Button primary onClick={handleSubmit} disabled={!templateId.trim()}>OK</Button>
      </DialogFooter>
    </Dialog>
  );
};

export default TemplateDialog;
