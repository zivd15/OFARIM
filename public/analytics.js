(function () {
  var PROD_HOST = 'ofarim.pages.dev';
  if (location.hostname !== PROD_HOST) return;

  var sid = sessionStorage.getItem('_ofa_sid');
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('_ofa_sid', sid);
  }

  var PAGE_MAP = {
    '/':             'home',
    '/calendar':     'calendar',
    '/login':        'login',
    '/dashboard':    'dashboard',
    '/terms':        'terms',
    '/cancellation': 'cancellation',
    '/privacy':      'privacy',
  };
  var path = location.pathname.replace(/\/$/, '') || '/';
  var page = PAGE_MAP[path] || path.replace(/^\//, '').split('/')[0] || 'other';

  var ref = '';
  try { if (document.referrer) ref = new URL(document.referrer).hostname; } catch (e) {}

  fetch('/api/analytics/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: page, session_id: sid, referrer: ref }),
    keepalive: true,
  }).catch(function () {});
})();
