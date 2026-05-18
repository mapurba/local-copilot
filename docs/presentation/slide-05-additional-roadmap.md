# Slide 5: Adoption Roadmap & Next Steps

## 30-60-90 Day Rollout

**First 30 Days — Controlled Pilot**
- Onboard one dev squad and one QA pod on core VM workflows: create, power, snapshot, revert, list.
- Validate auto-reauth behaviour against internal VCD token expiry policy.
- Collect provisioning time measurements (before/after) and error rates.
- Identify VDC-specific defaults (gateway, DNS, storage profile, compute policy) for each org and encode them as named presets.

**Days 31–60 — Expand and Refine**
- Roll out to additional teams; add any missing VCD operations surfaced during pilot (e.g., vApp creation, disk resize).
- Tune ILM startup script for edge cases discovered in the field (new OS templates, proxy variations by network segment).
- Add SSH tool integration so post-provision verification (service health checks) can also be triggered from chat.
- Define runbook for handling VCD API version upgrades.

**Days 61–90 — Standardise and Own**
- Publish internal user guide covering all 16 VCD tools with example prompts.
- Define ownership model: who maintains the tool registry, who approves new tools.
- Introduce usage metrics (tool call counts, error rates, provisioning times) for continuous improvement tracking.
- Evaluate adding org-level VCD admin tools (vApp templates, catalog management) based on demand.

## Capability Roadmap

| Capability | Status | Notes |
|---|---|---|
| VM create / power / delete / resize | ✅ Done | 16 tools in registry |
| Snapshot create / revert / list | ✅ Done | cloudapi + XML endpoints |
| IP allocation from pool | ✅ Done | internal query |
| ILM stack setup via startup script | ✅ Done | injected at VM-creation time |
| Custom `.env` with LLM IP rewrite | ✅ Done | fallback to deterministic replace |
| SSH post-provision commands | 🔄 In progress | SSH tool category exists |
| vApp create / manage | 📋 Planned | |
| Disk / storage operations | 📋 Planned | |
| Network / NAT rule management | 📋 Planned | |
| Multi-org / cross-VDC context switching | 📋 Planned | |

## Success Metrics to Track
- **Provisioning time**: median time from "create VM" prompt to powered-on VM.
- **Error-free provision rate**: % of VM creates that succeed without retry.
- **Snapshot restore time**: time from "revert" prompt to VM back online.
- **Manual step elimination**: reduction in ops tickets related to VM provisioning.
- **Adoption**: weekly active users and tool call volume per team.

