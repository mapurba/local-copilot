# Slide 4: Value Add for Internal Stakeholders

## Stakeholder Value

**Engineering Managers**
- Team throughput increases because engineers stop losing 30–60 minutes per VM provisioning task.
- Consistent provisioning outcomes reduce environment-related ticket noise.
- Audit trail of VCD tasks provides visibility into infrastructure churn without requiring VCD admin access.

**QA Leads**
- Test environments are reproducible: same template + same script inputs = same result every time.
- Snapshot/revert removes the need to re-provision a VM from scratch when a test suite corrupts the environment.
- QA engineers self-serve environment setup without involving ops or senior engineers.

**Platform / Ops Teams**
- All VCD operations go through a governed tool registry — no raw API calls, no undocumented curl one-liners.
- `review` and `dangerous` risk levels enforce approval before any state-changing operation.
- Auto-reauth means sessions never silently break overnight jobs.
- Startup scripts are version-controlled and modular — updates to network config or ILM setup apply to all future VMs without re-training users.

**Product / Engineering Leadership**
- Faster test environment turnaround directly shortens feedback loops between development and validation.
- Reduced manual steps lower the probability of environment-related release delays.
- The tool registry model is extensible: new VCD capabilities (e.g., vApp creation, NAT rules, disk operations) can be added as new tools without changing the user experience.

## Business Impact Signals

| Metric | Before | Target |
|---|---|---|
| Time to provision a new VM with ILM | 20–40 min | < 5 min |
| Number of manual steps per provision | 15+ | 1 (confirm form) |
| VM reprovisioning attempts due to script errors | frequent | near zero (validated inputs) |
| Time to restore a QA environment after corruption | 20–30 min (re-provision) | < 2 min (snapshot revert) |
| Required VCD knowledge to provision | high (tribal) | low (guided chat) |

