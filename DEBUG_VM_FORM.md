# VM Review Form Debug Guide

## Issue
When creating a VM with the prompt "create a ubuntu vm with name 'apurba-sles' and setup ilm 1.3.0", the review form is not appearing in the UI.

## Debug Logging Added

I've added comprehensive logging throughout the entire flow to help identify where the issue occurs:

### 1. Backend - createVmDraft Function (vcdApi.ts)
```
[createVmDraft] Called with form: {...}
[createVmDraft] Returning response: {...}
```

### 2. Backend - Tool Execution (copilotChatApi.ts)
```
[VM DRAFT] Detected create_vm_draft tool call
[VM DRAFT] Raw result: ...
[VM DRAFT] Parsed type: vm_create_form
[VM DRAFT] Has form: true
[VM DRAFT] ✓ Emitting form via onVmDraft callback
```

### 3. IPC Handler (ipcHandlers.ts)
```
[IPC] sendChatMessageWithTools called
[IPC] onVmDraft callback triggered, emitting chat:vm-draft event
[IPC] Form data: {...}
```

### 4. Frontend - ChatPane Component (ChatPane.tsx)
```
[ChatPane] onVmDraft event received
[ChatPane] Form data: {...}
[ChatPane] Pending form state updated
```

## How to Debug

1. **Restart the Electron app** to load the new build
2. **Open Developer Tools** (View > Toggle Developer Tools or press F12)
3. **Watch the Console tab** while testing
4. **Send the test prompt**: "create a ubuntu vm with name 'apurba-sles' and setup ilm 1.3.0"

## Expected Log Flow

If everything works correctly, you should see this sequence:

```
[TOOL] list_templates called with name_filter="ubuntu"
[LANGCHAIN] Tool call: list_templates {"name_filter":"ubuntu"}
[LANGCHAIN] Tool result (list_templates): {...templates...}

[LANGCHAIN] Tool call: create_vm_draft {"vm_name":"apurba-sles","template_id":"...","setup_ilm":true,"ilm_version":"1.3.0"}
[createVmDraft] Called with form: {
  "vm_name": "apurba-sles",
  "template_id": "...",
  "setup_ilm": true,
  "ilm_version": "1.3.0",
  ...
}
[createVmDraft] Returning response: {
  "type": "vm_create_form",
  "message": "Review the VM details and confirm to create the VM.",
  "form": {...}
}
[LANGCHAIN] Tool result (create_vm_draft): {"type":"vm_create_form",...}

[VM DRAFT] Detected create_vm_draft tool call
[VM DRAFT] Raw result: {"type":"vm_create_form","message":"Review the VM details and confirm to create the VM.","form":{...}}
[VM DRAFT] Parsed type: vm_create_form
[VM DRAFT] Has form: true
[VM DRAFT] ✓ Emitting form via onVmDraft callback

[IPC] onVmDraft callback triggered, emitting chat:vm-draft event
[IPC] Form data: {...}

[ChatPane] onVmDraft event received
[ChatPane] Form data: {...}
[ChatPane] Pending form state updated
```

## Possible Issues to Look For

### Issue 1: LLM Not Calling create_vm_draft
**Symptoms**: No `[LANGCHAIN] Tool call: create_vm_draft` log
**Cause**: LLM might not recognize the request or might be asking for confirmation
**Fix**: Check if the LLM is responding with text instead of calling the tool

### Issue 2: Wrong Response Format
**Symptoms**: You see `[VM DRAFT] ✗ Type or form missing, not emitting`
**Cause**: createVmDraft is not returning the expected format
**Fix**: Check the `[createVmDraft] Returning response` log to verify the structure

### Issue 3: Callback Not Wired
**Symptoms**: You see tool execution logs but no `[IPC] onVmDraft callback triggered`
**Cause**: The onVmDraft callback parameter might not be passed correctly
**Fix**: Verify the IPC handler is passing the callback to chatWithTools

### Issue 4: Frontend Not Receiving Event
**Symptoms**: You see IPC logs but no `[ChatPane] onVmDraft event received`
**Cause**: Event listener might not be registered or event name mismatch
**Fix**: Check if the event name 'chat:vm-draft' matches in both sender and receiver

## Quick Test

Try a simpler prompt first to verify the tool system works:
```
list templates with ubuntu
```

This should show:
```
[TOOL] list_templates called with name_filter="ubuntu"
```

If that works, the tool system is functioning and the issue is specifically with create_vm_draft.

## Contact

After testing, share the console output so we can identify exactly where the flow breaks.
