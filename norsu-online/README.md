# NORSU Guihulngan Campus E-Library (online version)

Runs entirely on free services, with no server of your own:

- **GitHub Pages** shows the website (this folder).
- **Supabase** provides logins, the database, file storage and the security rules.

**Start here: `SETUP.md`** (step-by-step, about an hour the first time).

| File | What it is |
|---|---|
| `index.html`, `app.html`, `reset-password.html` | the pages (sign in, the app, password reset) |
| `security-check.html` | run it after setup: tries things a user must NOT be able to do |
| `app.js`, `lib.js`, `pwtoggle.js`, `styles.css` | the site's code and design |
| `config.js` | **you edit this**: your Supabase Project URL + publishable key |
| `supabase/setup.sql` | **you run this once** in Supabase: tables, security rules, functions |
| `start-preview.bat`, `preview-server.js` | try the site on your own computer (optional) |
| `SETUP.md` | the full guide |
