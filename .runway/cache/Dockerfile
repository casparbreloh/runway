FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS cache

RUN npm install --global pnpm@11.5.0

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/runway/package.json packages/runway/package.json

RUN pnpm fetch --frozen-lockfile --trust-lockfile --store-dir /runway/pnpm-store
RUN node --input-type=module --eval 'import { createHash } from "node:crypto"; import { writeFile } from "node:fs/promises"; const response = await fetch("https://security.ubuntu.com/ubuntu/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb"); if (!response.ok) throw new Error(`download returned ${response.status}`); const bytes = new Uint8Array(await response.arrayBuffer()); const digest = createHash("sha256").update(bytes).digest("hex"); if (digest !== "56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462") throw new Error("invalid libatomic1 digest"); await writeFile("/tmp/libatomic1.deb", bytes);'
RUN dpkg-deb --extract /tmp/libatomic1.deb /tmp/libatomic1
RUN mkdir -p /cache-root/usr/local /cache-root/opt/runway/pnpm-store && \
    cp -a /usr/local/. /cache-root/usr/local/ && \
    cp -a /runway/pnpm-store/. /cache-root/opt/runway/pnpm-store/ && \
    cp -a /tmp/libatomic1/usr/lib/x86_64-linux-gnu/libatomic.so.1* /cache-root/usr/local/lib/
RUN mkdir /out && \
    tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
      -cf - -C /cache-root . | gzip -n -9 > /out/runway-ci.tar.gz

FROM scratch
COPY --from=cache /out/runway-ci.tar.gz /
