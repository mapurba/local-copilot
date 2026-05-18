/**
 * Shell script fragment – post-configuration finalization.
 *
 * Relies on $LOG being set in the calling script.
 * Placeholder replaced at runtime: __IP_ADDRESS__
 *
 * Execution order:
 *   1. Register the assigned IP with the central registry (fire-and-forget).
 *   2. Hand off to linuxsysprep.sh if present (exec replaces the process).
 *   3. Log completion (only reached when no sysprep script exists).
 */
export const FINALIZATION_SCRIPT = `
(
    curl -s -X POST http://164.99.91.31:5100/api/res-ip \
        -H "Content-Type: application/json" \
        -d '{"ip": "__IP_ADDRESS__", "status": "used"}' >> "$LOG" 2>&1 || \
        echo "IP registration failed" >> "$LOG"
) &
[ -f /root/linuxsysprep.sh ] && exec /root/linuxsysprep.sh
echo "VCD Customization Completed" >> "$LOG"
`;
