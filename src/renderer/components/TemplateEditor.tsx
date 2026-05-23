import React, { useEffect, useState } from 'react';
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@ux-aspects-universal/react/dialog';
import { Button } from '@ux-aspects-universal/react/button';

interface TemplateEditorProps {
  open: boolean;
  templateId: string;
  initialXml: string;
  onClose: () => void;
  onSave: (templateId: string, xml: string) => Promise<void> | void;
}

const TemplateEditor: React.FC<TemplateEditorProps> = ({ open, templateId, initialXml, onClose, onSave }) => {
  const [xml, setXml] = useState(initialXml || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setXml(initialXml || '');
  }, [initialXml]);

  const handleSave = async () => {
    try {
      setSaving(true);
      await onSave(templateId, xml);
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={onClose} aria-label={`Edit template ${templateId}`}>
      <DialogHeader>Edit Template</DialogHeader>
      <DialogContent>
        <div className="flex flex-col">
          <div className="text-xs text-gray-400 mb-2">Template ID: {templateId}</div>
          <textarea
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            rows={18}
            className="w-full bg-gray-800 text-gray-100 font-mono text-xs p-2 border border-gray-700 rounded"
          />
        </div>
      </DialogContent>
      <DialogFooter>
        <Button flat onClick={onClose} disabled={saving}>Cancel</Button>
        <Button primary onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
      </DialogFooter>
    </Dialog>
  );
};

export default TemplateEditor;
