// Which copy of the app is this: live (/lift-log/) or dev (/lift-log/dev/)?
// Worked out from the address, so the dev and main branches hold identical files.
// Loaded as a plain script by index.html and by the service worker (importScripts).
(function () {
  var isDev = /\/dev\//.test(self.location.pathname);
  self.LIFTLOG_ENV = {
    ENV: isDev ? 'dev' : 'live',
    DB_NAME: isDev ? 'liftlog-dev' : 'liftlog',            // separate on-device databases
    CACHE_PREFIX: isDev ? 'liftlog-dev-' : 'liftlog-live-', // separate offline caches
    APP_NAME: isDev ? 'Lift Log DEV' : 'Lift Log'
  };
  if (self.document) {
    document.documentElement.dataset.env = self.LIFTLOG_ENV.ENV;
    try { // last-used theme, so the first paint already has the right colours
      var t = localStorage.getItem('liftlog-theme-' + self.LIFTLOG_ENV.ENV);
      if (t && /^[a-z-]+$/.test(t)) document.documentElement.dataset.theme = t;
      // light themes need dark status-bar text on iPhone; dark themes keep the see-through bar
      var dark = /^(iron|blackout|ember|deep-end|afterhours)$/.test(t || '');
      var sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (sb) sb.setAttribute('content', dark ? 'black-translucent' : 'default');
    } catch (e) { /* private mode etc. */ }
  }
})();
