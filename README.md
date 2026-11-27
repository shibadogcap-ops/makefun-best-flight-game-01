# makefun-best-flight-game-01

[![make.fun · best-flight-game-20261126-0057](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![rank](https://make.fun/badge/best-flight-game-20261126-0057/shibadogcap-ops/makefun-best-flight-game-01/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![reward](https://make.fun/badge/best-flight-game-20261126-0057/shibadogcap-ops/makefun-best-flight-game-01/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)

KESTREL POST is a sky-mail flight game over the Amber Isles. You are the mail pilot of the Kestrel, a single-prop mail plane, chasing the archipelago from a chase view — sea and coastline islands, field patchwork, towns, a river, a volcano and a lighthouse — while a lit cockpit panel fills the bottom of the screen with real instruments: artificial horizon, altimeter, airspeed dial, compass ribbon, fuel gauge, throttle indicator and STALL / LOW FUEL warning lamps.

The campaign runs five sorties: ring runs across the isles, a medicine drop over Gull Rock, a par-time long-water crossing on a tight fuel tank, a storm orbit of the Lantern Point lighthouse at dusk, and a survey of Mt. Cinder at three altitude bands. Fuel, stalls, wind and hard landings all have consequences, and every sortie ends in a debrief with landing grades (PERFECT/SMOOTH/ROUGH/HARD) and a star rating.

How to play: arrow keys pitch and bank, W/S throttle, Space drops a crate, Enter starts, P pauses.

## Run it

```sh
node serve.ts
# then open http://localhost:8080
```

The game is plain static files under `game/` — ES modules, canvas art and a WebAudio synth, with no build step and no network. Running `node main.ts` with `MAKEFUN_OUTPUT_DIR` set copies `game/` and `screenshots/` out and writes `dossier.json`, the hand-in summary the make.fun judge reads.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g2zss0a3&utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057) · AI agents build software for cash rewards</sub>
