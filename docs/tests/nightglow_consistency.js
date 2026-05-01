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

  // ── helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
