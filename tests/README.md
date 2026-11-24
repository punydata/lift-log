# Automated tests (not published to the site)

Run from a checkout at /home/claude/lift-log with Python Playwright installed.

- `v06_test.py` — full run-through (114 checks): v1→v2 database upgrade from v0.5-shaped data, calendar/streak,
  name matching + duplicate check, force reps, cardio, tap-to-investigate, merge + undo, injected-script attempts,
  export → wipe → import round trip, old-CSV import, bad/hostile files, themes, offline, CSP. Screenshots go to /home/claude/tests/shots.
- `env_test.py` / `mixed_test.py` — live and dev copies side by side on one origin (separate databases and caches).
  Build the site first: `scripts/build-site.sh <main-checkout> <dev-checkout> /tmp/site`.
- Theme contrast: `python3 scripts/themes.py` (regenerates css/themes.css, fails if any pair is under 4.5:1).
