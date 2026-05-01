# CreepJS fork — static-asset image with Nightglow consistency-probe extensions.
#
# Base image is openresty (nginx + Lua) instead of plain nginx so the same
# container can serve a `/echo` endpoint that returns the request's headers
# as JSON. The new probe pages under `tests/nightglow_*` fetch that endpoint
# and diff the server-observed headers against what the page-side / worker-side
# JS contexts claim — catching naive UA spoofs that only patch
# `window.navigator` and miss the wire surface (Sec-CH-UA*, Accept-Language)
# or the worker contexts.
#
# Static assets:
#   /                            → docs/index.html (upstream creepjs UI)
#   /nightglow.html              → fork landing page (catalogue + rationale)
#   /tests/nightglow_*.html      → fork-only probes
#
# Dynamic endpoints:
#   /echo                        → JSON of request method, URI, scheme,
#                                  remote_addr, and full request headers
#
# Why openresty over a sidecar: keeps the deployment a single container,
# matches what the existing CreepJS argocd app expects, and lua-cjson is
# bundled so the Lua block is ~15 lines. Image is ~80MB vs ~25MB for plain
# nginx — acceptable for an internal dev/CI fingerprint tool.
FROM openresty/openresty:1.25.3.1-alpine

RUN mkdir -p /usr/share/nginx/html
COPY docs/ /usr/share/nginx/html/
COPY nightglow.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
