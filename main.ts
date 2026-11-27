// Hand-in program for KESTREL POST (Node 22, standard library only). The game is the
// game/ directory beside this file — plain static files a desktop browser loads offline.
// This program stages an entry directory: it creates the output directory (MAKEFUN_OUTPUT_DIR,
// /output inside the grader), copies game/ into it, copies screenshots/ when present, and
// writes dossier.json — the summary the make.fun judge reads — with the vendored library's
// buildDossier, held to the bounty's caps so the dossier matches what the scorer accepts.
//
// Serve the game locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
