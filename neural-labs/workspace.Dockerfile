FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    iproute2 \
    less \
    locales \
    openssh-client \
    procps \
    sudo \
    tini \
    util-linux \
  && curl -fsSL https://code-server.dev/install.sh | sh \
  && curl -fsSL https://claude.ai/install.sh | bash \
  && /root/.local/bin/claude --version \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"
RUN printf '%s\n' \
  'case ":$PATH:" in' \
  '  *:/root/.local/bin:*) ;;' \
  '  *) PATH="/root/.local/bin:$PATH" ;;' \
  'esac' \
  'export PATH' \
  > /etc/profile.d/neural-labs-path.sh

RUN mkdir -p /home/neural-labs \
  && chmod 0775 /home/neural-labs

WORKDIR /home/neural-labs
ENV HOME=/home/neural-labs

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["tail", "-f", "/dev/null"]
