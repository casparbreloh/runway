FROM docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG MISE_VERSION=v2026.7.7
ARG MISE_SHA256=0953810c2785eb4a75159f67f8b5721c4f3c80b8a6a812015d5af7d7fbd1b8a4
ARG LIBATOMIC_SHA256=56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462

RUN directory="$(mktemp -d)" \
    && curl --fail --location --retry 3 \
      "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64.tar.gz" \
      --output "${directory}/mise.tar.gz" \
    && echo "${MISE_SHA256}  ${directory}/mise.tar.gz" | sha256sum --check - \
    && tar -xzf "${directory}/mise.tar.gz" -C /usr/local/bin --strip-components=2 mise/bin/mise \
    && chmod 755 /usr/local/bin/mise \
    && curl --fail --location --retry 3 \
      "https://security.ubuntu.com/ubuntu/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb" \
      --output "${directory}/libatomic.deb" \
    && echo "${LIBATOMIC_SHA256}  ${directory}/libatomic.deb" | sha256sum --check - \
    && dpkg-deb --extract "${directory}/libatomic.deb" "${directory}/libatomic" \
    && cp -a "${directory}/libatomic/usr/lib/x86_64-linux-gnu"/libatomic.so.1* /usr/lib/x86_64-linux-gnu/ \
    && rm -rf "${directory}" \
    && mise --version
