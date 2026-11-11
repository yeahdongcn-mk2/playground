# Fixed screenshot capture environment (Issue #199).
#
# The base image is pinned by digest, so every capture uses the same browser
# build, font packages and Mesa stack. The official Playwright image already
# ships the EGL / software-rendering packages and the font packages listed in
# scripts/lib/capture-env.mjs; this file verifies them instead of installing
# anything. Installing extra fonts or system packages here would change text /
# GPU rasterisation and therefore the committed PNG bytes.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f

RUN set -eu; \
    for pkg in libegl1 libegl-mesa0 libgl1 libgl1-mesa-dri libglx-mesa0; do \
      dpkg -s "$pkg" >/dev/null || { echo "missing capture dependency: $pkg" >&2; exit 1; }; \
    done; \
    test -f /usr/share/glvnd/egl_vendor.d/50_mesa.json || { \
      echo "missing EGL vendor library: /usr/share/glvnd/egl_vendor.d/50_mesa.json" >&2; \
      exit 1; \
    }; \
    for pkg in fonts-freefont-ttf fonts-ipafont-gothic fonts-liberation \
      fonts-noto-color-emoji fonts-tlwg-loma-otf fonts-unifont fonts-wqy-zenhei; do \
      dpkg -s "$pkg" >/dev/null || { echo "missing capture font package: $pkg" >&2; exit 1; }; \
    done

# WebKit headless needs a surfaceless EGL display; keep software rendering so
# the same pixels are produced without a GPU.
ENV EGL_PLATFORM=surfaceless
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json

WORKDIR /work
ENTRYPOINT ["node", "scripts/run-container-capture.mjs"]
