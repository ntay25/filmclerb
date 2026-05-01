# FilmClerb

FilmClerb is a no-backend private film screener built from `create-sia-app`.
An organizer uploads a video in the browser, stores it encrypted on Sia, and
generates a small batch of one-day Sia share links for viewers.

## What the Demo Shows

- Upload a video through the Sia browser SDK.
- Create 5 share links by default with `sdk.shareObject(...)`.
- Let a viewer paste a share link and watch or rewatch the film.
- Keep everything browser-only: no database, no server, no backend gatekeeper.

## How It Works

1. The organizer connects the app to the Sia indexer.
2. The selected video is encrypted client-side and uploaded to Sia hosts.
3. FilmClerb calls `sdk.shareObject(object, validUntil)` once per viewer link.
4. A viewer pastes a link.
5. The app calls `sdk.sharedObject(link)` and `sdk.download(object)` to stream
   the decrypted video back into an HTML video player.

The app assumes viewers will not forward their links. Each link expires after
about 24 hours and can be replayed as many times as needed before expiration.

## Run Locally

### Recommended Judge Review

For the most stable local demo, build the app and run Vite preview:

```bash
bun install
bun run build
bun run preview -- --host 127.0.0.1 --port 4173
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

If port `4173` is already busy, Vite will print the next available local URL in
the terminal. Use that printed URL.

If a browser previously opened an older cached version of the app, open
[http://127.0.0.1:4173/?fresh=v2](http://127.0.0.1:4173/?fresh=v2) or hard
refresh the page.

### Development Mode

For active editing, run:

```bash
bun install
bun dev
```

Open [http://localhost:5173](http://localhost:5173), unless Vite prints a
different port.

## Demo Notes for Judges

- Connect FilmClerb to a Sia account/indexer.
- Upload one video from the New screener section.
- FilmClerb creates 5 one-day viewer links by default.
- Copy a link from the large "All viewer links" text box.
- Paste that link into Viewer mode and click Unlock link.
- Click Load film to play the encrypted Sia-hosted video in the browser.

## Core Files

- `src/filmclerb-main-v2.tsx` - current app entry point.
- `src/FilmClerbAppV2.tsx` - current app shell.
- `src/components/screener/FilmClerbStudioV2.tsx` - the FilmClerb upload, link,
  and viewer experience.
- `src/components/CopyLinkButton.tsx` - clipboard helper and copy button with
  manual-copy fallback.
- `src/stores/auth.ts` - Sia connection state.
- `src/lib/constants.ts` - app metadata and Sia erasure-coding settings.

## Scripts

```bash
bun dev
bun run build
bun run check
```

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- Zustand
- `@siafoundation/sia-storage`
