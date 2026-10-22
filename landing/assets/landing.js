// Invite landing page: https://pactapp.io/j/K7MQ2X
// Shows who is inviting you to what, the code in large type, and store links.
// Copies the code so the app can prefill it on first launch.
(function () {
  'use strict';

  var CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
  var STATUS_COPY = {
    expired: 'This invite expired. Ask your partner to send a new one.',
    full: 'This pact is already full.',
    invalid: "This invite doesn't exist or was replaced. Ask for a fresh link.",
  };

  function codeFromPath(pathname) {
    var m = pathname.match(/\/j\/([^/?#]+)/);
    if (!m) return null;
    var code = decodeURIComponent(m[1]).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return CODE_RE.test(code) ? code : null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function copyCode(code) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve(false);
    return navigator.clipboard.writeText(code).then(
      function () {
        el('copy-hint').textContent = 'Code copied. Pact will fill it in for you.';
        return true;
      },
      function () {
        return false;
      },
    );
  }

  function showStatus(text) {
    el('status').textContent = text;
    el('status').hidden = false;
  }

  function preview(config, code) {
    return fetch(config.supabaseUrl + '/rest/v1/rpc/invite_preview', {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: 'Bearer ' + config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: code }),
    }).then(function (res) {
      if (!res.ok) throw new Error('preview failed: ' + res.status);
      return res.json();
    });
  }

  function init() {
    var config = window.PACT_CONFIG || {};
    var code = codeFromPath(window.location.pathname);

    el('app-store').href = config.appStoreUrl || '#';
    el('play-store').href = config.playStoreUrl || '#';

    if (!code) {
      el('code').hidden = true;
      el('open-app').hidden = true;
      el('copy').hidden = true;
      showStatus(STATUS_COPY.invalid);
      return;
    }

    el('code').textContent = code.slice(0, 3) + '-' + code.slice(3);
    el('open-app').href = 'pact://j/' + code;

    // Browsers that need a user gesture for the clipboard get one here: any
    // tap on the page's buttons copies the code before navigating.
    copyCode(code);
    ['copy', 'app-store', 'play-store'].forEach(function (id) {
      el(id).addEventListener('click', function () {
        copyCode(code);
      });
    });

    preview(config, code)
      .then(function (p) {
        if (p.status !== 'valid' && STATUS_COPY[p.status]) showStatus(STATUS_COPY[p.status]);
        if (p.status === 'invalid') return;
        if (p.title) el('title').textContent = p.title;
        if (p.inviter_name) el('invited-by').textContent = 'Join ' + p.inviter_name + "'s pact";
        document.title = (p.inviter_name ? p.inviter_name + ' invited you · ' : '') + 'Pact';
      })
      .catch(function () {
        // Offline or misconfigured: the code and store links still work.
      });
  }

  window.PactLanding = { codeFromPath: codeFromPath };
  init();
})();
