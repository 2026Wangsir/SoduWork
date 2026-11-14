# Login feedback implementation plan

[简体中文](2026-11-14-login-feedback.zh-CN.md) · **English**

**Goal:** Distinguish missing accounts and incorrect passwords in desktop password sign-in, using the approved field messages and recovery links.

**Architecture:** Keep both existing password routes, account resolution and attempt budgets. Return `ACCOUNT_NOT_FOUND` or `PASSWORD_INCORRECT` with HTTP 401. The renderer uses these codes for localized field feedback; other failures retain their existing handling. No account lookup endpoint or database migration is needed.

**Stack:** FastAPI, SQLAlchemy, Electron renderer JavaScript/CSS, Python unittest and Node test runner.

- [x] Add HTTP tests in `hub-backend/test_email_auth.py` for both routes, missing accounts, incorrect passwords, unchanged device/account data and persisted attempt budgets. Run the new cases and observe failure, then split the two credential checks in `app/api/client_auth.py` and `app/api/client_email_auth.py`.
- [x] Add behavior tests in `client/tests/email-auth-policy.test.cjs` for account/password field feedback, focus, editing, mode changes, localization, unchanged recovery links and unrelated errors. Observe failure, then implement inline feedback in `components/client-auth/email-auth.js`, styles in `account-center.css` and translations in `core/locales/builtin-ui.js`. Keep password reset and old-server generic errors compatible.
- [x] Run `npm test` in `client`, the email authentication backend suite, and the public-source, third-party, documentation and secret-scanning checks. Verify real Chromium field placement, focus, error clearing, recovery navigation and visibility reset using synthetic API responses and an isolated profile. Review the final diff and report any unavailable checks.

The user approved the design in chat and requested implementation. Execute in this chat; leave the changes available for review without committing them.
