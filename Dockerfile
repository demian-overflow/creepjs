# CreepJS fork — static-asset image.
#
# The original deployment used an init container that did a fresh
# `git clone --depth=1 https://github.com/abrahamjuliot/creepjs.git`
# on every pod start, then served `docs/` over nginx. This:
#   - re-pulls the repo every restart (network + clone time);
#   - serves whatever upstream main happens to be at that moment
#     (non-reproducible — a probe might pass yesterday and fail today);
#   - cannot easily serve our fork commits (`5fe4da3 add Nightglow shim probes`,
#     `08b6b45 add probe for MessagePort addEventListener auto-start`) since
#     they only exist on this fork.
#
# Bundling docs/ into a versioned image fixes all three. The nightglow CI
# pins to a specific image digest, regression detection becomes deterministic,
# and the fork's shim probes are always present.
FROM nginx:1.27-alpine

# Drop nginx's default site and serve creepjs/docs/.
RUN rm -rf /usr/share/nginx/html/*
COPY docs/ /usr/share/nginx/html/

# CORS for fingerprint scripts that fetch sub-resources (creep.js loads
# data/*.json via XHR; some Servo configurations enforce stricter CORS
# than the default install ships).
RUN printf 'add_header Access-Control-Allow-Origin "*" always;\n' \
    > /etc/nginx/conf.d/cors.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
