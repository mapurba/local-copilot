# Thinking Logs Quick Reference

## Purpose

Structured reasoning logs for chat requests.

## Main API

- startThinkingChain()
- addThinkingStep(content, category, metadata?, tokenCount?)
- getThinkingStats()

## Categories

- analysis
- planning
- decision
- reasoning
- synthesis

## UI

- Use THINKING filter to focus reasoning logs
- Expand a log item to inspect chain + metadata
- Compact mode for overview, detailed mode for inspection

## Source files

- src/renderer/app/services/debug-logger.service.ts
- src/renderer/app/components/debug-panel/debug-panel.component.ts
- src/renderer/app/components/debug-panel/debug-panel.component.html
- src/renderer/app/components/debug-panel/debug-panel.component.css
