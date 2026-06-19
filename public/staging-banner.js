// Visible STAGING ribbon on any host that isn't the production domain.
// Pure hostname check — no env needed client-side. Inert on production.
(function () {
  var host = location.hostname;
  var isProd = host === 'ofarim.pages.dev' || host === 'www.ofarim.pages.dev';
  if (isProd) return;
  function mount() {
    var bar = document.createElement('div');
    bar.textContent = '⚠ STAGING — סביבת בדיקות בלבד (נתונים לא אמיתיים)';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;' +
      'font:600 13px system-ui,sans-serif;text-align:center;padding:4px;letter-spacing:.04em;';
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
