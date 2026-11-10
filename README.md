# Valchiusella Trail

Static site with a map of Valchiusella (TO) routes, elevation profiles and
downloadable GPX files. Hosted for free on GitHub Pages; no server, no database.

## How it works

```
trails/<slug>.gpx     ← your original track (Garmin, Strava, Komoot export…)
trails/<slug>.yaml    ← optional info: title, difficulty, season, water…
        │
        ▼  scripts/build.py   (runs automatically on every push)
site/data/trails.json ← stats, simplified line, elevation profile
site/gpx/<slug>.gpx   ← cleaned GPX: no times, HR, device or author
        │
        ▼  GitHub Pages
```

## Add a route

1. Copy the GPX into `trails/` with a short lowercase name, e.g.
   `trails/monte-marzo.gpx` (the name becomes the URL: `#/trail/monte-marzo`).
2. Optionally add `trails/monte-marzo.yaml`:

   ```yaml
   title:
     it: "Monte Marzo da Fondo"
     en: "Monte Marzo from Fondo"
   description:
     it: "Salita classica…"
     en: "Classic climb…"
   difficulty: EE              # T | E | EE | EEA (CAI scale)
   activity: [trail, hike]     # one or both
   season: [6, 7, 8, 9, 10]    # good months (1-12); omit = all year
   snow:
     it: "Neve sopra i 2000 m fino a giugno."
     en: "Snow above 2000 m until June."
   water:
     - { name: "Fontana Alpe X", lat: 45.5612, lon: 7.6801 }
   poi:
     - { name: "Bivacco Y", lat: 45.57, lon: 7.67 }
   # type: loop | point        # auto-detected; set only to override
   # from_hub: true            # auto-detected from the Hub position
   # order: 1                  # position in the list (lower = first)
   ```

   Water points can also be waypoints inside the GPX: any waypoint whose
   name or symbol contains *acqua, fontana, sorgente, water, fountain…* is
   shown as a water point.
3. Commit and push. The site updates in about a minute.

Everything not in the YAML falls back to sensible defaults (title from the GPX
track name, activity = hike).

## Run locally (Codespaces)

```bash
uv run scripts/build.py
python -m http.server -d site 8000
```

Then open the forwarded port 8000.

## First-time GitHub setup

1. Create a repo and push this folder to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push (or run the workflow manually from the Actions tab).

The site will be at `https://<user>.github.io/<repo>/`. To use your own domain,
add it in Settings → Pages.

## Settings — `config.yaml`

- `hub`: name, coordinates and radius of the Valchiusella Mountain Hub.
  **Set the real coordinates**: the current ones are a placeholder.
- `map.thunderforest_key`: free key from thunderforest.com to add the
  "Outdoors" base map.
- `loop_threshold_m`: max start–end gap to count a track as a loop.

## Demo routes

The three `trails/demo-*` files are synthetic tracks so the site works on the
first deploy. Delete them once you've added real routes.
