# TimeTravel-A11y

**AI-assisted, non-visual temporal navigation of web archives — built for screen-reader users.**

TimeTravel-A11y is a Chrome extension (Manifest V3) that lets you investigate how a web page has changed over time using the Internet Archive's Wayback Machine. Give it a URL, a year range, and an optional topic of focus; it finds the archived captures, picks the ones most likely to differ, fetches their content, and produces a structured, keyboard-navigable, screen-reader-first report of what changed — with every claimed change checked against the actual archived text.

The guiding constraint is that the primary user cannot see the page. So the analysis is delivered as audio and keyboard navigation, and the system is deliberately conservative: a wrong claim spoken aloud as fact is worse than an omitted true one.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [AI providers](#ai-providers)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Privacy & security](#privacy--security)
- [Limitations](#limitations)
- [Project structure](#project-structure)

---

## Features

- **Temporal change detection** — finds and explains how a page changed across its archived history.
- **Chain-of-verification (CoVe)** — a two-pass AI process: the model drafts candidate changes, then a second pass interrogates and corrects each one against the source snapshots. A wrong claim is dropped, not spoken.
- **Mechanical quote verification** — every quote is independently checked against the captured text. Changes are marked *verified* only when their quotes are actually present.
- **Archival-state classification** — distinguishes a *real deletion* from a *broken replay* or *missing resource*, so an incomplete capture is never reported as an edit.
- **Accessibility decay audit** — measures whether the page itself became more or less accessible over time (headings, alt text, unlabelled inputs, focusable elements before main content, ambiguous links, and more).
- **Collection mode** — paste several URLs to find when a topic *first appeared* across a set of related pages.
- **PII masking** — phone numbers, emails, and ID-style numbers are redacted before any text is processed or shown (on by default).
- **Screen-reader-first interface** — modal overlay with focus trapping, ARIA live regions, and shortcuts that coexist with a screen reader's browse mode.
- **Optional spoken read-out** — an opt-in built-in voice reads changes aloud for users without a screen reader.
- **Export** — copy the report to the clipboard or download it as a plain-text file.

---

## How it works

For a single URL, the background service worker runs a six-step pipeline:

1. **Find captures** — query the Wayback CDX index for all captures in the year range (with escalating fallbacks if the strict query returns nothing).
2. **Filter duplicates** — drop captures with an identical content digest.
3. **Select key snapshots** — keep the first and last, plus captures where the page size "jumps", plus an even sample of the rest.
4. **Fetch & compare content** — download each selected capture in raw replay mode and extract plain text, section structure, accessibility metrics, replay signals, and masked PII.
5. **Classify & verify changes** — run the two-pass AI chain-of-verification.
6. **Build the evidence report** — verify quotes, classify archival state, localise each change to a section, set confidence from the evidence, and assemble the report.

The result is presented in **five levels** of increasing detail: overview → change list → evidence → uncertainty → replay status.


---

## Installation

This is an unpacked Chrome extension (no build step).

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. The ⏱ TimeTravel-A11y icon appears in your toolbar.

---

## Usage

1. Navigate to any normal web page (not a `chrome://` or `about:` page).
2. Click the toolbar icon, or press **`Alt+Shift+T`** (`⌥⇧T` on macOS) to open the overlay directly.
3. The current page's URL is pre-filled. Optionally set:
   - **From / To year** — any range from 1996 to the current year. Leave a field blank to use the full archive.
   - **Focus** — a topic to weight the analysis toward (e.g. *GRE requirement*, *mask policy*).
   - **Mask personal data** — on by default.
4. Activate **Analyze Archive**. Progress is shown and announced as the six steps run.
5. Navigate the results by heading/arrow key, or use the shortcuts below.

**Collection mode:** paste multiple URLs (one per line) to analyse up to eight sites and detect when your focus topic first appeared across them.

---

## AI providers

Configure the provider in the popup under **AI Settings**. Settings are saved to `chrome.storage.local`.

| Provider | Notes |
|----------|-------|
| **Groq** | Hosted free-tier API (OpenAI-compatible), uses a Llama 3.1 8B model. Requires an API key — get one free at [console.groq.com](https://console.groq.com). |
| **Ollama** | Runs a model locally at `localhost:11434` — no key needed, nothing leaves your machine. Model name is configurable (default `llama3.2`). |

If the model can't be reached, the AI change list comes back empty and says so — but the rest of the report (capture statistics, structural analysis, accessibility audit, replay signals, and PII masking) is still produced by the deterministic pipeline.

---

## Keyboard shortcuts

All in-app shortcuts use the **Alt** (`⌥` on macOS) modifier so they don't clash with a screen reader's single-key browse-mode navigation.

| Key | Action |
|-----|--------|
| `Alt+Shift+T` | Toggle the overlay (from any page) |
| `Esc` | Close the overlay |
| `Alt+1` … `Alt+5` | Speak report levels 1–5 |
| `Alt+N` / `Alt+P` | Next / previous change |
| `Alt+Y` | Jump to a year |
| `Alt+B` / `Alt+A` | Hear before / after capture text |
| `Alt+E` | Full evidence for the active change |
| `Alt+O` / `Alt+K` | Open before / after capture in a tab |
| `Alt+M` | Open all key snapshots |
| `Alt+S` / `Alt+X` / `Alt+0` | Speak full report / stop / repeat last |
| `Alt+C` / `Alt+D` | Copy report / download as `.txt` |
| `Alt+R` | Re-run analysis |
| `Alt+H` | Keyboard help |

---

## Architecture

Three runtime components communicate by message passing:

| Component | File | Responsibility |
|-----------|------|----------------|
| **Popup** | `popup/` | Collects the URL and AI settings, then hands off to the background worker. |
| **Background service worker** | `background/background.js` | All network logic — archive queries, snapshot selection, content fetching, the AI chain-of-verification, and report assembly. |
| **Content-script overlay** | `content/overlay.js` | The Shadow-DOM user interface — form, progress, multi-level report, keyboard navigation, and speech. |

**External interfaces:**

```
CDX index    GET  https://web.archive.org/cdx/search/cdx
Raw replay   GET  https://web.archive.org/web/<timestamp>id_/<url>
Groq         POST https://api.groq.com/openai/v1/chat/completions
Ollama       POST http://localhost:11434/api/chat
```

---

## Privacy & security

- The Groq API key is stored locally in `chrome.storage.local` and is sent only to Groq, only when that provider is selected.
- With **Ollama**, no captured text ever leaves your machine.
- Personal data is masked **before** text is sent to any model or shown on screen.
- The overlay is isolated in a Shadow DOM, so it neither inherits nor leaks the host page's styles.

---

## Limitations

- Accessibility metrics are **heuristic** counts over archived HTML — not a conformance test against a formal standard like WCAG.
- Snapshot selection is driven by byte-length jumps and even sampling, so a change that doesn't shift the page size much, or falls between sampled captures, can be missed.
- The analysis can only see what the Wayback Machine captured; capture gaps and incomplete replays bound what can be known (which is why uncertainty and replay status are reported, not hidden).
- Change detection relies on a language model. The chain-of-verification and independent quote check are designed to catch fabrication, but they **mitigate rather than eliminate** the risk — hence the explicit confidence and verification signals on every change.
- Collection mode is capped at eight URLs and five sampled captures per URL, so first-appearance dates are approximate to the sampling resolution.

---

## Project structure

```
TimeTravel/
├── manifest.json              # MV3 manifest: permissions, scripts, toggle command
├── background/
│   └── background.js          # Pipeline orchestration, CDX, fetching, AI CoVe, report build
├── content/
│   └── overlay.js             # Shadow-DOM overlay, 5-level report, a11y, keyboard, speech
├── popup/
│   ├── popup.html             # Toolbar popup UI
│   ├── popup.js               # Settings + launch handoff
│   └── popup.css
└── icons/
    └── icon16.png
```

---
