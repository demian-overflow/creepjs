# CreepJS™ — Nightglow fork

> **This is a fork.** Canonical: [`gitlab.noogoo.ch/orderout/creepjs`](https://gitlab.noogoo.ch/orderout/creepjs) · Public mirror: [`github.com/demian-overflow/creepjs`](https://github.com/demian-overflow/creepjs) · Upstream: [`abrahamjuliot/creepjs`](https://github.com/abrahamjuliot/creepjs).
>
> The fork adds probes targeted at the [Nightglow](https://gitlab.noogoo.ch/orderout/nightglow) Servo-derived stealth browser. **Read [`docs/nightglow.html`](docs/nightglow.html)** (or visit `/nightglow.html` on the deployed site) for the catalogue and rationale.

## Nightglow extensions (this fork only)

Beyond upstream creepjs:

| Probe | What it catches |
|---|---|
| [`docs/tests/nightglow_consistency.html`](docs/tests/nightglow_consistency.html) | Identity attributes (UA, userAgentData, platform, languages, …) read from page / DedicatedWorker / SharedWorker / ServiceWorker / iframe / server (`/echo`). Diffs across contexts; flags any divergence. Catches naive shims that only patch `window.navigator`. Same page also runs modern-API surface checks (IdleDetector, WebGPU, PressureObserver, CookieStore, ViewTransitions, etc.) and timer/stack-format probes. |
| [`docs/tests/nightglow_shim.html`](docs/tests/nightglow_shim.html) | Servo shim correctness for SharedWorker / Web Locks / ServiceWorkerContainer / MessagePort auto-start. Each leak maps to a D-numbered defect in `nightglow/docs/defects/telegram.md`. |
| `GET /echo` (openresty Lua endpoint) | JSON of request method, URI, scheme, remote_addr, server_addr, and full request headers. Backs the consistency-probe server column. |

The image base is therefore `openresty/openresty:1.25.3.1-alpine` instead
of plain nginx — the Lua block in `nightglow.conf` is what serves `/echo`.

## Build / deploy

```bash
docker build -t registry.noogoo.ch/orderout/creepjs:latest .
docker push registry.noogoo.ch/orderout/creepjs:latest
```

CI does this automatically on push to `main` (see `.gitlab-ci.yml`). The
ArgoCD app `creepjs` in `orderout` namespace pulls `:latest` with
`imagePullPolicy: Always`.

---

## Upstream CreepJS notice

> [!CAUTION]
> **The original upstream's only official live deployment is on GitHub Pages.**
> Any `.org`, `.com`, or custom domain claiming to be the upstream public CreepJS is an **unauthorized mirror** and should be treated as a malicious honeypot designed to steal your fingerprint data. (Internal Nightglow deployment at `creepjs.orderout.svc.cluster.local` is this fork, not the public site.)
>
> * ✅ **Upstream official:** `https://abrahamjuliot.github.io/creepjs`
> * ✅ **This fork (internal):** `creepjs.orderout.svc.cluster.local` and the gitlab/github mirrors above
> * ❌ **Unsafe:** All other URLs.

[https://abrahamjuliot.github.io/creepjs](https://abrahamjuliot.github.io/creepjs)

The purpose of this project is to shed light on weaknesses and privacy leaks among modern anti-fingerprinting extensions and browsers.

1. Detect and ignore JavaScript tampering (prototype lies)
2. Fingerprint lie patterns
3. Fingerprint extension code
4. Fingerprint browser privacy settings
5. Use large-scale validation and collect inconsistencies
6. Feature detect and fingerprint [new APIs](https://www.javascripture.com/) that contain high entropy
7. For fingerprinting, use APIs that are the most difficult to fake

Tests are focused on:

* Tor Browser (SL 1 & 2)
* Firefox (RFP)
* ungoogled-chromium (fingerprint deception)
* Brave Browser (Standard/Strict)
* puppeteer-extra
* FakeBrowser
* Bromite
* uBlock Origin (aopr)
* NoScript
* DuckDuckGo Privacy Essentials
* JShelter (JavaScript Restrictor)
* Privacy Badger
* Privacy Possum
* Random User-Agent
* User Agent Switcher and Manager
* CanvasBlocker
* Trace
* CyDec
* Chameleon
* ScriptSafe
* Windscribe

## Tests

1. contentWindow (Self) object
2. CSS System Styles
3. CSS Computed Styles
4. HTMLElement
5. JS Runtime (Math)
6. JS Engine (Console Errors)
7. Emojis (DomRect)
8. DomRect
9. SVG
10. Audio
11. MimeTypes
12. Canvas (Image, Blob, Paint, Text, Emoji)
13. TextMetrics
14. WebGL
15. GPU Params (WebGL Parameters)
16. GPU Model (WebGL Renderer)
17. Fonts
18. Voices
19. Screen
20. Resistance (Known Patterns)
21. Device of Timezone

## Supported

* layout rendering engines: `Gecko`, `Goanna`, `Blink`, `WebKit`
* JS runtime engines: `SpiderMonkey`, `JavaScriptCore`, `V8`

## Interact with the fingerprint objects

* `window.Fingerprint`
* `window.Creep`

## Develop

Contributions are welcome.

🟫 install `pnpm install`<br>
🟩 build `pnpm build:dev`<br>
🟪 watch `pnpm watch:dev`<br>
🟦 release to GitHub pages `pnpm build`<br>

If you would like to test on a secure connection, GitHub Codespaces is supported. The goal of this project is to conduct research and provide education, not to create a fingerprinting library.

> [!IMPORTANT]
> **LICENSE & TRADEMARK POLICY**
>
> This project is governed by a [Trademark Policy](TRADEMARKS.md).
>
> * **Code:** You are free to fork and modify the code under the MIT License.
> * **Name:** The name "**CreepJS**" is trademarked. You may **not** use it for commercial products or public websites (e.g., `creepjs.org` is strictly prohibited).
>
> Please refrain from hosting public mirrors. To prevent user confusion, distinct public forks **must be renamed**.
