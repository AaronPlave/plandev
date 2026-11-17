# F Prime sequencing toolchain for SeqDev (optional service, see ../README.md).
#   .seq → fprime-seqgen (fprime-gds)        .rs → fprime-wasm build + verify, rust-analyzer
# Everything here is pinned; the versions and the local patch are reported in every build's
# provenance. Missions on another fprime-wasm/F Prime release rebuild with different ARGs.
FROM rust:1.100.0-bookworm

ARG FPRIME_WASM_VERSION=0.1.10
ARG BINARYEN_VERSION=version_133
ARG BINARYEN_SHA256_X86_64=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
ARG BINARYEN_SHA256_AARCH64=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-seccomp patch \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32v1-none && rustup component add rust-analyzer rust-src
RUN cargo install --locked fprime-wasm --version "${FPRIME_WASM_VERSION}" && rm -rf /usr/local/cargo/registry

# wasm-opt from binaryen releases: the `wasm-opt` crate (binaryen 116) lacks --enable-custom-page-sizes.
RUN arch=$(uname -m) \
 && sha=$([ "$arch" = x86_64 ] && echo "$BINARYEN_SHA256_X86_64" || echo "$BINARYEN_SHA256_AARCH64") \
 && curl -sSLo /tmp/binaryen.tgz "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-${arch}-linux.tar.gz" \
 && echo "$sha  /tmp/binaryen.tgz" | sha256sum -c - \
 && tar xzf /tmp/binaryen.tgz -C /opt && rm /tmp/binaryen.tgz \
 && ln -s "/opt/binaryen-${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt

# fprime-seqgen and the service's websocket library, at the versions in requirements.txt.
COPY requirements.txt /opt/fprime/requirements.txt
RUN python3 -m venv --system-site-packages /opt/fprime/venv \
 && /opt/fprime/venv/bin/pip install --no-cache-dir -r /opt/fprime/requirements.txt
ENV PATH="/opt/fprime/venv/bin:${PATH}"

# Sequence builds run offline, as unprivileged users, from crates vendored here at image build
# time: the fprime_* crates and their dependencies, read-only. Cargo finds this configuration
# from any project directory (it reads /.cargo/config.toml as an ancestor of every path).
COPY vendor-manifest /opt/fprime/vendor-manifest
COPY fprime_macros-*.patch /opt/fprime/patches/
RUN mkdir -p /.cargo \
 && cd /opt/fprime/vendor-manifest \
 && cargo vendor --locked --versioned-dirs /opt/fprime/vendor > /.cargo/config.toml \
 # Upstream fprime_macros calls `command(..)` unhygienically, so a dictionary command with an
 # argument named `command` (Svc.FileManager.ShellCommand, in every F Prime v4 deployment) fails
 # to compile. Patched copy of the pinned release; see the .patch file and ../README.md.
 && cp -r "/opt/fprime/vendor/fprime_macros-${FPRIME_WASM_VERSION}" /opt/fprime/fprime_macros \
 && rm /opt/fprime/fprime_macros/.cargo-checksum.json \
 && patch -d /opt/fprime/fprime_macros -p1 < "/opt/fprime/patches/fprime_macros-${FPRIME_WASM_VERSION}-command-hygiene.patch" \
 && printf '\n[patch.crates-io]\nfprime_macros = { path = "/opt/fprime/fprime_macros" }\n\n[net]\noffline = true\n' >> /.cargo/config.toml \
 && rm -rf /usr/local/cargo/registry /opt/fprime/vendor-manifest/target \
 && chmod -R a+rX /opt/fprime /.cargo

# Restriction profiles (`#[fprime_main(<profile>)]` reads profile_<profile>.toml from the project).
# fprime-wasm keeps them in its example crate, not in the published crates; new projects get these.
ARG PROFILES_URL=https://raw.githubusercontent.com/fprime-community/fprime-wasm/v${FPRIME_WASM_VERSION}/crates/example
RUN mkdir -p /opt/fprime/profiles && cd /opt/fprime/profiles \
 && for p in restrict:9cb7d1668953648124421e72e48089fa052c01a58597cfdc5556a293d03c1771 \
             recommended:ad6b481f21710ff4d306b4b0957961f8d0a0c469899e0de0d848fca616565d2b \
             reference:0d6c039719646d19013bb96d255d9175ac29a2cbd7f95601001f54fe70a5cac6; do \
      curl -sSfLo "profile_${p%%:*}.toml" "${PROFILES_URL}/profile_${p%%:*}.toml" \
      && echo "${p#*:}  profile_${p%%:*}.toml" | sha256sum -c - ; done \
 && chmod -R a+rX /opt/fprime/profiles

ENV FPRIME_TOOLCHAIN_PATCHES="fprime_macros-${FPRIME_WASM_VERSION}-command-hygiene.patch"
COPY server.py /opt/fprime/server.py
EXPOSE 9257 9258
CMD ["python3", "-u", "/opt/fprime/server.py"]
