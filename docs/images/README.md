# README image provenance

These images show this project's Phaser/CSS interface. The map and character art are drawn by `src/game.ts`; no external game sprites or photos are used.

Generate with dependencies and Chromium installed:

```sh
npm run build
npx tsx scripts/capture-readme.ts
```

The script starts a disposable production server with an explicitly empty model key, opens an isolated Chromium context, seeds a fictional save with the player near Mei, and selects the game's actual **rules demo** mode through the interface. NPC cooldowns are delayed for stable map framing. Dialogue is selected by the built-in rules provider and rendered by the real expression and localization code. External/model requests are blocked, and the script fails if any are attempted.

- `fog-harbor-en.png`: English town interface.
- `dialogue-en.png`: English dialogue about Mei's plans, from a local rules decision.
- `fog-harbor-zh.png`: Chinese town interface.
- `capture.json`: timestamp, rendering setup and recorded decision sources.

These screenshots demonstrate presentation and integration, not live Jev behavior or character-quality results. They contain no real player save or API credentials. The app's rules-mode badge remains visible. No screenshot-only mock prose is inserted.

The architecture diagrams in the root READMEs are authored Mermaid descriptions of the implementation, not external assets. Project licensing remains an owner decision; this provenance note does not create a license grant.
