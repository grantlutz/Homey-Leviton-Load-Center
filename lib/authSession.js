'use strict';

const { ERR } = require('./LevitonClient');

/**
 * Shared login/repair handlers for the custom `login` view used by every driver
 * (drivers/<id>/pair/login.html and drivers/<id>/repair/login.html).
 *
 * The view emits `login` with { username, password, code?, remember } and expects:
 *   true        -> pairing: continue to the next view
 *   'repaired'  -> repair: the view calls Homey.done()
 *   'twofactor' -> show the verification-code field and submit again
 * and a thrown Error (message shown in the view) for anything else.
 */

function friendlyLoginError(err) {
  switch (err && err.code) {
    case ERR.INVALID_CODE: return new Error('Invalid verification code — try again.');
    case ERR.AUTH: return new Error('Incorrect e-mail or password.');
    case ERR.RATE_LIMIT: return new Error('Too many sign-in attempts — wait a few minutes and try again.');
    case ERR.CONNECTION: return new Error('Could not reach the Leviton cloud — check the Homey\'s internet connection.');
    default: return new Error((err && err.message) || 'Login failed');
  }
}

function registerLoginHandlers(session, hub, { repair = false } = {}) {
  // Lets the view pre-fill the e-mail address (never the password).
  session.setHandler('get_login_defaults', async () => ({ email: hub.getStoredEmail() }));

  session.setHandler('login', async ({
    username, password, code, remember,
  } = {}) => {
    try {
      await hub.login(String(username || '').trim(), password, code, { remember: remember !== false });
      return repair ? 'repaired' : true;
    } catch (err) {
      if (err.code === ERR.TWO_FACTOR) return 'twofactor';
      throw friendlyLoginError(err);
    }
  });
}

/** Pairing: login view + skip it only when the stored session actually still works. */
function registerPairAuth(session, hub) {
  session.setHandler('showView', async (viewId) => {
    if (viewId === 'login' && await hub.validateSession()) await session.nextView();
  });
  registerLoginHandlers(session, hub, { repair: false });
}

/** Repair: always show the login view; success recovers every device app-wide. */
function registerRepairAuth(session, hub) {
  registerLoginHandlers(session, hub, { repair: true });
}

module.exports = {
  registerPairAuth, registerRepairAuth, registerLoginHandlers, friendlyLoginError,
};
