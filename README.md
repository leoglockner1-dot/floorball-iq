# FLOORBALL IQ – website

Free static site (GitHub Pages, repo `floorball-iq` → `https://<user>.github.io/floorball-iq/`):
- `/` – hub page (`index.html`)
- `/app/` – the FLOORBALL IQ training app as a web build. **Generated** from `~/Developer/floorball-iq` with `tools/build-app.sh` – never edit `app/` by hand.
- `/shots/` – Shot Tracker web prototype (below)

## Shot Tracker

One static page that counts floorball goals and their zone (3×2 grid) live from the phone's back camera. All analysis runs in the browser; nothing is uploaded and no video is saved. Results are a **camera estimate** until the accuracy test passes (≥ 95 % of goals found, ≤ 2 % false goals).

Docs, approach and test plan: Obsidian vault → `Projekte/FLOORBALL IQ/12 - Camera Shot Tracker.md`.

### Files (in `shots/`)
- `index.html` – screens and styles
- `app.js` – sources (camera / video file / demo), corner marking, live loop, confirmations, result + accuracy check
- `tracker-core.js` – detection logic without DOM (homography, background model, ball mask, blobs, shot events, goal decision)
- `scene-sim.js` – synthetic goal scene with scripted shots and known truth (demo + tests)
- `fonts/` – Barlow Condensed 800/900 (OFL, see `fonts/OFL.txt`)

## Run
- Tests: `node shots/test/run-tests.mjs` (add `-v` for every event)
- Locally: `python3 tools/serve.py` → http://localhost:8090/floorball-iq/ (behaves like GitHub Pages: same path, `/x` serves `x.html`; vault launch config `floorball-iq-site`). The camera works on localhost on the Mac; the iPhone needs the https URL.
- Update the app on the site: `tools/build-app.sh`, check, commit, push.
