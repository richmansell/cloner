# Pacer — a free running coach

**Live app:** https://richmansell.github.io/cloner/

Pacer builds a personalised running plan around your week — like a coaching app, but free, with no sign-up and no AI calls. Everything runs in your browser and your plan is saved in your browser's local storage.

## What it does

- **Goals:** Start running (couch to 5K), 5K, 10K, half marathon, marathon, or general fitness.
- **Your schedule:** choose your run days, your long-run day, and a time limit for weekday runs.
- **Your preferences:** say which sessions you love or would rather avoid (intervals, tempo, hills, fartlek, progression runs, strides), your terrain, and how many strength sessions you want.
- **Personal paces:** your fitness score (Jack Daniels' VDOT) comes from a recent race or your level, and sets paces for every session type.
- **Periodised plan:** Base → Build → Peak → Taper, a cutback week every 4th week, weekly distance rising by no more than about 10%, and roughly 80% easy running.
- **Structured workouts:** warm-up, reps, recoveries and cool-down with target paces and an intensity chart.
- **Adapts:** log how each session felt and your target paces adjust. Log a race or time trial to recalibrate everything.
- **Flexible:** move sessions to another day, or skip them.
- **Share:** invite your mates with a link that pre-fills your race, copy your week into a group chat, or export the plan to your calendar (.ics).
- **Multiple runners per device**, backup and restore, km or miles, light and dark mode, and it works offline once loaded (PWA).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole app (UI and training engine inlined) |
| `engine.js` | The training engine source, kept separate so it's readable and testable (`node test.js`) |
| `src.html` | UI source; `build.sh` inlines `engine.js` into it to produce `index.html` |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline support and "Add to Home Screen" |

## Hosting

The app is hosted free on GitHub Pages from the `main` branch root.

*Not medical advice. If something hurts, rest and see a professional.*
