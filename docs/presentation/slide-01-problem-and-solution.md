# Slide 1: Problem Statement & Solution

## Problem Statement

Working with VMware Cloud Director (VCD) today requires navigating multiple surfaces:

- **VCD Web UI** — for provisioning and power operations.
- **Custom shell scripts** — for network configuration, ILM setup, and `.env` management.
- **Internal Jenkins artefacts** — for downloading ILM compose stacks.
- **Manual IP allocation lookups** — to find a free IP before creating a VM.
- **Task status checks** — via separate VCD task-history screens.
- **SSH sessions** — to verify boot state and run post-provisioning commands.

The result: provisioning a single VM reliably can require 15+ context switches, memorized curl commands, and tribal knowledge about network/DNS/gateway values that vary by org and VDC.

**Pain points with real impact:**
- New team members spend days learning the provisioning sequence.
- Mistakes in IP assignment or startup script variables cause silent failures only visible after reboot.
- No single place to track what was created, why, and by whom.
- Re-creating a test environment from scratch after a bug is slow and error-prone.

## Proposed Solution

**Local Copilot** replaces the fragmented workflow with a single conversational interface backed by purpose-built VCD tooling.

- **16 registered VCD tools** cover the full lifecycle: list, create, copy, power, resize, snapshot, revert, and delete — all with schema-validated inputs.
- **Startup script injection at VM creation**: network config, proxy cleanup, package installation, ILM setup, and custom `.env` content are compiled into one script and injected directly into the VCD `GuestCustomizationSection` at provisioning time — no post-boot SSH needed.
- **Auto-reauth**: bearer tokens expire silently; every API call automatically re-authenticates and retries so users never see a mid-task login failure.
- **Risk-level governance**: every tool is tagged `safe`, `review`, or `dangerous`. Review/dangerous operations pause for human approval before executing, preventing accidental deletes or power-offs.
- **Context memory**: VDC ID, network name, gateway, DNS servers, storage profile, and compute policy are stored per session so users never re-enter them.

