# Webber

A Chromium-based browser that just feels clean. Built on Electron.

- **Quiet chrome.** One tab strip, one toolbar. The address bar shows only the site's name until you click it.
- **Blocks ads and trackers** out of the box (Ghostery's engine). The shield shows how many requests were blocked; click it to turn blocking off.
- **Calm pages.** A new tab is a clock. A failed load is a sentence and a "Try again" button, not a wall of text.
- **Follows your system's light or dark mode.**
- **Remembers your tabs** between launches.

## Run it

```bash
npm install
```

```bash
npm start
```

## Build an installer

```bash
npm run dist
```

## Shortcuts

`Ctrl` is `⌘` on macOS.

| | |
|---|---|
| New tab / window | `Ctrl+T` / `Ctrl+N` |
| Close tab | `Ctrl+W` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Address bar | `Ctrl+L`, `Alt+D`, `F6` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Jump to tab | `Ctrl+1` … `Ctrl+9` |
| Back / forward | `Alt+←` / `Alt+→` (`⌘[` / `⌘]`) |
| Reload / hard reload | `Ctrl+R` / `Ctrl+Shift+R` |
| Find in page | `Ctrl+F` |
| Zoom | `Ctrl+=`, `Ctrl+-`, `Ctrl+0` |
| Full screen | `F11` |
| Developer tools | `F12` |

Middle-click a tab to close it. Drag tabs to reorder them. Double-click empty tab-strip space for a new tab. Right-click a tab for more.

## Layout

```
src/main.js      window, tabs, shortcuts, content blocking, session restore
src/preload.js   the small bridge between the toolbar UI and the main process
src/ui/          the tab strip and toolbar (HTML/CSS/JS)
src/pages/       the new tab page and the error page
```

Searches go to DuckDuckGo. To change that, edit `SEARCH_URL` in `src/main.js`.
