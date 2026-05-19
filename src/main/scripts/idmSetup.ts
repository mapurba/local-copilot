/**
 * Shell script fragment – conditional IDM container setup.
 *
 * Relies on the following bash variables set by the calling script:
 *   $SETUP_IDM, $LOG
 *
 * Skips silently when SETUP_IDM != "true".
 * If /root/uploaded_idm.env exists it is copied over the extracted .env
 * before setup.sh is executed.
 */
export const IDM_SETUP_SCRIPT = `
    # ── IDM setup ────────────────────────────────────────────────────────────
    if [ "$SETUP_IDM" = "true" ]; then
        echo "Starting IDM setup..." >> "$LOG"

        IDM_DEST_DIR="/root/Downloads"
        IDM_URL="https://amondal.idm.labs.blr.novell.com/vcd-agent/idm_compose.zip"
        IDM_ZIP_FILE="idm_compose.zip"
        IDM_EXTRACT_FOLDER="idm_compose"

        mkdir -p "$IDM_DEST_DIR"
        cd "$IDM_DEST_DIR"

        echo "Downloading IDM compose from $IDM_URL..." >> "$LOG"
        IDM_DOWNLOAD_OK=false
        if command -v wget >/dev/null 2>&1; then
            wget --no-check-certificate --timeout=20 --tries=3 \\
                 -O "$IDM_ZIP_FILE" "$IDM_URL" >> "$LOG" 2>&1 \\
                 && IDM_DOWNLOAD_OK=true
        fi
        if [ "$IDM_DOWNLOAD_OK" = "false" ]; then
            curl -fsSL --retry 3 --connect-timeout 20 --insecure \\
                 -o "$IDM_ZIP_FILE" "$IDM_URL" >> "$LOG" 2>&1 \\
                 && IDM_DOWNLOAD_OK=true
        fi

        if [ "$IDM_DOWNLOAD_OK" = "true" ]; then

            unzip -q -o "$IDM_ZIP_FILE" -d "$IDM_DEST_DIR" >> "$LOG" 2>&1

            if [ -d "$IDM_DEST_DIR/$IDM_EXTRACT_FOLDER" ]; then
                if [ -f /root/uploaded_idm.env ]; then
                    cp /root/uploaded_idm.env "$IDM_DEST_DIR/$IDM_EXTRACT_FOLDER/.env"
                    echo "IDM .env replaced from upload." >> "$LOG"
                else
                    echo "No custom IDM .env provided; using default from zip." >> "$LOG"
                fi

                cd "$IDM_DEST_DIR/$IDM_EXTRACT_FOLDER"
                chmod +x setup.sh
                echo "Running IDM setup.sh..." >> "$LOG"
                ./setup.sh >> "$LOG" 2>&1
                echo "IDM setup complete." >> "$LOG"
            else
                echo "ERROR: IDM directory not found after extraction." >> "$LOG"
                ls -la "$IDM_DEST_DIR" >> "$LOG"
            fi
        else
            echo "ERROR: Failed to download IDM zip from $IDM_URL" >> "$LOG"
        fi
    else
        echo "IDM setup disabled — skipping." >> "$LOG"
    fi
`;
