# VCD Agent Extension — Copilot Instructions

This workspace has the **VCD Agent** extension installed, which provides direct access to VMware Cloud Director (VCD) and remote Linux hosts via SSH.

## Available tool groups

| Prefix | What it does |
|--------|-------------|
| `vcd-agent_list*` / `vcd-agent_get*` / `vcd-agent_check*` | Query VCD — VMs, vApps, templates, tasks, snapshots, IP pool |
| `vcd-agent_powerOnVm` / `vcd-agent_powerOffVm` / `vcd-agent_deleteVm` | VM lifecycle (confirmation required) |
| `vcd-agent_copyVm` / `vcd-agent_resizeVm` / `vcd-agent_createSnapshot` / `vcd-agent_revertSnapshot` | VM management (confirmation required) |
| `vcd-agent_ssh*` | SSH into remote hosts: run commands, read/write files, manage services, view logs |
| `vcd-agent_docs*` | Upload, search, and query PDF/DOCX/TXT documents |
| `vcd-agent_local*` | Read/write files and run commands in the local workspace |
| `vcd-agent_task*` | Create and track multi-step operations |

## Rules

- When the user asks about VMs, virtual machines, vApps, templates, or any VCD resource — **always use the `vcd-agent_list*` or `vcd-agent_get*` tools** rather than suggesting CLI commands.
- When the user asks to SSH into a server or run a remote command — **use `vcd-agent_sshConnect` then `vcd-agent_sshRunCommand`**.
- When the user asks a question that could be answered by an uploaded document — **use `vcd-agent_docsAsk` or `vcd-agent_docsSearch`**.
- Never tell the user to install vcd-cli, PowerCLI, or use the REST API directly — the extension tools handle all of this.
