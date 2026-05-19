/**
 * Shell script fragment – conditional ILM container setup.
 *
 * Relies on the following bash variables set by the calling script:
 *   $SETUP_ILM, $ILM_VERSION, $ILM_FULL_VERSION, $ILM_COMPOSE_URL, $LOG
 *
 * Skips silently when SETUP_ILM != "true".
 */
export const ILM_SETUP_SCRIPT = `
    # ── ILM setup ────────────────────────────────────────────────────────────
    if [ "$SETUP_ILM" = "true" ]; then
        echo "Starting ILM setup (Version: $ILM_VERSION)..." >> "$LOG"

        # Detect docker compose command (v2 plugin vs v1 standalone)
        if docker compose version >/dev/null 2>&1; then
            ILM_DC="docker compose"
        elif command -v docker-compose >/dev/null 2>&1; then
            ILM_DC="docker-compose"
        else
            ILM_DC="docker compose"
        fi
        echo "Using compose command: $ILM_DC" >> "$LOG"

        command -v hostnamectl >/dev/null 2>&1 && hostnamectl set-hostname lab
        grep -q "127.0.0.1 lab" /etc/hosts || echo "127.0.0.1 lab" >> /etc/hosts

        DOWNLOAD_DIR="/root/Documents"
        mkdir -p "$DOWNLOAD_DIR"
        unset http_proxy https_proxy

        echo "Downloading ILM compose from $ILM_COMPOSE_URL..." >> "$LOG"
        ILM_DOWNLOAD_OK=false
        if command -v wget >/dev/null 2>&1; then
            wget --timeout=20 --tries=3 --no-proxy --no-check-certificate \\
                 -O "$DOWNLOAD_DIR/compose.zip" "$ILM_COMPOSE_URL" >> "$LOG" 2>&1 \\
                 && ILM_DOWNLOAD_OK=true
        fi
        if [ "$ILM_DOWNLOAD_OK" = "false" ]; then
            curl -fsSL --retry 3 --connect-timeout 20 --insecure \\
                 -o "$DOWNLOAD_DIR/compose.zip" "$ILM_COMPOSE_URL" >> "$LOG" 2>&1 \\
                 && ILM_DOWNLOAD_OK=true
        fi

        if [ "$ILM_DOWNLOAD_OK" = "true" ]; then

            unzip -o "$DOWNLOAD_DIR/compose.zip" -d "$DOWNLOAD_DIR" >> "$LOG" 2>&1

            WORK_DIR="$DOWNLOAD_DIR/ilm"
            [ ! -d "$WORK_DIR" ] && WORK_DIR="$DOWNLOAD_DIR/compose-$ILM_FULL_VERSION"

            if [ -d "$WORK_DIR" ]; then
                cd "$WORK_DIR"

                if [ -f .env ]; then
                    if [ -f /root/uploaded.env ]; then
                        cp /root/uploaded.env .env
                        echo ".env replaced from upload." >> "$LOG"
                    else
                        sed -i "s|TENANT_OSP_REDIRECT_URL=.*|TENANT_OSP_REDIRECT_URL=http://lab:9888/ilm/|g" .env
                        sed -i "s|CALLBACK_SERVER=.*|CALLBACK_SERVER=http://lab:9990|g"                       .env
                        sed -i "s|SECRETS_URL=.*|SECRETS_URL=http://lab:4566|g"                               .env
                        echo ".env defaults applied." >> "$LOG"
                    fi
                else
                    echo "ERROR: .env not found in $WORK_DIR" >> "$LOG"
                fi

                echo "Pulling Docker images (up to 3 attempts)..." >> "$LOG"
                for i in $(seq 1 3); do
                    timeout 600 $ILM_DC pull --ignore-pull-failures >> "$LOG" 2>&1 && break
                    echo "Pull attempt $i failed. Retrying in 10s..." >> "$LOG"; sleep 10
                done

                echo "Starting containers (up to 3 attempts)..." >> "$LOG"
                for i in $(seq 1 3); do
                    $ILM_DC up -d >> "$LOG" 2>&1 && break
                    echo "Start retry $i..." >> "$LOG"; sleep 15
                done

                sleep 10
                if [ "$(docker ps -q | wc -l)" -gt 0 ]; then
                    echo "SUCCESS: ILM containers are running." >> "$LOG"
                    docker ps --format "table {{.Names}}\t{{.Status}}" >> "$LOG"
                else
                    echo "WARNING: No containers running. Check: $ILM_DC logs" >> "$LOG"
                fi

                echo "ILM setup complete." >> "$LOG"
            else
                echo "ERROR: ILM directory not found after extraction." >> "$LOG"
                ls -la "$DOWNLOAD_DIR" >> "$LOG"
            fi
        else
            echo "ERROR: Failed to download ILM zip from $ILM_COMPOSE_URL" >> "$LOG"
        fi
    else
        echo "ILM setup disabled — skipping." >> "$LOG"
    fi
`;
