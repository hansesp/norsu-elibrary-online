// Shared setup: creates the Supabase connection (window.sb) used by every page.
(function () {
  // remember the address as it arrived (Supabase's password-reset link puts data in it,
  // and the library tidies it away a moment after loading)
  window.INITIAL_HASH = window.location.hash || '';
  window.INITIAL_SEARCH = window.location.search || '';

  var c = window.APP_CONFIG || {};
  var notFilled = !c.SUPABASE_URL || !c.SUPABASE_KEY || /YOUR-/i.test(c.SUPABASE_URL + c.SUPABASE_KEY);
  window.sbMissing = notFilled || !window.supabase;
  window.sbMissingReason = !window.supabase
    ? 'The Supabase library could not be loaded (check your internet connection).'
    : 'Supabase is not connected yet. Open config.js and fill in SUPABASE_URL and SUPABASE_KEY (see SETUP.md, step 6).';
  if (!window.sbMissing) {
    window.sb = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  // turns Supabase's technical messages into something a student can understand
  window.friendlyAuthError = function (err) {
    var m = String((err && err.message) || '').toLowerCase();
    var s = err && err.status;
    if (s === 429 || m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1) return 'Too many attempts. Please wait a few minutes and try again.';
    if (m.indexOf('invalid login') !== -1) return 'Incorrect email or password.';
    if (m.indexOf('not confirmed') !== -1) return 'Please confirm your email first - check your inbox for the confirmation link.';
    if (m.indexOf('already registered') !== -1 || m.indexOf('already been registered') !== -1) return 'That email is already registered.';
    if (m.indexOf('password') !== -1 && (m.indexOf('least') !== -1 || m.indexOf('weak') !== -1 || m.indexOf('short') !== -1)) return 'Password must be at least 6 characters.';
    if (m.indexOf('valid email') !== -1 || m.indexOf('invalid email') !== -1 || m.indexOf('unable to validate email') !== -1) return 'Please enter a valid email address.';
    if (m.indexOf('database error saving new user') !== -1) return 'Could not create your account. Please check your details and try again.';
    if (m.indexOf('sending') !== -1 && m.indexOf('email') !== -1) return 'The email could not be sent right now. Please try again later or ask library staff for help.';
    if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1) return 'Cannot reach the server. Please check your internet connection.';
    return 'Something went wrong. Please try again.';
  };
})();
