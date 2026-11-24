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
  if (self.document) document.documentElement.dataset.env = self.LIFTLOG_ENV.ENV;
})();
