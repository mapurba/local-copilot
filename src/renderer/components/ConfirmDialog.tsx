import React from 'react';
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@ux-aspects-universal/react/dialog';
import { Button } from '@ux-aspects-universal/react/button';

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title = 'Confirm',
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Allow',
  cancelLabel = 'Deny',
}) => {
  if (!open) return null;
  return (
    <Dialog onClose={onCancel} aria-label={title}>
      <DialogHeader>{title}</DialogHeader>
      <DialogContent>
        <p>{message}</p>
      </DialogContent>
      <DialogFooter>
        <Button secondary onClick={onCancel}>{cancelLabel}</Button>
        <Button primary onClick={onConfirm}>{confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  );
};

export default ConfirmDialog;
