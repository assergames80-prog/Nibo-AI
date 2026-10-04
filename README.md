# 🐰 Nibo AI

A cute, hand-drawn AI bunny who floats on your desktop, answers your questions at
[Groq](https://groq.com) speed, tells silly jokes and *really* likes carrots.
Inspired by classic desktop buddies like BonziBuddy.

![Nibo floating on a desktop: greeting, preset menu, answering a question, eating a carrot and dancing](docs/screenshot.png)

## Features

- **Floats on your desktop.** Nibo lives in a transparent, always-on-top window and gently bobs up and down.
  Clicks pass straight through the empty space around him, and you can drag him anywhere.
- **Hand-drawn SVG.** Wobbly sketch outlines, pencil hatching, a floppy ear and a little bow tie.
  He blinks, twitches his ears, waves, and his eyes follow your mouse.
- **Ask him anything.** Hover over Nibo and a prompt bar pops up. Answers stream into a speech bubble via the Groq API.
- **Silly presets.** Click **Preset ▾** or right-click Nibo:
  - 🗂️ Organize my apps
  - 😂 Tell me a joke
  - 🔎 Search the web for…
  - 💡 Fun fact
  - 💖 Cheer me up
  - 🥕 Feed Nibo
  - 💃 Dance party
  - 🐇 Hop around your screen
  - 😴 Take a nap
  - Plus: squeaky voice on/off, forget the chat, settings, hide and quit.
- **Feed him.** Hit the 🥕 button and he munches happily, does a binky and floats hearts. Over time he gets hungry:
  a sad face, a rumbling tummy and hints about carrots. Feed him too much and he's stuffed.
- **Squeaky voice (optional).** Nibo can read his replies out loud with your system's text-to-speech.
- **Works offline too.** Without an API key, his little bunny brain still handles greetings, jokes, fun facts,
  math, the time and date, and offers to search the web for everything else.
- **Lives in the tray.** You can hide him, bring him back, and have him start when you log in.

## Download for Windows

1. Open the [**Actions** tab](https://github.com/assergames80-prog/Nibo-AI/actions/workflows/build.yml), click the
   latest successful **Build Nibo AI** run, and download the **Nibo-AI-Windows** artifact.
   (When a version tag like `v1.0.0` is pushed, the same files are attached to a
   [Release](https://github.com/assergames80-prog/Nibo-AI/releases).)
2. Unzip it. You get two `.exe` files:
   - `Nibo-AI-Setup-x.y.z.exe`: installer with Start-menu and desktop shortcuts.
   - `Nibo-AI-Portable-x.y.z.exe`: a single file you just run, nothing to install.
3. The executables aren't code-signed yet, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

## Give Nibo a brain (Groq API key)

1. Create a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Right-click Nibo → ⚙️ **Settings**, paste the key, press **Test**, then **Save 🥕**.

You can also set a `GROQ_API_KEY` environment variable instead.
The default model is `openai/gpt-oss-20b`, which is fast. You can pick any Groq chat model in Settings,
and if a model is ever retired, Nibo switches to another available one by himself.

## How to play

| Do this | Nibo does |
| --- | --- |
| Hover over him | Shows the prompt bar, tummy 🥕 and happiness 💜 meters |
| Type and press Enter | Answers in his speech bubble (Esc cancels) |
| Type `search for …` / `google …` | Opens the search in your browser |
| Click him | Giggles (and wakes up if he's napping) |
| Drag him | Dangles while you carry him, then lands with a squish |
| Right-click him / **Preset ▾** | Opens the silly menu |
| 🥕 button | Carrot time! |
| Tray icon | Show / hide Nibo, feed him, settings, quit |

## Privacy

- What you ask is sent to Groq only when an API key is set. The chat history lives in memory (the last few
  messages) and is wiped by 🧹 *Forget our chat* or by quitting.
- **Organize my apps** only *reads the names* of the items on your Desktop, on your computer. Nothing is moved,
  deleted or uploaded. It's a silly report, not a real cleanup.
- Your API key is encrypted with the operating system's secure storage (DPAPI on Windows) and kept in Nibo's
  settings file in `%APPDATA%\Nibo AI\`.
- Web searches open in your default browser with Google, DuckDuckGo or Bing (your choice).

## Build from source

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start               # run Nibo
npm test                # unit tests
npm run dist:win        # Windows installer + portable exe in dist/
npm run dist:portable   # just the portable exe
```

`dist:win` is easiest on Windows. On Linux or macOS the portable exe builds fine, but the NSIS installer step needs Wine.
GitHub Actions builds both on a Windows runner for every push.

Other helpers:

- `npm run icons` re-renders `assets/*.png` from `assets/icon.svg`.
- `npm run screenshots` plays a few scenes against a fake Groq server and refreshes `docs/screenshot.png`.

### Project layout

```
src/main/       Electron main process
  main.js       window, tray, dragging, hopping, IPC
  brain.js      Groq chat (streaming, friendly errors, model fallback)
  offline.js    the offline bunny brain, desktop "organizer", web search URLs
  pet.js        tummy & happiness
  store.js      settings + encrypted API key
src/preload/    the small, safe APIs exposed to the pages
src/renderer/   Nibo himself: SVG bunny (index.html), styles, behavior (app.js), speech bubble, settings
assets/         app and tray icons
test/           unit tests and a mock Groq server
```

## Credits

- [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) font by Patrick Wagesreiter, SIL Open Font License 1.1
  (`src/renderer/fonts/OFL.txt`).
- Inspired by BonziBuddy and the other desktop pals of the early 2000s.
- Released under the [MIT License](LICENSE).
