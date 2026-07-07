// ============================================================
// API INTERCEPTOR — runs in PAGE context (main world)
// Injected by message-extractor.js via chrome.runtime.getURL
// ============================================================
// Captures auth headers from OF's own API calls (app-token, x-bc,
// user-id, etc.) and provides a message-based bridge for the
// content script to make API calls with those headers.
// ============================================================

(function() {
  if (window.__clarityApiReady) return;
  window.__clarityApiReady = true;
  window.__clarity_of_headers = null;
  window.__clarity_of_user_id = null;

  // ── Intercept fetch ──
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (url.indexOf('/api2/v2/') !== -1) {
      try {
        var h = init && init.headers;
        if (h) {
          var captured = {};
          if (h instanceof Headers) {
            h.forEach(function(v, k) { captured[k] = v; });
          } else if (typeof h === 'object') {
            var keys = Object.keys(h);
            for (var i = 0; i < keys.length; i++) { captured[keys[i]] = h[keys[i]]; }
          }
          window.__clarity_of_headers = captured;
          if (captured['user-id']) window.__clarity_of_user_id = captured['user-id'];
        }
      } catch(e) {}
    }
    return _origFetch.apply(this, arguments);
  };

  // ── Intercept XMLHttpRequest ──
  var _origOpen = XMLHttpRequest.prototype.open;
  var _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  var _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__clarity_url = url || '';
    this.__clarity_headers = {};
    return _origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
    if (this.__clarity_url && this.__clarity_url.indexOf('/api2/v2/') !== -1) {
      this.__clarity_headers[key] = value;
    }
    return _origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__clarity_url && this.__clarity_url.indexOf('/api2/v2/') !== -1) {
      var hk = Object.keys(this.__clarity_headers);
      if (hk.length > 0) {
        window.__clarity_of_headers = this.__clarity_headers;
        if (this.__clarity_headers['user-id']) {
          window.__clarity_of_user_id = this.__clarity_headers['user-id'];
        }
      }
    }
    return _origSend.apply(this, arguments);
  };

  // ── Handle API requests from content script ──
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== '__clarity_api_request') return;
    var callbackId = e.data.callbackId;
    var url = e.data.url;
    var headers = window.__clarity_of_headers ? Object.assign({}, window.__clarity_of_headers) : {};

    _origFetch(url, {
      method: 'GET',
      headers: headers,
      credentials: 'include'
    })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      window.postMessage({ type: '__clarity_api_response', callbackId: callbackId, data: data }, '*');
    })
    .catch(function(err) {
      window.postMessage({ type: '__clarity_api_response', callbackId: callbackId, error: err.message }, '*');
    });
  });

  console.log('[Clarity] 🔑 API interceptor ready (page context)');
})();
