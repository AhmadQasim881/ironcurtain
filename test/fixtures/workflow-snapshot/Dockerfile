# Snapshot tests execute a deterministic shell driver, never an agent CLI.
FROM node:24.22.3-bookworm-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates sudo socat passwd util-linux procps findutils && \
    rm -rf /var/lib/apt/lists/* && \
    usermod -l codespace -d /home/codespace -m node && \
    groupmod -n codespace node && \
    printf 'codespace ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/codespace && \
    chmod 0440 /etc/sudoers.d/codespace && \
    mkdir -p /workspace /etc/ironcurtain /run/ironcurtain && \
    chown codespace:codespace /workspace /etc/ironcurtain /run/ironcurtain
COPY entrypoint-uid-remap.sh /usr/local/bin/ironcurtain-uid-remap.sh
COPY entrypoint-claude-code.sh /usr/local/bin/entrypoint.sh
RUN chmod 0555 /usr/local/bin/entrypoint.sh
ENV HOME=/home/codespace
WORKDIR /workspace
USER codespace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
