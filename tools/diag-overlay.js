/**
 * Surface swallowed client-side errors in the dsh web UI.
 *
 * Context: the workspace picker silently reverts to its default and the server
 * log stays silent, which means the confirm handler throws before any request
 * is sent — and something swallows the rejection, so nothing reaches the
 * screen. Guessing which browser API is missing has already cost several
 * rounds; this shows the actual error instead.
 *
 * Loaded as a classic script before the module entry. It installs handlers for
 * `error` and `unhandledrejection`, and also makes the page own
 * `window.console.error` / `.warn`, since a caught-and-logged failure is the
 * likeliest reason nothing was visible.
 *
 * The banner is plain DOM inserted on DOMContentLoaded, with no dependency on
 * the app's own styles or bundles.
 */
(function () {
  'use strict';

  var seen = [];
  var MAX = 12;

  function render() {
    var host = document.getElementById('__dsh_diag');
    if (!host) {
      host = document.createElement('div');
      host.id = '__dsh_diag';
      host.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'max-height:45%', 'overflow:auto', 'background:#1b1b1f', 'color:#ffb4b4',
        'font:12px/1.45 ui-monospace,Menlo,monospace', 'padding:8px 10px',
        'border-top:2px solid #ff5c5c', 'white-space:pre-wrap', 'word-break:break-word',
      ].join(';');
      host.addEventListener('dblclick', function () { host.remove() });
      document.body.appendChild(host);
    }
    host.textContent = '【诊断】双击此处关闭\n\n' + seen.join('\n\n');
  }

  function record(kind, detail) {
    if (seen.length >= MAX) return;
    seen.push('[' + kind + '] ' + detail);
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render);
  }

  function describe(value) {
    if (value instanceof Error) {
      return value.message + (value.stack ? '\n' + value.stack.split('\n').slice(0, 4).join('\n') : '');
    }
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value) } catch (e) { return String(value) }
  }

  window.addEventListener('error', function (event) {
    record('error', describe(event.error || event.message));
  });

  window.addEventListener('unhandledrejection', function (event) {
    record('rejection', describe(event.reason));
  });

  // A caught failure that is merely logged is invisible without this.
  var originalError = console.error;
  var originalWarn = console.warn;
  console.error = function () {
    record('console.error', Array.prototype.map.call(arguments, describe).join(' '));
    return originalError.apply(console, arguments);
  };
  console.warn = function () {
    record('console.warn', Array.prototype.map.call(arguments, describe).join(' '));
    return originalWarn.apply(console, arguments);
  };

  // Report which late APIs are actually present, so a missing one is obvious
  // in the same banner rather than inferred.
  var probes = [
    'Iterator', 'AbortSignal.any', 'Promise.withResolvers', 'Object.groupBy',
    'Map.groupBy', 'Array.fromAsync', 'TextDecoderStream', 'TransformStream',
    'ReadableStream', 'structuredClone', 'crypto.randomUUID', 'Array.prototype.toSorted',
  ];
  var missing = [];
  for (var i = 0; i < probes.length; i++) {
    var path = probes[i].split('.');
    var node = window;
    var ok = true;
    for (var j = 0; j < path.length; j++) {
      if (node === undefined || node === null) { ok = false; break }
      node = node[path[j]];
    }
    if (!ok || node === undefined || node === null || node === false) missing.push(probes[i]);
    else if (typeof node === 'function' && /^[A-Z]/.test(path[path.length - 1]) && node === undefined) missing.push(probes[i]);
  }
  record('probe', 'missing: ' + (missing.length ? missing.join(', ') : '(none)'));

  // --- WebSocket interception ---------------------------------------------
  // The session controller reports "control stream failed: undefined is not an
  // object (evaluating 'socket.send')", which means `new WebSocket(...)` threw
  // and the local variable stayed undefined — and that throw is swallowed, so
  // nothing reaches the banner. Wrapping the constructor surfaces both the URL
  // and the exact exception.
  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function' && !NativeWebSocket.__dsh_diag) {
    var DiagWebSocket = function (url, protocols) {
      var socket;
      try {
        socket = protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      } catch (error) {
        record('ws-throw', String(url) + ' :: ' + describe(error));
        throw error;
      }
      record('ws-attempt', String(url));
      socket.addEventListener('open', function () { record('ws-connected', String(url)) });
      socket.addEventListener('error', function () { record('ws-error', String(url)) });
      socket.addEventListener('close', function (event) {
        record('ws-close', String(url) + ' code=' + event.code + ' reason=' + event.reason + ' clean=' + event.wasClean);
      });
      return socket;
    };
    DiagWebSocket.prototype = NativeWebSocket.prototype;
    DiagWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    DiagWebSocket.OPEN = NativeWebSocket.OPEN;
    DiagWebSocket.CLOSING = NativeWebSocket.CLOSING;
    DiagWebSocket.CLOSED = NativeWebSocket.CLOSED;
    DiagWebSocket.__dsh_diag = true;
    try {
      window.WebSocket = DiagWebSocket;
      record('ws-patched', 'WebSocket wrapped');
    } catch (error) {
      record('ws-patch-fail', describe(error));
    }
  }
})();
