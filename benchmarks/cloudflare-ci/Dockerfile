FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5

RUN curl --proto '=https' --tlsv1.2 -fsSL https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

RUN mise install node@26.5.0 aube@1.29.1
