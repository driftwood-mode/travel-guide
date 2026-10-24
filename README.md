# Wayside

A location-aware travel guide that runs in the phone's browser. It watches your GPS, finds notable places around you on Wikipedia, asks "Want to hear about it?", reads a short story aloud, and offers more detail level by level.

- **Walk mode** (under 20 km/h): places within ~300 m, closest and most substantial first.
- **Drive mode** (20 km/h and over): towns, rivers, landmarks within ~10 km, preferring what's ahead of you.
- Answer by voice ("yes", "no", "more" / "ja", "nein", "mehr") or with the big buttons.
- English and German.

## Run it

It's a static site with no build step and no API keys.

```sh
python3 -m http.server 8000
```

Location and voice need HTTPS on a phone, so test on a deployed copy (GitHub Pages works).

To test at a desk, simulate a position: `?sim=lat,lon[,headingDeg,speedKmh]`, for example `?sim=49.4122,8.7100` (walking in Heidelberg) or `?sim=47.80,12.00,90,100` (driving east at 100 km/h).

## Files

- `index.html`, `style.css`: the UI
- `app.js`: location, ranking, Wikipedia, speech and the ask / tell / more-detail flow
- `sw.js`, `manifest.json`, `icon.svg`: add-to-home-screen support

Content comes from Wikipedia under CC BY-SA.
