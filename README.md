# Webber

A Chromium-based browser that just feels clean. Built on Electron.

- **Vertical tabs in a sidebar**, with the page as a rounded card inside a thin frame. The current tab has an accent stripe; back, forward and reload sit at the bottom.
- **Pinned tabs** sit as a row of round icons at the top of the sidebar. Right-click a tab and choose Pin, or drag it up there.
- **Drop-down address bar.** `Ctrl+L` or `Ctrl+T` slides a bar down from the top of the page that suggests your open tabs and history as you type.
- **Compact mode** (`Ctrl+B`) hides the sidebar. Move the mouse to the left edge of the window to bring it back over the page.
- **Uses your Omarchy theme.** See below.
- **Blocks ads and trackers** out of the box (Ghostery's engine). The shield shows how many requests were blocked; click it to turn blocking off.
- **Calm pages.** A new tab is a clock. A failed load is a sentence and a "Try again" button, not a wall of text.
- **Without Omarchy**, it follows your system's light or dark mode.
- **Remembers your tabs** between launches.

## Omarchy themes

Webber reads the active theme from `~/.config/omarchy/current/theme/colors.toml`:

- `background` becomes the frame and sidebar color.
- `foreground` becomes the text color.
- `accent` becomes the highlight color.

Themes that only have an `alacritty.toml` work too. A `light.mode` file makes everything light, including what websites see as your light/dark preference.

When you switch themes (`omarchy-theme-set`, or the Omarchy menu), Webber changes with it right away. You don't need to restart. Under Hyprland the in-app window buttons are hidden, because the window manager handles windows.

## Let Claude use Webber

Webber has a built-in Claude connector (an MCP server). With it, Claude can work in your real tabs, signed in as you. It can open and switch tabs, read pages, click, type, fill in forms, scroll, take screenshots and search your history.

It is **off until you turn it on**:

1. Click the ✳ button at the bottom of the sidebar.
2. Choose **Let Claude Use Webber**.
3. Connect Claude using one of the options below.

**Claude Code:** choose **Copy Setup Command for Claude Code** from the same menu and run it in your terminal. It looks like this:

```bash
claude mcp add --transport http webber http://127.0.0.1:47823/mcp --header "Authorization: Bearer <your key>"
```

**Claude Desktop:** choose **Copy Config for Claude Desktop** and paste it into `claude_desktop_config.json`. It runs `bin/webber-mcp.js` (needs Node 18+), which passes messages between Claude Desktop and the running Webber app.

While Claude is working in a tab, that tab's icon pulses and the page gets an accent-colored border.

**How it's secured**
- It listens only on `127.0.0.1`, so other machines can't reach it.
- Every request needs your access key, which is stored in Webber's `connector.json` (readable only by you).
- Requests coming from web pages are refused, so a website can't take over your browser.
- **Reset Access Key** in the menu cuts off every client that has the old key.

Clicking and typing bring that tab to the front, so you can watch. One tool runs JavaScript in the page; Claude only uses it when the other tools can't do the job. The port can be changed with `WEBBER_MCP_PORT`.

The connectors you add at claude.ai run in Anthropic's cloud and can't reach a browser on your computer. Use Claude Code or Claude Desktop for this.

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
| Toggle sidebar (compact mode) | `Ctrl+B` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+Alt+↓` / `Ctrl+Alt+↑` |
| Jump to tab | `Ctrl+1` … `Ctrl+9` |
| Back / forward | `Alt+←` / `Alt+→` (`⌘[` / `⌘]`) |
| Reload / hard reload | `Ctrl+R` / `Ctrl+Shift+R` |
| Find in page | `Ctrl+F` |
| Zoom | `Ctrl+=`, `Ctrl+-`, `Ctrl+0` |
| Full screen | `F11` |
| Developer tools | `F12` |

Middle-click a tab to close it. Drag tabs to reorder them. Right-click a tab to pin, mute or duplicate it.

## Layout

```
src/main.js      window, tabs, shortcuts, history, content blocking, session restore
src/theme.js     reads and watches the Omarchy theme
src/connector.js the Claude connector (MCP server and its browser tools)
bin/webber-mcp.js  bridge for Claude Desktop (stdio to the connector)
src/preload.js   the small bridge between the browser UI and the main process
src/ui/          the sidebar, frame, floating address bar and find bar (HTML/CSS/JS)
src/pages/       the new tab page and the error page
```

Searches go to DuckDuckGo. To change that, edit `SEARCH_URL` in `src/main.js`.
