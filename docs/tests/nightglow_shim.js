// Nightglow shim probes — fork of CreepJS test set.
//
// We exercise the surfaces Nightglow's SharedWorker / navigator.locks /
// ServiceWorkerContainer shims influence and report leaks (places where
// the shim diverges from real-browser observable behaviour). The goal is
// not to score the browser but to give us a stable harness that catches
// regressions whenever we change a shim.
//
// Each probe returns:
//   { name, verdict: 'ok' | 'leak' | 'unknown', actual, expected, note }
// Verdicts:
//   ok      — matches what a real Chrome reports
//   leak    — diverges in a way fingerprint scripts can detect
//   unknown — we couldn't measure it (timeout, async failure)

(async function () {
  const out = document.getElementById('results');
  const summary = document.getElementById('summary');
  const results = [];

  function row(r) {
    const div = document.createElement('div');
    div.className = 'row ' + r.verdict;
    div.innerHTML =
      '<div>' + escape(r.name) + '</div>' +
      '<div>' + r.verdict + '</div>' +
      '<div><pre>actual: ' + escape(JSON.stringify(r.actual)) + '\n' +
      'expected: ' + escape(r.expected) + '\n' +
      (r.note ? 'note: ' + escape(r.note) : '') + '</pre></div>';
    out.appendChild(div);
    results.push(r);
  }

  function escape(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function makeWorkerSrcDataURL(scriptText) {
    return 'data:application/javascript;base64,' + btoa(scriptText);
  }

  // ---------- Probe 1: SharedWorker.port basics on main side ----------
  row({
    name: 'main: typeof SharedWorker',
    verdict: typeof SharedWorker === 'function' ? 'ok' : 'leak',
    actual: typeof SharedWorker,
    expected: 'function',
    note: typeof SharedWorker === 'function' ? '' :
      'Real Chrome exposes SharedWorker as a constructor. Servo upstream had a stub object — the Nightglow fix should make this "function".',
  });

  // ---------- Probe 2: SharedWorker connect event source / ports ----------
  // Apps like Telegram K read `e.source`, not `e.ports[0]`. Both must reference
  // the new MessagePort. Our shim historically only set `ports`.
  await new Promise(function (resolve) {
    var swSrc = ' \
      self.addEventListener("connect", function (e) { \
        var s = e.source, p = (e.ports && e.ports[0]) || null; \
        var same = !!(s && p && (s === p)); \
        var src = s; \
        if (!src) { /* nothing to talk on */ return; } \
        src.onmessage = function (m) { src.postMessage({recv: m.data, source_eq_ports0: same}); }; \
        src.postMessage({phase: "connected", source_eq_ports0: same, source_typeof: typeof s, ports_len: e.ports ? e.ports.length : -1}); \
      });';
    var sw;
    try {
      sw = new SharedWorker(makeWorkerSrcDataURL(swSrc));
    } catch (e) {
      row({
        name: 'sw: connect.source === ports[0]',
        verdict: 'leak',
        actual: 'constructor threw: ' + e,
        expected: 'connect event with source identical to ports[0]',
      });
      resolve();
      return;
    }
    var msgs = [];
    var done = false;
    sw.port.onmessage = function (e) {
      msgs.push(e.data);
      if (msgs.length === 1) {
        sw.port.postMessage({ ping: 1 });
      } else if (msgs.length >= 2) {
        finish(true);
      }
    };
    sw.port.start && sw.port.start();
    setTimeout(function () { finish(false); }, 4000);
    function finish(ok) {
      if (done) return; done = true;
      var first = msgs[0] || {};
      row({
        name: 'sw: connect.source === ports[0]',
        verdict: first.source_eq_ports0 ? 'ok' : (msgs.length === 0 ? 'unknown' : 'leak'),
        actual: first.source_eq_ports0,
        expected: 'true',
        note: 'Telegram K binds to e.source. If false, the shim is missing source initialization on the synthetic connect MessageEvent.',
      });
      row({
        name: 'sw: connect listener fires',
        verdict: msgs.length >= 1 ? 'ok' : 'leak',
        actual: { msgs: msgs.length },
        expected: 'connect handler invoked at least once',
        note: msgs.length === 0 ? 'No connect event observed within 4s — apps that gate on typeof SharedWorkerGlobalScope may have skipped registering the listener.' : '',
      });
      row({
        name: 'sw: round-trip postMessage',
        verdict: msgs.length >= 2 ? 'ok' : 'leak',
        actual: { msgs: msgs.length, second: msgs[1] || null },
        expected: 'second message echoes the ping',
      });
      resolve();
    }
  });

  // ---------- Probe 3: SharedWorkerGlobalScope visibility inside worker ----------
  await new Promise(function (resolve) {
    var probeSrc = ' \
      self.addEventListener("connect", function (e) { \
        var port = e.source || (e.ports && e.ports[0]); \
        if (!port) return; \
        var info = { \
          typeof_swgs: typeof SharedWorkerGlobalScope, \
          self_is_swgs: false, \
          self_constructor_name: (self.constructor && self.constructor.name) || null, \
          location_protocol: self.location && self.location.protocol, \
        }; \
        try { info.self_is_swgs = self instanceof SharedWorkerGlobalScope; } catch (_) {} \
        port.postMessage(info); \
      });';
    var sw;
    try {
      sw = new SharedWorker(makeWorkerSrcDataURL(probeSrc));
    } catch (e) { resolve(); return; }
    var done = false;
    sw.port.onmessage = function (e) {
      if (done) return; done = true;
      var d = e.data || {};
      row({
        name: 'sw: typeof SharedWorkerGlobalScope',
        verdict: d.typeof_swgs === 'function' ? 'ok' : 'leak',
        actual: d.typeof_swgs,
        expected: '"function"',
        note: 'Telegram K gates "addEventListener(\\"connect\\")" on this typeof check. If undefined, the connect listener is never registered.',
      });
      row({
        name: 'sw: self instanceof SharedWorkerGlobalScope',
        verdict: d.self_is_swgs ? 'ok' : 'leak',
        actual: d.self_is_swgs,
        expected: 'true',
      });
      row({
        name: 'sw: self.constructor.name',
        verdict: d.self_constructor_name === 'SharedWorkerGlobalScope' ? 'ok' : 'leak',
        actual: d.self_constructor_name,
        expected: '"SharedWorkerGlobalScope"',
        note: 'Documented Option A gap: our shim is a DedicatedWorker behind the scenes. Apps that read constructor.name will see "DedicatedWorkerGlobalScope".',
      });
      resolve();
    };
    sw.port.start && sw.port.start();
    setTimeout(function () { if (!done) { done = true; resolve(); } }, 4000);
  });

  // ---------- Probe 4: SharedWorker, MODULE type — race window ----------
  // Module workers use dynamic import() which is async. The shim must buffer
  // the connect-init port until the import resolves; otherwise the event
  // fires before the user's `connect` listener exists.
  await new Promise(function (resolve) {
    var modSrc = 'self.addEventListener("connect", function(e){' +
      'var port = e.source || (e.ports && e.ports[0]);' +
      'if (!port) return;' +
      'port.postMessage({ok: true, mode: "module"});' +
    '});';
    var sw;
    try {
      sw = new SharedWorker(makeWorkerSrcDataURL(modSrc), { type: 'module' });
    } catch (e) {
      row({
        name: 'sw: module-type construction',
        verdict: 'leak',
        actual: 'constructor threw: ' + e,
        expected: 'no throw',
      });
      resolve(); return;
    }
    var done = false;
    sw.port.onmessage = function (e) {
      if (done) return; done = true;
      row({
        name: 'sw: module-type connect fires',
        verdict: e.data && e.data.ok ? 'ok' : 'leak',
        actual: e.data,
        expected: '{ok: true, mode: "module"}',
        note: 'If "unknown" / "leak", the module-worker race fix is missing — the connect event likely fired before the import resolved.',
      });
      resolve();
    };
    sw.port.start && sw.port.start();
    setTimeout(function () {
      if (done) return; done = true;
      row({
        name: 'sw: module-type connect fires',
        verdict: 'leak',
        actual: 'silent for 4s',
        expected: '{ok: true, mode: "module"}',
        note: 'Module-worker race: connect event likely dispatched before import resolved.',
      });
      resolve();
    }, 4000);
  });

  // ---------- Probe 5: navigator.locks ----------
  row({
    name: 'main: typeof navigator.locks',
    verdict: typeof navigator.locks === 'object' && navigator.locks !== null ? 'ok' : 'leak',
    actual: typeof navigator.locks,
    expected: '"object"',
  });
  if (navigator.locks) {
    await new Promise(function (resolve) {
      var settled = false;
      try {
        navigator.locks.request('nightglow-probe', { mode: 'exclusive' }, function (lock) {
          row({
            name: 'main: navigator.locks.request fires callback',
            verdict: 'ok',
            actual: { name: lock && lock.name, mode: lock && lock.mode },
            expected: '{ name: "nightglow-probe", mode: "exclusive" }',
          });
          return Promise.resolve('done');
        }).then(function (v) {
          if (settled) return; settled = true;
          row({
            name: 'main: navigator.locks.request resolves with callback return',
            verdict: v === 'done' ? 'ok' : 'leak',
            actual: v,
            expected: '"done"',
          });
          resolve();
        }, function (e) {
          if (settled) return; settled = true;
          row({
            name: 'main: navigator.locks.request resolves',
            verdict: 'leak',
            actual: 'rejected: ' + e,
            expected: 'resolves with "done"',
          });
          resolve();
        });
      } catch (e) {
        row({
          name: 'main: navigator.locks.request',
          verdict: 'leak',
          actual: 'threw synchronously: ' + e,
          expected: 'returns a Promise',
        });
        resolve();
      }
      setTimeout(function () { if (!settled) { settled = true; resolve(); } }, 3000);
    });

    // navigator.locks.query
    try {
      var snap = await navigator.locks.query();
      row({
        name: 'main: navigator.locks.query returns snapshot',
        verdict: snap && Array.isArray(snap.held) && Array.isArray(snap.pending) ? 'ok' : 'leak',
        actual: snap,
        expected: '{held: [], pending: []}',
      });
    } catch (e) {
      row({
        name: 'main: navigator.locks.query',
        verdict: 'leak',
        actual: String(e),
        expected: 'snapshot object',
      });
    }
  }

  // ---------- Probe 6: navigator.serviceWorker.{ready, getRegistration*} ----------
  if (navigator.serviceWorker) {
    row({
      name: 'main: typeof serviceWorker.ready',
      verdict: typeof navigator.serviceWorker.ready === 'object' ? 'ok' : 'leak',
      actual: typeof navigator.serviceWorker.ready,
      expected: '"object" (a Promise)',
    });
    row({
      name: 'main: typeof serviceWorker.getRegistration',
      verdict: typeof navigator.serviceWorker.getRegistration === 'function' ? 'ok' : 'leak',
      actual: typeof navigator.serviceWorker.getRegistration,
      expected: '"function"',
    });
    row({
      name: 'main: typeof serviceWorker.getRegistrations',
      verdict: typeof navigator.serviceWorker.getRegistrations === 'function' ? 'ok' : 'leak',
      actual: typeof navigator.serviceWorker.getRegistrations,
      expected: '"function"',
    });
  }

  // ---------- Summary ----------
  var leaks = results.filter(function (r) { return r.verdict === 'leak'; }).length;
  var unknown = results.filter(function (r) { return r.verdict === 'unknown'; }).length;
  summary.textContent = 'leaks: ' + leaks + '   ok: ' + (results.length - leaks - unknown) + '   unknown: ' + unknown;
  // Surface results to automated drivers.
  window.__nightglowShimProbes = results;
})();
