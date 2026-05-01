/* Nightglow consistency probes.
 *
 * Collects the same identity surface from five contexts and renders a diff
 * table. The contexts are:
 *
 *   page          — window.navigator on the host page
 *   dedicated     — DedicatedWorker spawned via blob: URL
 *   shared        — SharedWorker via blob: URL (catches D9 — our shim runs
 *                   user code inside DedicatedWorkerGlobalScope, so
 *                   self.constructor.name leaks the real engine)
 *   serviceWorker — best-effort registration (requires secure context;
 *                   marked SKIPPED on http://)
 *   iframe        — same-origin iframe; reads its own navigator and posts
 *                   it back via postMessage
 *   server        — GET /echo, parses headers, derives equivalent JS-side
 *                   attributes from them (e.g. Sec-CH-UA → brand list)
 *
 * The diff table flags any attribute that disagrees across contexts. Naive
 * UA shims that only patch window.navigator show divergence on every
 * worker / iframe / server row immediately. */
(() => {
  'use strict';

  // ── Surface to probe ──────────────────────────────────────────────────
  // Each entry is [label, fn(navigator|undefined) → value]. Functions take
  // the navigator-like object for the context (or `self` for workers); for
  // the server, value is computed from the /echo response in deriveServer().
  const ATTRS = [
    ['userAgent',                n => n.userAgent],
    ['userAgentData.brands',     n => safe(() => n.userAgentData.brands.map(b => `${b.brand};${b.version}`).join(','))],
    ['userAgentData.platform',   n => safe(() => n.userAgentData.platform)],
    ['userAgentData.mobile',     n => safe(() => n.userAgentData.mobile)],
    ['platform',                 n => n.platform],
    ['language',                 n => n.language],
    ['languages',                n => Array.isArray(n.languages) ? n.languages.join(',') : String(n.languages)],
    ['vendor',                   n => n.vendor],
    ['hardwareConcurrency',      n => n.hardwareConcurrency],
    ['deviceMemory',             n => n.deviceMemory],
    ['webdriver',                n => n.webdriver],
    ['constructor.name (self)',  n => n.__selfCtor || '(page)'],
  ];

  function safe(fn) { try { return fn(); } catch (e) { return `<err: ${e.message}>`; } }

  // ── Page context ──────────────────────────────────────────────────────
  const pageNav = pluckNav(navigator);

  // ── Worker probe payload ──────────────────────────────────────────────
  // Same script body for dedicated + shared. Computes navigator surface
  // and posts it back. For shared, listens on connect.
  const workerSrc = `
    function pluck(n) {
      function safe(fn) { try { return fn(); } catch (e) { return '<err: ' + e.message + '>'; } }
      return {
        userAgent: n.userAgent,
        ua_brands: safe(() => n.userAgentData.brands.map(b => b.brand + ';' + b.version).join(',')),
        ua_platform: safe(() => n.userAgentData.platform),
        ua_mobile: safe(() => n.userAgentData.mobile),
        platform: n.platform,
        language: n.language,
        languages: Array.isArray(n.languages) ? n.languages.join(',') : String(n.languages),
        vendor: n.vendor,
        hardwareConcurrency: n.hardwareConcurrency,
        deviceMemory: n.deviceMemory,
        webdriver: n.webdriver,
        selfCtor: self.constructor && self.constructor.name,
      };
    }
    if (typeof SharedWorkerGlobalScope !== 'undefined') {
      // shared worker
      self.addEventListener('connect', e => {
        const port = e.ports[0] || e.source;
        port.onmessage = ev => port.postMessage(pluck(self.navigator));
        port.start && port.start();
      });
    } else {
      // dedicated worker
      self.onmessage = () => self.postMessage(pluck(self.navigator));
    }
  `;
  const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
  const workerUrl  = URL.createObjectURL(workerBlob);

  // ── Collectors ─────────────────────────────────────────────────────────
  function pluckNav(n, opts = {}) {
    const out = {};
    for (const [label, fn] of ATTRS) {
      try { out[label] = fn(n); } catch (e) { out[label] = `<err: ${e.message}>`; }
    }
    if (opts.selfCtor) out['constructor.name (self)'] = opts.selfCtor;
    return out;
  }

  function pluckFromWorkerSnapshot(snap) {
    return {
      'userAgent':                snap.userAgent,
      'userAgentData.brands':     snap.ua_brands,
      'userAgentData.platform':   snap.ua_platform,
      'userAgentData.mobile':     snap.ua_mobile,
      'platform':                 snap.platform,
      'language':                 snap.language,
      'languages':                snap.languages,
      'vendor':                   snap.vendor,
      'hardwareConcurrency':      snap.hardwareConcurrency,
      'deviceMemory':             snap.deviceMemory,
      'webdriver':                snap.webdriver,
      'constructor.name (self)':  snap.selfCtor,
    };
  }

  function probeDedicated() {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerUrl);
      const t = setTimeout(() => { w.terminate(); reject(new Error('dedicated worker timeout')); }, 5000);
      w.onmessage = e => { clearTimeout(t); w.terminate(); resolve(pluckFromWorkerSnapshot(e.data)); };
      w.onerror   = e => { clearTimeout(t); w.terminate(); reject(new Error(`dedicated worker error: ${e.message || e}`)); };
      w.postMessage('go');
    });
  }

  function probeShared() {
    return new Promise((resolve, reject) => {
      let sw;
      try { sw = new SharedWorker(workerUrl); }
      catch (e) { reject(new Error(`SharedWorker constructor threw: ${e.message}`)); return; }
      const t = setTimeout(() => reject(new Error('shared worker timeout (connect or message never arrived)')), 5000);
      sw.port.onmessage = e => { clearTimeout(t); resolve(pluckFromWorkerSnapshot(e.data)); };
      sw.port.start && sw.port.start();
      sw.port.postMessage('go');
    });
  }

  function probeServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      return Promise.resolve({ __skipped: 'requires secure context (HTTPS/localhost). Cluster service is HTTP.' });
    }
    // Register a tiny SW served from a blob URL (same-origin).
    // Some browsers reject blob: SW scripts; treat that as skip.
    const swSrc = `
      self.addEventListener('message', e => {
        function safe(fn) { try { return fn(); } catch (err) { return '<err: ' + err.message + '>'; } }
        e.source && e.source.postMessage({
          userAgent: navigator.userAgent,
          ua_brands: safe(() => navigator.userAgentData.brands.map(b => b.brand + ';' + b.version).join(',')),
          ua_platform: safe(() => navigator.userAgentData.platform),
          ua_mobile: safe(() => navigator.userAgentData.mobile),
          platform: navigator.platform,
          language: navigator.language,
          languages: Array.isArray(navigator.languages) ? navigator.languages.join(',') : String(navigator.languages),
          vendor: navigator.vendor,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          webdriver: navigator.webdriver,
          selfCtor: self.constructor && self.constructor.name,
        });
      });
    `;
    const url = URL.createObjectURL(new Blob([swSrc], { type: 'application/javascript' }));
    return navigator.serviceWorker.register(url).then(reg => {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { reg.unregister().catch(() => {}); reject(new Error('SW message timeout')); }, 5000);
        navigator.serviceWorker.addEventListener('message', e => {
          clearTimeout(t);
          reg.unregister().catch(() => {});
          resolve(pluckFromWorkerSnapshot(e.data));
        }, { once: true });
        const sw = reg.installing || reg.waiting || reg.active;
        if (sw) sw.postMessage('go');
        else navigator.serviceWorker.ready.then(r => r.active && r.active.postMessage('go'));
      });
    }).catch(e => ({ __skipped: `SW register failed: ${e.message}` }));
  }

  function probeIframe() {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      // Use srcdoc — self-contained, same-origin by default
      iframe.srcdoc = `<!doctype html><html><body><script>
        function safe(fn) { try { return fn(); } catch (e) { return '<err: ' + e.message + '>'; } }
        parent.postMessage({__nightglowProbe: true, snap: {
          userAgent: navigator.userAgent,
          ua_brands: safe(() => navigator.userAgentData.brands.map(b => b.brand + ';' + b.version).join(',')),
          ua_platform: safe(() => navigator.userAgentData.platform),
          ua_mobile: safe(() => navigator.userAgentData.mobile),
          platform: navigator.platform,
          language: navigator.language,
          languages: Array.isArray(navigator.languages) ? navigator.languages.join(',') : String(navigator.languages),
          vendor: navigator.vendor,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          webdriver: navigator.webdriver,
          selfCtor: '(iframe-window)',
        }}, '*');
      <\/script></body></html>`;
      const t = setTimeout(() => {
        iframe.remove();
        reject(new Error('iframe probe timeout'));
      }, 5000);
      function handler(ev) {
        if (!ev.data || !ev.data.__nightglowProbe) return;
        clearTimeout(t);
        window.removeEventListener('message', handler);
        iframe.remove();
        resolve(pluckFromWorkerSnapshot(ev.data.snap));
      }
      window.addEventListener('message', handler);
      document.body.appendChild(iframe);
    });
  }

  function probeServer() {
    return fetch('/echo', { credentials: 'omit' })
      .then(r => r.json())
      .then(d => deriveServer(d))
      .catch(e => ({ __skipped: `/echo fetch failed: ${e.message}` }));
  }

  // Map the request headers the server saw → the JS-side attributes we
  // know how to compare. Anything we can't derive is null (which renders
  // as "—" and doesn't count as a leak).
  function deriveServer(echo) {
    const h = echo.headers || {};
    const get = name => {
      const v = h[name.toLowerCase()];
      if (Array.isArray(v)) return v.join(', ');
      return v;
    };
    // Sec-CH-UA reads as: '"Chromium";v="124", "Google Chrome";v="124", ...'
    // Convert to comma-joined "brand;version" matching the JS-side format.
    function parseChUa(raw) {
      if (!raw) return null;
      // Each entry: "Name";v="Version"
      const out = [];
      const re = /"([^"]+)";v="([^"]+)"/g;
      let m;
      while ((m = re.exec(raw)) !== null) out.push(`${m[1]};${m[2]}`);
      return out.length ? out.join(',') : raw;
    }
    function parseChPlatform(raw) {
      if (!raw) return null;
      const m = raw.match(/^"(.+)"$/);
      return m ? m[1] : raw;
    }
    function parseChMobile(raw) {
      if (!raw) return null;
      return raw === '?1' ? true : raw === '?0' ? false : raw;
    }
    return {
      'userAgent':               get('user-agent'),
      'userAgentData.brands':    parseChUa(get('sec-ch-ua')),
      'userAgentData.platform':  parseChPlatform(get('sec-ch-ua-platform')),
      'userAgentData.mobile':    parseChMobile(get('sec-ch-ua-mobile')),
      'platform':                null,
      'language':                (get('accept-language') || '').split(',')[0].split(';')[0].trim() || null,
      'languages':               null,
      'vendor':                  null,
      'hardwareConcurrency':     null,
      'deviceMemory':            null,
      'webdriver':               null,
      'constructor.name (self)': null,
    };
  }

  // ── Run all probes in parallel ────────────────────────────────────────
  const contexts = ['page', 'dedicated', 'shared', 'serviceWorker', 'iframe', 'server'];
  Promise.all([
    Promise.resolve(pageNav),
    probeDedicated().catch(e => ({ __skipped: e.message })),
    probeShared().catch(e => ({ __skipped: e.message })),
    probeServiceWorker(),
    probeIframe().catch(e => ({ __skipped: e.message })),
    probeServer(),
  ]).then(results => {
    const data = {};
    contexts.forEach((c, i) => data[c] = results[i]);
    render(data);
    runModernApiProbes();
    runTimingProbes();
    runTLSProbe(data);
    document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
  });

  function render(data) {
    // Build header
    let html = '<table><thead><tr><th>attribute</th>';
    for (const c of contexts) html += `<th>${c}</th>`;
    html += '</tr></thead><tbody>';

    let leakCount = 0;
    let totalChecked = 0;

    for (const [attr] of ATTRS) {
      html += `<tr><td class="attr">${attr}</td>`;
      // Collect values per context that are NOT skipped, NOT null
      const values = {};
      for (const c of contexts) {
        const v = data[c];
        if (!v || v.__skipped !== undefined) continue;
        if (v[attr] === undefined || v[attr] === null) continue;
        values[c] = v[attr];
      }
      // Find consensus (most common value)
      const counts = {};
      for (const v of Object.values(values)) {
        const k = JSON.stringify(v);
        counts[k] = (counts[k] || 0) + 1;
      }
      const consensusKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      const hasDivergence = Object.keys(counts).length > 1;

      if (Object.keys(values).length >= 2) totalChecked++;
      if (hasDivergence) leakCount++;

      for (const c of contexts) {
        const v = data[c];
        if (!v) { html += '<td class="skip">—</td>'; continue; }
        if (v.__skipped !== undefined) {
          html += `<td class="skip" title="${escapeAttr(v.__skipped)}">SKIP</td>`;
          continue;
        }
        if (v[attr] === undefined || v[attr] === null) {
          html += '<td class="skip">—</td>';
          continue;
        }
        const cls = (Object.keys(values).length >= 2 && JSON.stringify(v[attr]) !== consensusKey) ? 'leak' : 'ok';
        html += `<td class="${cls}">${escapeHtml(String(v[attr]))}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('results').innerHTML = html;

    const summary = document.getElementById('summary');
    if (leakCount === 0) {
      summary.className = 'summary allok';
      summary.innerHTML = `<strong>✓ no consistency leaks across ${totalChecked} attributes that had ≥2 contexts to compare.</strong>`;
    } else {
      summary.className = 'summary leak';
      summary.innerHTML = `<strong>✗ ${leakCount} attribute${leakCount === 1 ? '' : 's'} disagree across contexts.</strong> Each red cell below diverges from the cross-context consensus. A naive UA spoof typically fires the userAgent/userAgentData/platform/language rows on the worker and server columns.`;
    }
  }

  // ── Modern Chrome API surface ─────────────────────────────────────────
  function runModernApiProbes() {
    const checks = [
      ['IdleDetector',                            () => typeof window.IdleDetector === 'function'],
      ['CookieStore',                             () => typeof window.CookieStore !== 'undefined' || typeof window.cookieStore !== 'undefined'],
      ['navigator.gpu (WebGPU)',                  () => !!navigator.gpu],
      ['navigator.gpu.requestAdapter resolves',   async () => {
        if (!navigator.gpu) return 'no navigator.gpu';
        try { const a = await navigator.gpu.requestAdapter(); return a ? true : 'requestAdapter resolved null'; }
        catch (e) { return `threw: ${e.message}`; }
      }],
      ['ViewTransition API',                      () => typeof document.startViewTransition === 'function'],
      ['PressureObserver',                        () => typeof window.PressureObserver === 'function'],
      ['navigator.connection',                    () => typeof navigator.connection !== 'undefined'],
      ['navigator.connection.effectiveType',      () => navigator.connection ? navigator.connection.effectiveType : 'no connection'],
      ['navigator.storage.estimate()',            async () => {
        if (!navigator.storage || !navigator.storage.estimate) return 'no storage.estimate';
        try { const e = await navigator.storage.estimate(); return `quota=${e.quota}, usage=${e.usage}`; }
        catch (e) { return `threw: ${e.message}`; }
      }],
      ['Notification.permission',                 () => typeof Notification !== 'undefined' ? Notification.permission : 'no Notification'],
      ['permissions.query({notifications}).state', async () => {
        if (!navigator.permissions) return 'no permissions';
        try { const p = await navigator.permissions.query({ name: 'notifications' }); return p.state; }
        catch (e) { return `threw: ${e.message}`; }
      }],
      ['userAgentData.getHighEntropyValues full', async () => {
        if (!navigator.userAgentData) return 'no userAgentData';
        try {
          const d = await navigator.userAgentData.getHighEntropyValues(
            ['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64']);
          const have = Object.keys(d).sort().join(',');
          return have;
        } catch (e) { return `threw: ${e.message}`; }
      }],
      ['Battery API removed (should be missing)', () => {
        // Chrome 103+ removed navigator.getBattery for security. Presence is a tell.
        return typeof navigator.getBattery === 'undefined' ? 'absent (correct)' : 'PRESENT (legacy, suspicious)';
      }],
      ['Automation framework leaks',              () => {
        const leaks = [];
        for (const k of ['callPhantom', '_phantom', '__nightmare', 'Cypress', '__driver_evaluate', '__webdriver_script_fn']) {
          if (typeof window[k] !== 'undefined') leaks.push(k);
        }
        for (const k of Object.keys(window)) {
          if (k.startsWith('cdc_')) leaks.push(k);
        }
        return leaks.length ? `LEAKS: ${leaks.join(', ')}` : 'none detected';
      }],
    ];

    const container = document.getElementById('modern-apis');
    let html = '<table><thead><tr><th>API</th><th>result</th></tr></thead><tbody>';
    container.innerHTML = html + '<tr><td colspan="2" class="skip">running…</td></tr></tbody></table>';

    Promise.all(checks.map(async ([label, fn]) => {
      try { return [label, await fn()]; }
      catch (e) { return [label, `threw: ${e.message}`]; }
    })).then(results => {
      let body = '';
      for (const [label, result] of results) {
        const isAbsent = result === false || (typeof result === 'string' && /^no |absent|not detected|none/.test(result));
        const isLeak   = typeof result === 'string' && /LEAK|PRESENT \(legacy/.test(result);
        const cls = isLeak ? 'leak' : (result === true || (typeof result === 'string' && !isAbsent && !result.startsWith('threw:')) ? 'ok' : 'skip');
        body += `<tr><td class="attr">${escapeHtml(label)}</td><td class="${cls}">${escapeHtml(String(result))}</td></tr>`;
      }
      container.innerHTML = '<table><thead><tr><th>API</th><th>result</th></tr></thead><tbody>' + body + '</tbody></table>';
    });
  }

  // ── Timer precision + async stack format ──────────────────────────────
  function runTimingProbes() {
    const samples = 1000;
    const diffs = [];
    let prev = performance.now();
    for (let i = 0; i < samples; i++) {
      const now = performance.now();
      if (now > prev) diffs.push(now - prev);
      prev = now;
    }
    const minDiff = diffs.length ? Math.min(...diffs) : null;
    const granularity = minDiff !== null ? `~${minDiff.toFixed(4)}ms (min observed delta)` : 'no deltas observed';
    // Chrome cross-origin isolation rounds to 100µs (0.1ms). Sub-µs precision = leak.
    const precisionLeak = minDiff !== null && minDiff < 0.001;

    // Async stack format
    let asyncStack = '(failed)';
    let stackFormat = 'unknown';
    (async function captureStack() {
      try {
        await Promise.reject(new Error('nightglow-probe'));
      } catch (e) {
        asyncStack = e.stack || '(no stack)';
        if (asyncStack.includes('at async ')) stackFormat = 'Chrome-style (has "at async ")';
        else if (asyncStack.includes('@')) stackFormat = 'Firefox/SpiderMonkey-style (has "@")';
        else stackFormat = 'unrecognised';
      }
      const container = document.getElementById('timing');
      container.innerHTML = `<table><tbody>
        <tr><td class="attr">performance.now() granularity</td>
            <td class="${precisionLeak ? 'leak' : 'ok'}">${escapeHtml(granularity)}${precisionLeak ? ' — LEAK: sub-µs precision suggests no clock-clamp protection' : ''}</td></tr>
        <tr><td class="attr">async stack format</td>
            <td class="${stackFormat.startsWith('Chrome-style') ? 'ok' : 'leak'}">${escapeHtml(stackFormat)}</td></tr>
        <tr><td class="attr">async stack (sample)</td>
            <td><pre>${escapeHtml(asyncStack.split('\\n').slice(0, 4).join('\\n'))}</pre></td></tr>
      </tbody></table>`;
    })();
  }

  // ── Wire-level TLS ClientHello (via tlsprobe) ─────────────────────────
  //
  // tlsprobe is a Go binary listening on tlsprobe.orderout.noogoo.ch:8443
  // that peeks the TLS ClientHello before handshake and returns the parsed
  // shape + JA3 + JA4 as JSON. We fetch it cross-origin (CORS allowed),
  // then diff each notable field against a Chrome 124 baseline. The
  // baseline is captured live from a real Chrome 124 by visiting the
  // tlsprobe URL directly — see docs/nightglow.html for instructions.
  // We embed the baseline inline so the page works fully offline.
  const TLS_PROBE_URL = 'https://tlsprobe.orderout.noogoo.ch:8443/';
  // Keys here are NOT exact-match — they describe what a Chrome 124
  // ClientHello looks like in shape. Per-connection variation (GREASE
  // values, exact key_share keys) is masked by comparing the no-grease
  // hashes and by checking presence rather than equality on volatile fields.
  const CHROME124_BASELINE = {
    has_grease:                true,    // Chrome inserts GREASE on every connection
    expects_x25519_in_groups:  true,    // ID 29
    expects_p256_in_groups:    true,    // ID 23
    forbids_mlkem768_group:    true,    // ID 4588 — rustls-only marker
    expects_h2_alpn:           true,
    expects_grease_in_groups:  true,    // Chrome puts a GREASE value first in supported_groups
    expects_grease_in_versions:true,    // and in supported_versions
    min_extensions_count:      14,      // Chrome ships at least 14 extensions; bare rustls ships 11
    expects_extensions: [
      0,     // server_name
      5,     // status_request
      10,    // supported_groups
      11,    // ec_point_formats
      13,    // signature_algorithms
      16,    // ALPN
      18,    // signed_certificate_timestamp
      23,    // extended_master_secret
      27,    // compress_certificate
      35,    // session_ticket
      43,    // supported_versions
      45,    // psk_key_exchange_modes
      51,    // key_share
      17513, // application_settings (Chrome-specific)
      65281, // renegotiation_info
    ],
    expects_supported_versions_includes_tls13: true,
  };

  function runTLSProbe(diffData) {
    const container = document.getElementById('tls');
    container.innerHTML = '<p class="skip">fetching tlsprobe…</p>';
    fetch(TLS_PROBE_URL, { credentials: 'omit', cache: 'no-store' })
      .then(r => r.json())
      .then(d => renderTLS(d, diffData))
      .catch(e => {
        container.innerHTML = `<p class="skip">tlsprobe unreachable: ${escapeHtml(e.message)}.
          The service lives at <code>${TLS_PROBE_URL}</code>; if you're driving Nightglow
          inside the cluster make sure it can reach the LoadBalancer node IP on port 8443.</p>`;
      });
  }

  function renderTLS(d, diffData) {
    const ch = d.client_hello || {};
    const ja3 = d.ja3 || {};
    const ja4 = d.ja4 || {};
    const rows = [];

    function row(label, value, status, note) {
      rows.push({ label, value, status, note });
    }

    if (d.error) {
      document.getElementById('tls').innerHTML =
        `<p class="leak">tlsprobe returned: ${escapeHtml(d.error)}</p>`;
      return;
    }

    row('JA3 hash (raw, with GREASE)',  ja3.hash, 'info',
        'Per-connection unstable on real Chrome — GREASE rotates every connection');
    row('JA3 hash (no GREASE)',         ja3.hash_no_grease, 'info',
        'Stable across connections; compare against published Chrome 124 baselines');
    row('JA4',                          ja4.string, 'info',
        'FoxIO format. Cipher list sorted before hashing → version-stable');

    // Has GREASE check
    {
      const have = !!ch.has_grease;
      row('GREASE values present',      have ? 'yes' : 'no',
          have === CHROME124_BASELINE.has_grease ? 'ok' : 'leak',
          have ? '' : 'LEAK: real Chrome inserts GREASE in cipher/extension/group lists. Absence ⇒ rustls/non-Chrome TLS stack');
    }

    // Cipher count
    {
      const n = (ch.cipher_suites_no_grease || []).length;
      row('Cipher suite count (no GREASE)', String(n), n >= 8 ? 'ok' : 'leak',
          n >= 8 ? '' : `Chrome 124 ships ~14-17 ciphers; ${n} is low — possibly minimalist rustls`);
    }

    // Supported groups: must include X25519 (29) + P-256 (23). Must NOT include MLKEM768 (4588) on Chrome.
    {
      const groups = ch.supported_groups || [];
      const hasX25519 = groups.includes(29);
      const hasP256   = groups.includes(23);
      const hasMLKEM  = groups.includes(4588);
      row('supported_groups: X25519 (29)',     hasX25519 ? 'present' : 'absent', hasX25519 ? 'ok' : 'leak',
          hasX25519 ? '' : 'LEAK: Chrome 124 always offers X25519');
      row('supported_groups: P-256 (23)',      hasP256 ? 'present' : 'absent', hasP256 ? 'ok' : 'leak',
          hasP256 ? '' : 'LEAK: Chrome 124 always offers P-256');
      row('supported_groups: X25519MLKEM768 (4588)', hasMLKEM ? 'PRESENT' : 'absent', hasMLKEM ? 'leak' : 'ok',
          hasMLKEM ? 'LEAK: rustls-specific PQC group. Chrome uses X25519Kyber768Draft00 (different codepoint). Strong rustls fingerprint tell.' : '');
    }

    // ALPN
    {
      const alpn = ch.alpn || [];
      const hasH2 = alpn.includes('h2');
      row('ALPN protocols',              alpn.join(',') || '(none)', hasH2 ? 'ok' : 'leak',
          hasH2 ? '' : 'LEAK: Chrome offers h2 in ALPN');
    }

    // Extension count + presence of Chrome-specific extensions
    {
      const extsNoGrease = ch.extensions_no_grease || [];
      const n = extsNoGrease.length;
      row('Extension count (no GREASE)', String(n), n >= CHROME124_BASELINE.min_extensions_count ? 'ok' : 'leak',
          n >= CHROME124_BASELINE.min_extensions_count ? '' : `Chrome 124 ships ≥${CHROME124_BASELINE.min_extensions_count}; ${n} is low — TLS stack is minimalist rustls`);

      const missing = CHROME124_BASELINE.expects_extensions.filter(e => !extsNoGrease.includes(e));
      const has17513 = extsNoGrease.includes(17513);
      row('Extension 17513 (application_settings)', has17513 ? 'present' : 'absent', has17513 ? 'ok' : 'leak',
          has17513 ? '' : 'LEAK: Chrome-specific. Its absence + matching UA = rustls signature');
      const has27 = extsNoGrease.includes(27);
      row('Extension 27 (compress_certificate)', has27 ? 'present' : 'absent', has27 ? 'ok' : 'leak',
          has27 ? '' : 'LEAK: Chrome 124 ships compress_certificate');
      if (missing.length > 0) {
        row('Other expected extensions missing', missing.join(', '), 'leak',
            'Chrome 124 ships these by default; absence narrows TLS-stack identity');
      }
    }

    // GREASE-in-groups + GREASE-in-versions positional check
    {
      const sg = ch.supported_groups || [];
      const hasGreaseInGroups = sg.some(g => isGreaseValue(g));
      row('GREASE in supported_groups', hasGreaseInGroups ? 'yes' : 'no',
          hasGreaseInGroups === CHROME124_BASELINE.expects_grease_in_groups ? 'ok' : 'leak',
          hasGreaseInGroups ? '' : 'LEAK: Chrome inserts a GREASE value (e.g. 0x?A?A) at the head of supported_groups');
      const sv = ch.supported_versions || [];
      const hasGreaseInVersions = sv.some(v => isGreaseValue(v));
      row('GREASE in supported_versions', hasGreaseInVersions ? 'yes' : 'no',
          hasGreaseInVersions === CHROME124_BASELINE.expects_grease_in_versions ? 'ok' : 'leak',
          hasGreaseInVersions ? '' : 'LEAK: Chrome inserts GREASE in supported_versions');
    }

    // TLS version
    {
      const sv = ch.supported_versions || [];
      const hasTLS13 = sv.includes(0x0304);
      row('supported_versions includes TLS 1.3 (0x0304)', hasTLS13 ? 'yes' : 'no', hasTLS13 ? 'ok' : 'leak');
    }

    // Render
    let html = '<table><thead><tr><th>check</th><th>value</th><th>note</th></tr></thead><tbody>';
    for (const r of rows) {
      const cls = r.status === 'leak' ? 'leak' : (r.status === 'ok' ? 'ok' : 'skip');
      html += `<tr><td class="attr">${escapeHtml(r.label)}</td>`
           +  `<td class="${cls}">${escapeHtml(String(r.value || ''))}</td>`
           +  `<td>${escapeHtml(r.note || '')}</td></tr>`;
    }
    html += '</tbody></table>';
    html += `<details><summary>Full tlsprobe response</summary><pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>`;
    document.getElementById('tls').innerHTML = html;

    // also stash on diffData so the raw dump at the bottom of the page includes TLS
    diffData.__tlsprobe = d;
  }

  function isGreaseValue(v) {
    // RFC 8701: GREASE values are 0x?A?A pattern, e.g. 0x0A0A, 0x1A1A, ..., 0xFAFA
    if (typeof v !== 'number') return false;
    return (v & 0x0F0F) === 0x0A0A;
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
