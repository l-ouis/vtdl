import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

import { livePreview, toggleLineCheckbox } from "./live-preview";

type DailyEntry = { date: string; text: string };
type NotebookView = {
  version: number;
  today_date: string;
  today: string;
  history: DailyEntry[];
};
type SyncStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "synced"; version: number }
  | { kind: "error"; message: string }
  | { kind: "not_configured" };
type SetupStatus = {
  configured: boolean;
  server_url: string | null;
  account_id: string | null;
  api_token: string | null;
};
type ServerInfo = {
  service: string;
  version: string;
  history_days?: number;
  allow_registration?: boolean;
};
type AppMode = "setup" | "configured" | "offline";

const OFFLINE_KEY = "vtdl-offline-mode";
const BG_COLOR_KEY = "vtdl-bg-color";
const FG_COLOR_KEY = "vtdl-fg-color";
const ACCENT_COLOR_KEY = "vtdl-accent-color";
const HIDE_FIRST_SPACE_KEY = "vtdl-hide-first-space";
const CARET_STYLE_KEY = "vtdl-caret-style";
const CARET_BLINK_KEY = "vtdl-caret-blink";
type CaretStyle = "bar" | "underscore" | "block";
const DEFAULT_CARET_STYLE: CaretStyle = "bar";
const COLUMNS_MODE_KEY = "vtdl-columns-mode";
const COLUMN_WIDTH_KEY = "vtdl-column-width";
const HISTORY_HIDDEN_KEY = "vtdl-history-hidden";
const GLOBAL_SHORTCUT_KEY = "vtdl-global-shortcut";
const SOFT_CLOSE_KEY = "vtdl-soft-close-shortcut";
const HARD_QUIT_KEY = "vtdl-hard-quit-shortcut";
const COL_INC_KEY = "vtdl-col-inc-shortcut";
const COL_DEC_KEY = "vtdl-col-dec-shortcut";
const HISTORY_SHORTCUT_KEY = "vtdl-history-shortcut";
const OPTIONS_SHORTCUT_KEY = "vtdl-options-shortcut";
const SETTINGS_SHORTCUT_KEY = "vtdl-settings-shortcut";
const CHECK_LINE_SHORTCUT_KEY = "vtdl-check-line-shortcut";
const COLUMNS_TOGGLE_SHORTCUT_KEY = "vtdl-columns-toggle-shortcut";
const TABS_ENABLED_KEY = "vtdl-tabs-enabled";
const ACTIVE_TAB_KEY = "vtdl-active-tab";
const TABS_TOGGLE_SHORTCUT_KEY = "vtdl-tabs-toggle-shortcut";
const TAB_SHORTCUT_KEYS = [1, 2, 3, 4, 5].map(i => `vtdl-tab-${i}-shortcut`);
const TAB_NEXT_SHORTCUT_KEY = "vtdl-tab-next-shortcut";
const TAB_PREV_SHORTCUT_KEY = "vtdl-tab-prev-shortcut";
const DEFAULT_SOFT_CLOSE = "Ctrl+W";
const DEFAULT_HARD_QUIT = "Ctrl+Q";
const DEFAULT_COL_INC = "Ctrl+Shift+=";
const DEFAULT_COL_DEC = "Ctrl+Shift+-";
const DEFAULT_HISTORY_SHORTCUT = "Ctrl+H";
const DEFAULT_OPTIONS_SHORTCUT = "Ctrl+O";
const DEFAULT_SETTINGS_SHORTCUT = "Ctrl+P";
const DEFAULT_CHECK_LINE_SHORTCUT = "Ctrl+Space";
const DEFAULT_COLUMNS_TOGGLE_SHORTCUT = "Ctrl+Shift+C";
const DEFAULT_TABS_TOGGLE_SHORTCUT = "Ctrl+Shift+H";
const DEFAULT_TAB_SHORTCUTS = ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5"];
const DEFAULT_TAB_NEXT_SHORTCUT = "Ctrl+Shift+]";
const DEFAULT_TAB_PREV_SHORTCUT = "Ctrl+Shift+[";
// A line containing `` `newtab` `` ends a tab; the next line starts a new one.
const NEWTAB_LINE_RE = /`\s*newtab\s*`/;

interface TabSection {
  contentLines: string[];
}
const COL_WIDTH_STEP = 10;
const DEFAULT_COLUMN_WIDTH = 280;
const MIN_COLUMN_WIDTH = 100;
const MAX_COLUMN_WIDTH = 1200;
const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Normalize "fff" / "#fff" / "FFFFFF" → "#ffffff" (lowercased, leading #).
 *  Returns null if input doesn't match. */
function normalizeHex(s: string): string | null {
  const m = s.trim().match(HEX_RE);
  if (!m) return null;
  return "#" + m[1].toLowerCase();
}

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("sync-status");
const todoCountEl = $("todo-count");
const statusBar = $("status-bar");
const editorRoot = $("editor");
const historyRoot = $("history");
const todayDateEl = $("today-date-text");

// Setup overlay
const setupOverlay = $("setup-overlay");
const setupChoose = $("setup-choose");
const setupServer = $("setup-server") as HTMLInputElement;
const setupPingBtn = $("setup-ping") as HTMLButtonElement;
const setupPingStatus = $("setup-ping-status");
const setupOffline = $("setup-offline");
const setupForm = $("setup-form") as HTMLFormElement;
const setupFormServer = $("setup-form-server");
const setupAccount = $("setup-account") as HTMLInputElement;
const setupToken = $("setup-token") as HTMLInputElement;
const setupPassphrase = $("setup-passphrase") as HTMLInputElement;
const setupError = $("setup-error");
const setupBack = $("setup-back");
const setupSubmit = $("setup-submit") as HTMLButtonElement;
const modeButtons = document.querySelectorAll<HTMLButtonElement>(
  ".mode-choose button[data-mode]",
);
const joinOnlyLabels = document.querySelectorAll<HTMLElement>(".join-only");

// Options overlay
const optionsBtn = $("options-btn");
const historyBtn = $("history-btn");
const optionsOverlay = $("options-overlay");
const optionsClose = $("options-close");
const optionsBg = $("options-bg") as HTMLInputElement;
const optionsBgSwatch = $("options-bg-swatch");
const optionsBgReset = $("options-bg-reset");
const optionsFg = $("options-fg") as HTMLInputElement;
const optionsFgSwatch = $("options-fg-swatch");
const optionsFgReset = $("options-fg-reset");
const optionsAccent = $("options-accent") as HTMLInputElement;
const optionsAccentSwatch = $("options-accent-swatch");
const optionsAccentReset = $("options-accent-reset");
const optionsHideSpace = $("options-hide-space") as HTMLInputElement;
const optionsCaretStyleRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="caret-style"]',
);
const optionsCaretBlink = $("options-caret-blink") as HTMLInputElement;
const optionsColumns = $("options-columns") as HTMLInputElement;
const optionsColumnWidth = $("options-column-width") as HTMLInputElement;
const optionsShortcut = $("options-shortcut") as HTMLButtonElement;
const optionsShortcutClear = $("options-shortcut-clear") as HTMLButtonElement;
const optionsShortcutHelp = $("options-shortcut-help") as HTMLButtonElement;
const optionsSoftClose = $("options-soft-close") as HTMLButtonElement;
const optionsSoftCloseReset = $("options-soft-close-reset") as HTMLButtonElement;
const optionsHardQuit = $("options-hard-quit") as HTMLButtonElement;
const optionsHardQuitReset = $("options-hard-quit-reset") as HTMLButtonElement;
const optionsColInc = $("options-col-inc") as HTMLButtonElement;
const optionsColIncReset = $("options-col-inc-reset") as HTMLButtonElement;
const optionsColDec = $("options-col-dec") as HTMLButtonElement;
const optionsColDecReset = $("options-col-dec-reset") as HTMLButtonElement;
const optionsHistoryShortcut = $("options-shortcut-history") as HTMLButtonElement;
const optionsHistoryShortcutReset = $("options-shortcut-history-reset") as HTMLButtonElement;
const optionsOptionsShortcut = $("options-shortcut-options") as HTMLButtonElement;
const optionsOptionsShortcutReset = $("options-shortcut-options-reset") as HTMLButtonElement;
const optionsSettingsShortcut = $("options-shortcut-settings") as HTMLButtonElement;
const optionsSettingsShortcutReset = $("options-shortcut-settings-reset") as HTMLButtonElement;
const optionsCheckLineShortcut = $("options-shortcut-check-line") as HTMLButtonElement;
const optionsCheckLineShortcutReset = $("options-shortcut-check-line-reset") as HTMLButtonElement;
const optionsColumnsToggleShortcut = $("options-shortcut-columns") as HTMLButtonElement;
const optionsColumnsToggleShortcutReset = $("options-shortcut-columns-reset") as HTMLButtonElement;
const optionsTabsEnabled = $("options-tabs-enabled") as HTMLInputElement;
const optionsTabsToggleShortcut = $("options-shortcut-tabs-toggle") as HTMLButtonElement;
const optionsTabsToggleShortcutReset = $("options-shortcut-tabs-toggle-reset") as HTMLButtonElement;
const optionsTabShortcuts = [1, 2, 3, 4, 5].map(
  i => $(`options-shortcut-tab-${i}`) as HTMLButtonElement,
);
const optionsTabShortcutResets = [1, 2, 3, 4, 5].map(
  i => $(`options-shortcut-tab-${i}-reset`) as HTMLButtonElement,
);
const optionsTabNextShortcut = $("options-shortcut-tab-next") as HTMLButtonElement;
const optionsTabNextShortcutReset = $("options-shortcut-tab-next-reset") as HTMLButtonElement;
const optionsTabPrevShortcut = $("options-shortcut-tab-prev") as HTMLButtonElement;
const optionsTabPrevShortcutReset = $("options-shortcut-tab-prev-reset") as HTMLButtonElement;
const tabBarEl = $("tab-bar");
const shortcutHelpOverlay = $("shortcut-help-overlay");
const shortcutHelpClose = $("shortcut-help-close");

// Settings overlay
const settingsOverlay = $("settings-overlay");
const settingsAccountPanel = $("settings-account-panel");
const settingsOfflinePanel = $("settings-offline-panel");
const settingsServerEl = $("settings-server");
const settingsAccountEl = $("settings-account");
const settingsTokenEl = $("settings-token");
const settingsBtn = $("settings-btn");
const settingsClose = $("settings-close");
const settingsCloseOffline = $("settings-close-offline");
const settingsConnect = $("settings-connect");
const settingsLogout = $("settings-logout");
const signoutOverlay = $("signout-overlay");
const settingsSignoutCancel = $("settings-signout-cancel");
const settingsSignoutGo = $("settings-signout-go") as HTMLButtonElement;
const settingsSignoutError = $("settings-signout-error");
const settingsDelete = $("settings-delete");
const settingsDeleteConfirm = $("settings-delete-confirm");
const settingsDeleteInput = $("settings-delete-input") as HTMLInputElement;
const settingsDeleteGo = $("settings-delete-go") as HTMLButtonElement;
const settingsDeleteCancel = $("settings-delete-cancel");
const settingsDeleteError = $("settings-delete-error");
const copyTokenBtn = $("copy-token");
const revealTokenBtn = $("reveal-token") as HTMLButtonElement;

const TOKEN_MASK = "••••••••••••••••";
let tokenRevealed = false;

let todayView: EditorView | null = null;
let columnViews: EditorView[] = [];
let historyViews: EditorView[] = [];
let saveTimer: number | null = null;
let suppressSave = false;

let appMode: AppMode = "setup";
let pingVerifiedUrl: string | null = null;
let pingAllowRegistration = true;
let pingHistoryDays = 0;
let setupMode: "create" | "join" = "create";
let hideFirstSpaceFlag = false;
let caretStyle: CaretStyle = DEFAULT_CARET_STYLE;
let caretBlink = true;
let columnsMode = false;
let columnWidth = DEFAULT_COLUMN_WIDTH;
let historyHidden = false;
let currentShortcut: string | null = null;
let recordingShortcut = false;
let softCloseShortcut: string = DEFAULT_SOFT_CLOSE;
let hardQuitShortcut: string = DEFAULT_HARD_QUIT;
let colIncShortcut: string = DEFAULT_COL_INC;
let colDecShortcut: string = DEFAULT_COL_DEC;
let historyShortcut: string = DEFAULT_HISTORY_SHORTCUT;
let optionsShortcutCombo: string = DEFAULT_OPTIONS_SHORTCUT;
let settingsShortcut: string = DEFAULT_SETTINGS_SHORTCUT;
let checkLineShortcut: string = DEFAULT_CHECK_LINE_SHORTCUT;
let columnsToggleShortcut: string = DEFAULT_COLUMNS_TOGGLE_SHORTCUT;
let tabsEnabled = true;
let tabSections: TabSection[] = [];
let activeTabIndex = 0;
let tabsToggleShortcut: string = DEFAULT_TABS_TOGGLE_SHORTCUT;
let tabShortcuts: string[] = [...DEFAULT_TAB_SHORTCUTS];
let tabNextShortcut: string = DEFAULT_TAB_NEXT_SHORTCUT;
let tabPrevShortcut: string = DEFAULT_TAB_PREV_SHORTCUT;
let currentStatus: SetupStatus = {
  configured: false,
  server_url: null,
  account_id: null,
  api_token: null,
};

// ---------- editor + sync plumbing (unchanged) ----------

/** The editor only shows the *active tab's* contents. This wraps the editor
 *  text back into the full notebook string and debounces the save. If the
 *  user's edit added or removed a `newtab` marker, also reconciles the tab
 *  structure (split / merge active tab + re-mount). */
function persistEditorChange(editorText: string) {
  if (tabSections.length === 0) {
    tabSections = [{ contentLines: editorText.split("\n") }];
  } else {
    tabSections[activeTabIndex].contentLines = editorText.split("\n");
  }
  const fullText = composeTabs(tabSections);
  updateTodoCount(fullText);

  // Detect a structural change (newtab count differs from what the current
  // tab layout implies). Re-mount asynchronously so we don't tear down the
  // editor view from inside its own update listener.
  if (tabsEnabled) {
    const reparsed = parseTabs(fullText);
    if (reparsed.length !== tabSections.length) {
      setTimeout(() => reconcileTabStructure(reparsed), 0);
    }
  }

  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    invoke("save_today", { text: composeTabs(tabSections) }).catch((e) =>
      setStatus({ kind: "error", message: String(e) }),
    );
  }, 350);
}

/** Swap in a freshly-parsed tab layout and re-mount the editor, preserving
 *  the caret offset within the (possibly merged or truncated) active tab. */
function reconcileTabStructure(newSections: TabSection[]) {
  const cursor = currentEditorOffset();
  activeTabIndex = Math.min(activeTabIndex, newSections.length - 1);
  if (activeTabIndex < 0) activeTabIndex = 0;
  tabSections = newSections;
  destroyMainEditor();
  mountActiveEditor();
  setCursorAt(cursor);
  renderTabBar();
}

/** Caret offset within the currently-mounted editor's content (recomposed
 *  across columns when in columns mode). 0 if no editor is focused. */
function currentEditorOffset(): number {
  if (todayView) return todayView.state.selection.main.head;
  if (columnViews.length === 0) return 0;
  let pos = 0;
  for (const v of columnViews) {
    if (v.hasFocus) return pos + v.state.selection.main.head;
    pos += v.state.doc.length + 1; // join separator
  }
  return 0;
}

function setCursorAt(offset: number) {
  if (todayView) {
    const len = todayView.state.doc.length;
    todayView.dispatch({
      selection: { anchor: Math.max(0, Math.min(offset, len)) },
    });
    todayView.focus();
    return;
  }
  if (columnViews.length === 0) return;
  let remaining = Math.max(0, offset);
  for (const v of columnViews) {
    const len = v.state.doc.length;
    if (remaining <= len) {
      v.dispatch({ selection: { anchor: remaining } });
      v.focus();
      return;
    }
    remaining -= len + 1;
  }
  const last = columnViews[columnViews.length - 1];
  last.dispatch({ selection: { anchor: last.state.doc.length } });
  last.focus();
}

function setStatus(s: SyncStatus) {
  if (appMode === "offline") {
    statusEl.textContent = "offline";
    statusBar.classList.remove("error");
    return;
  }
  statusBar.classList.toggle("error", s.kind === "error");
  switch (s.kind) {
    case "idle": statusEl.textContent = "idle"; break;
    case "busy": statusEl.textContent = "syncing…"; break;
    case "synced": statusEl.textContent = `synced · v${s.version}`; break;
    case "error": statusEl.textContent = `error: ${s.message}`; break;
    case "not_configured": statusEl.textContent = "not configured"; break;
  }
}

const TODO_RE = /^\s*\[( |x|X)?\]/;
function updateTodoCount(text: string) {
  let total = 0;
  let done = 0;
  for (const line of text.split("\n")) {
    const m = line.match(TODO_RE);
    if (m) {
      total++;
      if (m[1] === "x" || m[1] === "X") done++;
    }
  }
  todoCountEl.textContent = total === 0 ? "" : `${done}/${total} todo`;
}

const baseTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--fg)",
    fontSize: "var(--editor-font-size)",
  },
  ".cm-scroller": {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    lineHeight: "1.55",
    padding: "12px 18px",
  },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 2px" },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2.5px",
    transform: "scaleY(0.82)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--accent-soft) !important" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

function createTodayView(initial: string): EditorView {
  return new EditorView({
    parent: editorRoot,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        drawSelection({ cursorBlinkRate: caretBlink ? 1200 : 0 }),
        highlightActiveLine(),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        livePreview({ hideFirstSpace: hideFirstSpaceFlag }),
        baseTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressSave) {
            persistEditorChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });
}

// ---------- columns view ----------

/** Split today's text into sections at every `# ` line. Each returned string
 *  is one section (header line included, or pre-H1 content for the first).
 *  Filters out an empty pre-H1 section when other sections exist. */
function splitByH1(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (sections.length > 0 || buf.length > 0) {
        sections.push(buf.join("\n"));
      }
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  sections.push(buf.join("\n"));
  if (sections.length > 1 && sections[0].trim() === "") sections.shift();
  if (sections.length === 0) sections.push("");
  return sections;
}

function recomposeColumns(): string {
  return columnViews.map((v) => v.state.doc.toString()).join("\n");
}

function createColumnView(initial: string, container: HTMLElement): EditorView {
  const wrap = document.createElement("div");
  wrap.className = "column";
  wrap.style.width = `${columnWidth}px`;
  container.appendChild(wrap);
  return new EditorView({
    parent: wrap,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        drawSelection({ cursorBlinkRate: caretBlink ? 1200 : 0 }),
        highlightActiveLine(),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        livePreview({ hideFirstSpace: hideFirstSpaceFlag }),
        baseTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressSave) {
            const text = recomposeColumns();
            persistEditorChange(text);
            maybeResplit(text);
          }
        }),
      ],
    }),
  });
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

/** Build absolute cursor offset in the recomposed text from whichever
 *  column currently has focus. Returns null if no column is focused. */
function getAbsoluteCursor(): number | null {
  for (let i = 0; i < columnViews.length; i++) {
    const v = columnViews[i];
    if (!v.hasFocus) continue;
    let pos = 0;
    for (let j = 0; j < i; j++) {
      pos += columnViews[j].state.doc.length + 1; // +1 for the join separator
    }
    return pos + v.state.selection.main.head;
  }
  return null;
}

/** Locate which new section the absolute offset falls into, plus the local
 *  offset within that section. Clamps to end of last section if past EOF. */
function findColumnAndOffset(
  sections: string[],
  abs: number,
): { idx: number; offset: number } {
  let pos = 0;
  for (let i = 0; i < sections.length; i++) {
    const len = sections[i].length;
    if (abs >= pos && abs <= pos + len) return { idx: i, offset: abs - pos };
    pos += len + 1;
  }
  const last = sections.length - 1;
  return { idx: last, offset: sections[last]?.length ?? 0 };
}

/** Re-split the today text into columns if the H1 structure has changed
 *  (new H1 typed, existing H1 deleted, headers reordered). Preserves the
 *  user's cursor by absolute offset in the recomposed text. */
function maybeResplit(text: string) {
  if (!columnsMode) return;
  const newSections = splitByH1(text);
  let changed = newSections.length !== columnViews.length;
  if (!changed) {
    for (let i = 0; i < newSections.length; i++) {
      if (firstLine(newSections[i]) !== firstLine(columnViews[i].state.doc.toString())) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;

  const abs = getAbsoluteCursor();

  for (const v of columnViews) v.destroy();
  columnViews = [];
  editorRoot.innerHTML = "";
  editorRoot.classList.add("columns-mode");
  const container = document.createElement("div");
  container.id = "columns-container";
  editorRoot.appendChild(container);
  columnViews = newSections.map((s) => createColumnView(s, container));

  if (abs !== null) {
    const target = findColumnAndOffset(newSections, abs);
    const v = columnViews[target.idx];
    if (v) {
      v.dispatch({ selection: { anchor: target.offset } });
      v.focus();
      // Scroll the focused column into view horizontally so the user can
      // see where the cursor went (new columns spawned by typing `# X`
      // can land off the right edge of the viewport).
      const wrap = v.dom.parentElement;
      if (wrap) wrap.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }
}

function mountColumns(text: string) {
  const container = document.createElement("div");
  container.id = "columns-container";
  editorRoot.appendChild(container);
  editorRoot.classList.add("columns-mode");
  columnViews = splitByH1(text).map((s) => createColumnView(s, container));
}

function createHistoryView(text: string, container: HTMLElement): EditorView {
  return new EditorView({
    parent: container,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        livePreview({ readOnly: true, hideFirstSpace: hideFirstSpaceFlag }),
        baseTheme,
      ],
    }),
  });
}

function formatHistoryDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return `${dt.getDate()} ${dt.toLocaleString(undefined, { month: "long" })} ${dt.getFullYear()}`;
}

function renderHistory(history: DailyEntry[]) {
  for (const v of historyViews) v.destroy();
  historyViews = [];
  historyRoot.innerHTML = "";
  for (const entry of history) {
    const wrap = document.createElement("div");
    wrap.className = "history-entry";
    const dateEl = document.createElement("div");
    dateEl.className = "note-date";
    dateEl.textContent = formatHistoryDate(entry.date);
    wrap.appendChild(dateEl);
    const content = document.createElement("div");
    content.className = "history-content";
    wrap.appendChild(content);
    historyRoot.appendChild(wrap);
    historyViews.push(createHistoryView(entry.text, content));
  }
}

function formatDate(d: Date): string {
  return `${d.getDate()} ${d.toLocaleString(undefined, { month: "long" })} ${d.getFullYear()}`;
}

// ---------- font sizing ----------

const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 36;
const FONT_STORAGE_KEY = "vtdl-font-size";
let fontSize = DEFAULT_FONT_SIZE;

function loadFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
    }
  } catch {}
  return DEFAULT_FONT_SIZE;
}

function applyFontSize(px: number) {
  fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, px));
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  try { localStorage.setItem(FONT_STORAGE_KEY, String(fontSize)); } catch {}
  todayView?.requestMeasure();
  for (const v of historyViews) v.requestMeasure();
}

// ---------- tabs ----------

/** A line containing the `newtab` tag ends a tab — it stays in the current
 *  tab's contentLines (so the diamond marker renders at the end of the tab)
 *  and the next line starts a new tab. */
function parseTabs(text: string): TabSection[] {
  const lines = text.split("\n");
  const sections: TabSection[] = [{ contentLines: [] }];
  for (const line of lines) {
    sections[sections.length - 1].contentLines.push(line);
    if (NEWTAB_LINE_RE.test(line)) {
      sections.push({ contentLines: [] });
    }
  }
  return sections;
}

function composeTabs(sections: TabSection[]): string {
  return sections.flatMap((s) => s.contentLines).join("\n");
}

function tabsActive(): boolean {
  return tabsEnabled && tabSections.length > 1;
}

function setupTabsForText(text: string) {
  if (!tabsEnabled) {
    tabSections = [{ contentLines: text.split("\n") }];
    return;
  }
  tabSections = parseTabs(text);
}

function activeTabText(): string {
  return tabSections[activeTabIndex]?.contentLines.join("\n") ?? "";
}

function renderTabBar() {
  tabBarEl.innerHTML = "";
  if (!tabsActive()) {
    tabBarEl.hidden = true;
    return;
  }
  for (let i = 0; i < tabSections.length; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-dot";
    if (i === activeTabIndex) btn.classList.add("active");
    btn.title = `Tab ${i + 1}`;
    btn.setAttribute("aria-label", `Tab ${i + 1}`);
    // Opt this element out of Tauri's drag-region (set on the parent #today-date)
    // so the click registers as a tab switch instead of a window drag.
    btn.setAttribute("data-tauri-drag-region", "false");
    btn.addEventListener("click", () => void switchTab(i));
    tabBarEl.appendChild(btn);
  }
  tabBarEl.hidden = false;
}

/** Capture the editor's current text back into the active tab so save and
 *  re-mount see the user's latest edits. */
function captureActiveTab() {
  if (tabSections.length === 0) return;
  const editorText = columnsMode && columnViews.length > 0
    ? recomposeColumns()
    : (todayView?.state.doc.toString() ?? "");
  tabSections[activeTabIndex].contentLines = editorText.split("\n");
}

async function switchTab(idx: number) {
  if (!tabsActive()) return;
  if (idx === activeTabIndex || idx < 0 || idx >= tabSections.length) return;
  captureActiveTab();
  activeTabIndex = idx;
  try { localStorage.setItem(ACTIVE_TAB_KEY, String(idx)); } catch {}
  destroyMainEditor();
  mountActiveEditor();
  renderTabBar();
}

function mountActiveEditor() {
  // Defensive cleanup: a parallel async path (e.g. `notebook-updated` firing
  // while `loadAndMountEditor` was awaiting `load_notebook`) might have
  // already mounted. Tear down first so we don't stack two editors.
  destroyMainEditor();
  const text = activeTabText();
  if (columnsMode) {
    mountColumns(text);
  } else {
    todayView = createTodayView(text);
  }
}

async function toggleTabs() {
  // Capture current state, recompose full text, swap mode, re-parse.
  captureActiveTab();
  const fullText = composeTabs(tabSections);
  tabsEnabled = !tabsEnabled;
  try {
    if (tabsEnabled) localStorage.removeItem(TABS_ENABLED_KEY);
    else localStorage.setItem(TABS_ENABLED_KEY, "0");
  } catch {}
  optionsTabsEnabled.checked = tabsEnabled;
  setupTabsForText(fullText);
  activeTabIndex = Math.min(Math.max(activeTabIndex, 0), tabSections.length - 1);
  destroyMainEditor();
  updateTodoCount(fullText);
  mountActiveEditor();
  renderTabBar();
}

// ---------- editor lifecycle ----------

async function loadAndMountEditor() {
  const initial = await invoke<NotebookView>("load_notebook");
  setupTabsForText(initial.today);
  if (activeTabIndex >= tabSections.length) activeTabIndex = 0;
  updateTodoCount(initial.today);
  mountActiveEditor();
  renderTabBar();
  renderHistory(initial.history);
}

/** Teardown for just the today/tab editor — leaves the rendered history
 *  alone. Used by tab switching and toggling, which only swap the active
 *  editor without touching the history list. */
function destroyMainEditor() {
  if (todayView) { todayView.destroy(); todayView = null; }
  for (const v of columnViews) v.destroy();
  columnViews = [];
  editorRoot.innerHTML = "";
  editorRoot.classList.remove("columns-mode");
  todoCountEl.textContent = "";
  tabBarEl.hidden = true;
  tabBarEl.innerHTML = "";
}

function destroyEditor() {
  destroyMainEditor();
  for (const v of historyViews) v.destroy();
  historyViews = [];
  historyRoot.innerHTML = "";
}

// ---------- options (color vars + advanced toggles) ----------

function loadColor(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v) return normalizeHex(v);
  } catch {}
  return null;
}

function saveColor(key: string, hex: string | null) {
  try {
    if (hex) localStorage.setItem(key, hex);
    else localStorage.removeItem(key);
  } catch {}
}

function applyColor(cssVar: string, swatch: HTMLElement, hex: string | null) {
  if (hex) {
    document.documentElement.style.setProperty(cssVar, hex);
    swatch.style.background = hex;
  } else {
    document.documentElement.style.removeProperty(cssVar);
    swatch.style.background = getComputedStyle(document.documentElement)
      .getPropertyValue(cssVar)
      .trim();
  }
}

function onColorInput(
  input: HTMLInputElement,
  swatch: HTMLElement,
  cssVar: string,
  storageKey: string,
) {
  const v = input.value.trim();
  if (v === "") return; // empty doesn't reset; use the Reset button
  const norm = normalizeHex(v);
  if (norm) {
    applyColor(cssVar, swatch, norm);
    saveColor(storageKey, norm);
  }
  // Invalid input: silently no-op (no error message).
}

function resetColor(
  input: HTMLInputElement,
  swatch: HTMLElement,
  cssVar: string,
  storageKey: string,
) {
  input.value = "";
  saveColor(storageKey, null);
  applyColor(cssVar, swatch, null);
}

function loadHideFirstSpace(): boolean {
  try { return localStorage.getItem(HIDE_FIRST_SPACE_KEY) === "1"; } catch { return false; }
}
function saveHideFirstSpace(v: boolean) {
  try {
    if (v) localStorage.setItem(HIDE_FIRST_SPACE_KEY, "1");
    else localStorage.removeItem(HIDE_FIRST_SPACE_KEY);
  } catch {}
}

async function setHideFirstSpace(v: boolean) {
  hideFirstSpaceFlag = v;
  saveHideFirstSpace(v);
  if (appMode !== "setup" && (todayView || columnViews.length > 0)) {
    destroyEditor();
    await loadAndMountEditor();
  }
}

function loadCaretStyle(): CaretStyle {
  try {
    const v = localStorage.getItem(CARET_STYLE_KEY);
    if (v === "bar" || v === "underscore" || v === "block") return v;
  } catch {}
  return DEFAULT_CARET_STYLE;
}
function applyCaretStyle(v: CaretStyle) {
  document.body.dataset.caretStyle = v;
}
function setCaretStyle(v: CaretStyle) {
  caretStyle = v;
  try { localStorage.setItem(CARET_STYLE_KEY, v); } catch {}
  applyCaretStyle(v);
}

function loadCaretBlink(): boolean {
  try {
    const v = localStorage.getItem(CARET_BLINK_KEY);
    if (v === "0") return false;
  } catch {}
  return true;
}
async function setCaretBlink(v: boolean) {
  caretBlink = v;
  try {
    if (v) localStorage.removeItem(CARET_BLINK_KEY);
    else localStorage.setItem(CARET_BLINK_KEY, "0");
  } catch {}
  // drawSelection's cursorBlinkRate is baked into the extension at view
  // creation; reload the editor to apply.
  if (appMode !== "setup" && (todayView || columnViews.length > 0)) {
    destroyEditor();
    await loadAndMountEditor();
  }
}

function loadColumnsMode(): boolean {
  try { return localStorage.getItem(COLUMNS_MODE_KEY) === "1"; } catch { return false; }
}
function saveColumnsMode(v: boolean) {
  try {
    if (v) localStorage.setItem(COLUMNS_MODE_KEY, "1");
    else localStorage.removeItem(COLUMNS_MODE_KEY);
  } catch {}
}
function loadColumnWidth(): number {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTH_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= MIN_COLUMN_WIDTH && n <= MAX_COLUMN_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_COLUMN_WIDTH;
}
function saveColumnWidth(n: number) {
  try { localStorage.setItem(COLUMN_WIDTH_KEY, String(n)); } catch {}
}

async function setColumnsMode(v: boolean) {
  columnsMode = v;
  saveColumnsMode(v);
  if (appMode === "setup") return;
  destroyEditor();
  await loadAndMountEditor();
}

function loadHistoryHidden(): boolean {
  // Default: hidden. Only "0" (explicitly shown) returns false; legacy "1"
  // and missing key both keep the default.
  try { return localStorage.getItem(HISTORY_HIDDEN_KEY) !== "0"; } catch { return true; }
}
function saveHistoryHidden(v: boolean) {
  try {
    if (v) localStorage.removeItem(HISTORY_HIDDEN_KEY);
    else localStorage.setItem(HISTORY_HIDDEN_KEY, "0");
  } catch {}
}
function applyHistoryVisibility() {
  historyRoot.style.display = historyHidden ? "none" : "";
  historyBtn.classList.toggle("off", historyHidden);
  document.body.classList.toggle("history-hidden", historyHidden);
}
function toggleHistory() {
  historyHidden = !historyHidden;
  saveHistoryHidden(historyHidden);
  applyHistoryVisibility();
}

// ---------- global show/hide shortcut ----------

function loadShortcut(): string | null {
  try { return localStorage.getItem(GLOBAL_SHORTCUT_KEY); } catch { return null; }
}
function saveShortcut(s: string | null) {
  try {
    if (s) localStorage.setItem(GLOBAL_SHORTCUT_KEY, s);
    else localStorage.removeItem(GLOBAL_SHORTCUT_KEY);
  } catch {}
}

function shortcutButtonText(): string {
  if (recordingShortcut) return "Press combo… (Esc cancels)";
  if (currentShortcut) return currentShortcut;
  return "Click to record";
}

function refreshShortcutButton() {
  optionsShortcut.textContent = shortcutButtonText();
}

async function applyShortcut(combo: string | null) {
  if (combo) {
    try {
      await invoke("register_global_shortcut", { shortcut: combo });
      currentShortcut = combo;
      saveShortcut(combo);
    } catch (e) {
      currentShortcut = null;
      saveShortcut(null);
      alert(`Could not register shortcut "${combo}": ${e}`);
    }
  } else {
    try { await invoke("unregister_global_shortcut"); } catch {}
    currentShortcut = null;
    saveShortcut(null);
  }
  refreshShortcutButton();
}

// Shifted-punctuation pairs (US layout). We strip the Shift transformation so
// recorded combos describe the physical key (e.g. "Ctrl+Shift+]" not "Ctrl+Shift+}").
const SHIFTED_PUNCT: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=",
  "{": "[", "}": "]", "|": "\\",
  ":": ";", "\"": "'",
  "<": ",", ">": ".", "?": "/",
  "~": "`",
};

/** Map e.key to a stable label, normalizing shifted punctuation so the value
 *  shown to the user reflects the physical key pressed. */
function normalizeKey(e: KeyboardEvent): string {
  let key = e.key;
  if (e.shiftKey && SHIFTED_PUNCT[key] !== undefined) {
    key = SHIFTED_PUNCT[key];
  }
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function formatComboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  if (parts.length === 0) return null;
  parts.push(normalizeKey(e));
  return parts.join("+");
}

function startRecordingShortcut() {
  if (recordingShortcut) return;
  recordingShortcut = true;
  refreshShortcutButton();
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      finishRecording(onKey);
      return;
    }
    const combo = formatComboFromEvent(e);
    if (!combo) return; // wait for the modifier+key combo
    finishRecording(onKey);
    void applyShortcut(combo);
  };
  window.addEventListener("keydown", onKey, true);
}

function finishRecording(onKey: (e: KeyboardEvent) => void) {
  recordingShortcut = false;
  window.removeEventListener("keydown", onKey, true);
  refreshShortcutButton();
}

/** Compare a KeyboardEvent against a stored combo string like "Ctrl+Shift+W". */
function matchesShortcut(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split("+").map((p) => p.trim());
  const wantKey = parts[parts.length - 1];
  if (!wantKey) return false;
  const wantCtrl = parts.includes("Ctrl");
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  const wantSuper = parts.includes("Super");
  const evKey = normalizeKey(e);
  return (
    e.ctrlKey === wantCtrl &&
    e.shiftKey === wantShift &&
    e.altKey === wantAlt &&
    e.metaKey === wantSuper &&
    evKey === wantKey
  );
}

/** Record-then-store helper for in-app shortcuts (no Tauri command involved). */
function recordInAppShortcut(
  btn: HTMLButtonElement,
  onCaptured: (combo: string) => void,
) {
  const original = btn.textContent;
  btn.textContent = "Press combo… (Esc cancels)";
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      window.removeEventListener("keydown", onKey, true);
      btn.textContent = original;
      return;
    }
    const combo = formatComboFromEvent(e);
    if (!combo) return;
    window.removeEventListener("keydown", onKey, true);
    onCaptured(combo);
  };
  window.addEventListener("keydown", onKey, true);
}

function setSoftClose(combo: string) {
  softCloseShortcut = combo;
  try { localStorage.setItem(SOFT_CLOSE_KEY, combo); } catch {}
  optionsSoftClose.textContent = combo;
}
function resetSoftClose() {
  try { localStorage.removeItem(SOFT_CLOSE_KEY); } catch {}
  softCloseShortcut = DEFAULT_SOFT_CLOSE;
  optionsSoftClose.textContent = DEFAULT_SOFT_CLOSE;
}
function setHardQuit(combo: string) {
  hardQuitShortcut = combo;
  try { localStorage.setItem(HARD_QUIT_KEY, combo); } catch {}
  optionsHardQuit.textContent = combo;
}
function resetHardQuit() {
  try { localStorage.removeItem(HARD_QUIT_KEY); } catch {}
  hardQuitShortcut = DEFAULT_HARD_QUIT;
  optionsHardQuit.textContent = DEFAULT_HARD_QUIT;
}
function setColInc(combo: string) {
  colIncShortcut = combo;
  try { localStorage.setItem(COL_INC_KEY, combo); } catch {}
  optionsColInc.textContent = combo;
}
function resetColInc() {
  try { localStorage.removeItem(COL_INC_KEY); } catch {}
  colIncShortcut = DEFAULT_COL_INC;
  optionsColInc.textContent = DEFAULT_COL_INC;
}
function setColDec(combo: string) {
  colDecShortcut = combo;
  try { localStorage.setItem(COL_DEC_KEY, combo); } catch {}
  optionsColDec.textContent = combo;
}
function resetColDec() {
  try { localStorage.removeItem(COL_DEC_KEY); } catch {}
  colDecShortcut = DEFAULT_COL_DEC;
  optionsColDec.textContent = DEFAULT_COL_DEC;
}
function setHistoryShortcut(combo: string) {
  historyShortcut = combo;
  try { localStorage.setItem(HISTORY_SHORTCUT_KEY, combo); } catch {}
  optionsHistoryShortcut.textContent = combo;
}
function resetHistoryShortcut() {
  try { localStorage.removeItem(HISTORY_SHORTCUT_KEY); } catch {}
  historyShortcut = DEFAULT_HISTORY_SHORTCUT;
  optionsHistoryShortcut.textContent = DEFAULT_HISTORY_SHORTCUT;
}
function setOptionsShortcut(combo: string) {
  optionsShortcutCombo = combo;
  try { localStorage.setItem(OPTIONS_SHORTCUT_KEY, combo); } catch {}
  optionsOptionsShortcut.textContent = combo;
}
function resetOptionsShortcut() {
  try { localStorage.removeItem(OPTIONS_SHORTCUT_KEY); } catch {}
  optionsShortcutCombo = DEFAULT_OPTIONS_SHORTCUT;
  optionsOptionsShortcut.textContent = DEFAULT_OPTIONS_SHORTCUT;
}
function setSettingsShortcut(combo: string) {
  settingsShortcut = combo;
  try { localStorage.setItem(SETTINGS_SHORTCUT_KEY, combo); } catch {}
  optionsSettingsShortcut.textContent = combo;
}
function resetSettingsShortcut() {
  try { localStorage.removeItem(SETTINGS_SHORTCUT_KEY); } catch {}
  settingsShortcut = DEFAULT_SETTINGS_SHORTCUT;
  optionsSettingsShortcut.textContent = DEFAULT_SETTINGS_SHORTCUT;
}
function setCheckLineShortcut(combo: string) {
  checkLineShortcut = combo;
  try { localStorage.setItem(CHECK_LINE_SHORTCUT_KEY, combo); } catch {}
  optionsCheckLineShortcut.textContent = combo;
}
function resetCheckLineShortcut() {
  try { localStorage.removeItem(CHECK_LINE_SHORTCUT_KEY); } catch {}
  checkLineShortcut = DEFAULT_CHECK_LINE_SHORTCUT;
  optionsCheckLineShortcut.textContent = DEFAULT_CHECK_LINE_SHORTCUT;
}
function setColumnsToggleShortcut(combo: string) {
  columnsToggleShortcut = combo;
  try { localStorage.setItem(COLUMNS_TOGGLE_SHORTCUT_KEY, combo); } catch {}
  optionsColumnsToggleShortcut.textContent = combo;
}
function resetColumnsToggleShortcut() {
  try { localStorage.removeItem(COLUMNS_TOGGLE_SHORTCUT_KEY); } catch {}
  columnsToggleShortcut = DEFAULT_COLUMNS_TOGGLE_SHORTCUT;
  optionsColumnsToggleShortcut.textContent = DEFAULT_COLUMNS_TOGGLE_SHORTCUT;
}

function toggleOptions() {
  if (optionsOverlay.hidden) showOptions();
  else hideOptions();
}
function toggleSettings() {
  if (settingsOverlay.hidden) showSettings();
  else hideSettings();
}

function setTabsToggleShortcut(combo: string) {
  tabsToggleShortcut = combo;
  try { localStorage.setItem(TABS_TOGGLE_SHORTCUT_KEY, combo); } catch {}
  optionsTabsToggleShortcut.textContent = combo;
}
function resetTabsToggleShortcut() {
  try { localStorage.removeItem(TABS_TOGGLE_SHORTCUT_KEY); } catch {}
  tabsToggleShortcut = DEFAULT_TABS_TOGGLE_SHORTCUT;
  optionsTabsToggleShortcut.textContent = DEFAULT_TABS_TOGGLE_SHORTCUT;
}
function setTabShortcut(i: number, combo: string) {
  tabShortcuts[i] = combo;
  try { localStorage.setItem(TAB_SHORTCUT_KEYS[i], combo); } catch {}
  optionsTabShortcuts[i].textContent = combo;
}
function resetTabShortcut(i: number) {
  try { localStorage.removeItem(TAB_SHORTCUT_KEYS[i]); } catch {}
  tabShortcuts[i] = DEFAULT_TAB_SHORTCUTS[i];
  optionsTabShortcuts[i].textContent = DEFAULT_TAB_SHORTCUTS[i];
}
function setTabNextShortcut(combo: string) {
  tabNextShortcut = combo;
  try { localStorage.setItem(TAB_NEXT_SHORTCUT_KEY, combo); } catch {}
  optionsTabNextShortcut.textContent = combo;
}
function resetTabNextShortcut() {
  try { localStorage.removeItem(TAB_NEXT_SHORTCUT_KEY); } catch {}
  tabNextShortcut = DEFAULT_TAB_NEXT_SHORTCUT;
  optionsTabNextShortcut.textContent = DEFAULT_TAB_NEXT_SHORTCUT;
}
function setTabPrevShortcut(combo: string) {
  tabPrevShortcut = combo;
  try { localStorage.setItem(TAB_PREV_SHORTCUT_KEY, combo); } catch {}
  optionsTabPrevShortcut.textContent = combo;
}
function resetTabPrevShortcut() {
  try { localStorage.removeItem(TAB_PREV_SHORTCUT_KEY); } catch {}
  tabPrevShortcut = DEFAULT_TAB_PREV_SHORTCUT;
  optionsTabPrevShortcut.textContent = DEFAULT_TAB_PREV_SHORTCUT;
}

function nextTab() {
  if (!tabsActive()) return;
  void switchTab((activeTabIndex + 1) % tabSections.length);
}
function prevTab() {
  if (!tabsActive()) return;
  const n = tabSections.length;
  void switchTab((activeTabIndex - 1 + n) % n);
}

function checkCurrentLine() {
  let view: EditorView | null = null;
  if (todayView?.hasFocus) {
    view = todayView;
  } else {
    for (const v of columnViews) {
      if (v.hasFocus) { view = v; break; }
    }
  }
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  toggleLineCheckbox(view, line.number);
}

function setColumnWidth(px: number) {
  px = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, px));
  columnWidth = px;
  saveColumnWidth(px);
  for (const v of columnViews) {
    const wrap = v.dom.parentElement;
    if (wrap) wrap.style.width = `${px}px`;
    v.requestMeasure();
  }
}

function showOptions() {
  const bg = loadColor(BG_COLOR_KEY);
  const fg = loadColor(FG_COLOR_KEY);
  const accent = loadColor(ACCENT_COLOR_KEY);
  optionsBg.value = bg ?? "";
  optionsFg.value = fg ?? "";
  optionsAccent.value = accent ?? "";
  optionsBgSwatch.style.background =
    bg ?? getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  optionsFgSwatch.style.background =
    fg ?? getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
  optionsAccentSwatch.style.background =
    accent ?? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  optionsHideSpace.checked = hideFirstSpaceFlag;
  for (const r of optionsCaretStyleRadios) r.checked = r.value === caretStyle;
  optionsCaretBlink.checked = caretBlink;
  optionsColumns.checked = columnsMode;
  optionsColumnWidth.value = String(columnWidth);
  optionsTabsEnabled.checked = tabsEnabled;
  optionsOverlay.hidden = false;
}

function hideOptions() {
  optionsOverlay.hidden = true;
}

// ---------- offline-mode flag ----------

function isOfflineFlag(): boolean {
  try { return localStorage.getItem(OFFLINE_KEY) === "1"; } catch { return false; }
}
function setOfflineFlag(v: boolean) {
  try {
    if (v) localStorage.setItem(OFFLINE_KEY, "1");
    else localStorage.removeItem(OFFLINE_KEY);
  } catch {}
}

// ---------- setup overlay ----------

function showSetup() {
  setupOverlay.hidden = false;
  resetSetupForm();
}

function hideSetup() {
  setupOverlay.hidden = true;
}

function resetSetupForm() {
  setupForm.hidden = true;
  setupChoose.hidden = false;
  setupError.textContent = "";
  setupAccount.value = "";
  setupToken.value = "";
  setupPassphrase.value = "";
  for (const el of joinOnlyLabels) el.hidden = true;
  // keep the ping result; don't disable mode buttons that were enabled
}

function updateModeButtons() {
  const enabled = pingVerifiedUrl !== null;
  for (const b of modeButtons) {
    if (!enabled) {
      b.disabled = true;
      continue;
    }
    if (b.dataset.mode === "create" && !pingAllowRegistration) {
      b.disabled = true;
      b.title = "This server has paused new account registration";
    } else {
      b.disabled = false;
      b.title = "";
    }
  }
}

async function pingServer() {
  pingVerifiedUrl = null;
  updateModeButtons();
  setupPingStatus.classList.remove("ok", "error");
  const url = setupServer.value.trim();
  if (!url) {
    setupPingStatus.textContent = "enter a URL first";
    setupPingStatus.classList.add("error");
    return;
  }
  setupPingStatus.textContent = "pinging…";
  setupPingBtn.disabled = true;
  try {
    const info = await invoke<ServerInfo>("ping_server", { url });
    pingVerifiedUrl = url.replace(/\/+$/, "");
    pingAllowRegistration = info.allow_registration ?? true;
    pingHistoryDays = info.history_days ?? 0;
    const parts = [`✓ vtdl server v${info.version}`];
    if (pingHistoryDays > 0) parts.push(`history limit: ${pingHistoryDays}d`);
    if (!pingAllowRegistration) parts.push("registration paused");
    setupPingStatus.textContent = parts.join(" · ");
    setupPingStatus.classList.add("ok");
  } catch (e) {
    setupPingStatus.textContent = String(e);
    setupPingStatus.classList.add("error");
  } finally {
    setupPingBtn.disabled = false;
    updateModeButtons();
  }
}

function chooseSetupMode(mode: "create" | "join") {
  if (!pingVerifiedUrl) return;
  setupMode = mode;
  setupChoose.hidden = true;
  setupForm.hidden = false;
  setupError.textContent = "";
  setupFormServer.textContent = pingVerifiedUrl;
  for (const el of joinOnlyLabels) el.hidden = mode !== "join";
  setupToken.required = mode === "join";
  setupSubmit.textContent = mode === "create" ? "Create account" : "Link";
  setupAccount.focus();
}

async function submitSetup(e: Event) {
  e.preventDefault();
  setupError.textContent = "";
  setupSubmit.disabled = true;
  try {
    const args = {
      server_url: pingVerifiedUrl ?? setupServer.value.trim(),
      account_id: setupAccount.value.trim(),
      passphrase: setupPassphrase.value,
    };
    let status: SetupStatus;
    if (setupMode === "create") {
      status = await invoke<SetupStatus>("create_account", { args });
    } else {
      status = await invoke<SetupStatus>("join_account", {
        args: { ...args, api_token: setupToken.value.trim() },
      });
    }
    currentStatus = status;
    setOfflineFlag(false);
    appMode = "configured";
    hideSetup();
    destroyEditor();
    await loadAndMountEditor();
  } catch (err) {
    setupError.textContent = String(err);
  } finally {
    setupSubmit.disabled = false;
  }
}

async function useOffline() {
  setOfflineFlag(true);
  appMode = "offline";
  hideSetup();
  await loadAndMountEditor();
  setStatus({ kind: "idle" }); // forces "offline" label via appMode check
}

// ---------- settings overlay ----------

function renderToken() {
  if (!currentStatus.api_token) {
    settingsTokenEl.textContent = "";
    return;
  }
  settingsTokenEl.textContent = tokenRevealed
    ? currentStatus.api_token
    : TOKEN_MASK;
}

function setTokenRevealed(v: boolean) {
  tokenRevealed = v;
  revealTokenBtn.dataset.revealed = String(v);
  renderToken();
}

function showSettings() {
  if (appMode === "configured") {
    settingsAccountPanel.hidden = false;
    settingsOfflinePanel.hidden = true;
    settingsServerEl.textContent = currentStatus.server_url ?? "";
    settingsAccountEl.textContent = currentStatus.account_id ?? "";
    setTokenRevealed(false);
    settingsDeleteConfirm.hidden = true;
    settingsDeleteInput.value = "";
    settingsDeleteError.textContent = "";
    settingsDeleteGo.disabled = true;
    signoutOverlay.hidden = true;
    settingsSignoutError.textContent = "";
    settingsSignoutGo.disabled = false;
  } else if (appMode === "offline") {
    settingsAccountPanel.hidden = true;
    settingsOfflinePanel.hidden = false;
  } else {
    // shouldn't happen — settings button hidden during setup
    return;
  }
  settingsOverlay.hidden = false;
}

function hideSettings() { settingsOverlay.hidden = true; }

function showSignOutConfirm() {
  settingsSignoutError.textContent = "";
  settingsSignoutGo.disabled = false;
  signoutOverlay.hidden = false;
}

function hideSignOutConfirm() {
  signoutOverlay.hidden = true;
  settingsSignoutError.textContent = "";
}

async function performSignOut() {
  settingsSignoutError.textContent = "";
  settingsSignoutGo.disabled = true;
  try {
    await invoke("logout");
  } catch (e) {
    settingsSignoutError.textContent = `Sign out failed: ${e}`;
    settingsSignoutGo.disabled = false;
    return;
  }
  currentStatus = { configured: false, server_url: null, account_id: null, api_token: null };
  setOfflineFlag(false);
  appMode = "setup";
  destroyEditor();
  hideSignOutConfirm();
  hideSettings();
  showSetup();
}

async function deleteAccount() {
  settingsDeleteError.textContent = "";
  settingsDeleteGo.disabled = true;
  try {
    await invoke("delete_account");
  } catch (e) {
    settingsDeleteError.textContent = String(e);
    settingsDeleteGo.disabled = false;
    return;
  }
  currentStatus = { configured: false, server_url: null, account_id: null, api_token: null };
  setOfflineFlag(false);
  appMode = "setup";
  destroyEditor();
  hideSettings();
  showSetup();
}

async function copyToken() {
  if (!currentStatus.api_token) return;
  try {
    await navigator.clipboard.writeText(currentStatus.api_token);
    const original = copyTokenBtn.textContent;
    copyTokenBtn.textContent = "copied";
    setTimeout(() => { copyTokenBtn.textContent = original; }, 1200);
  } catch (e) {
    alert(`Copy failed: ${e}`);
  }
}

function connectFromOffline() {
  hideSettings();
  // Setup overlay sits on top of the editor; submitting closes it and reloads.
  showSetup();
}

// ---------- wiring ----------

function wireSetupEvents() {
  setupPingBtn.addEventListener("click", pingServer);
  setupServer.addEventListener("input", () => {
    // Any edit invalidates the prior ping result.
    if (pingVerifiedUrl && setupServer.value.trim().replace(/\/+$/, "") !== pingVerifiedUrl) {
      pingVerifiedUrl = null;
      pingAllowRegistration = true;
      pingHistoryDays = 0;
      setupPingStatus.textContent = "";
      setupPingStatus.classList.remove("ok", "error");
      updateModeButtons();
    }
  });
  setupServer.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pingServer(); }
  });
  for (const btn of modeButtons) {
    btn.addEventListener("click", () => {
      chooseSetupMode(btn.dataset.mode as "create" | "join");
    });
  }
  setupOffline.addEventListener("click", useOffline);
  setupBack.addEventListener("click", resetSetupForm);
  setupForm.addEventListener("submit", submitSetup);
}

function wireOptionsEvents() {
  optionsBtn.addEventListener("click", showOptions);
  optionsClose.addEventListener("click", hideOptions);
  optionsOverlay.addEventListener("click", (e) => {
    if (e.target === optionsOverlay) hideOptions();
  });
  optionsBg.addEventListener("input", () =>
    onColorInput(optionsBg, optionsBgSwatch, "--bg", BG_COLOR_KEY),
  );
  optionsBgReset.addEventListener("click", () =>
    resetColor(optionsBg, optionsBgSwatch, "--bg", BG_COLOR_KEY),
  );
  optionsFg.addEventListener("input", () =>
    onColorInput(optionsFg, optionsFgSwatch, "--fg", FG_COLOR_KEY),
  );
  optionsFgReset.addEventListener("click", () =>
    resetColor(optionsFg, optionsFgSwatch, "--fg", FG_COLOR_KEY),
  );
  optionsAccent.addEventListener("input", () =>
    onColorInput(optionsAccent, optionsAccentSwatch, "--accent", ACCENT_COLOR_KEY),
  );
  optionsAccentReset.addEventListener("click", () =>
    resetColor(optionsAccent, optionsAccentSwatch, "--accent", ACCENT_COLOR_KEY),
  );
  optionsHideSpace.addEventListener("change", () => {
    void setHideFirstSpace(optionsHideSpace.checked);
  });
  for (const r of optionsCaretStyleRadios) {
    r.addEventListener("change", () => {
      if (r.checked) setCaretStyle(r.value as CaretStyle);
    });
  }
  optionsCaretBlink.addEventListener("change", () => {
    void setCaretBlink(optionsCaretBlink.checked);
  });
  optionsColumns.addEventListener("change", () => {
    void setColumnsMode(optionsColumns.checked);
  });
  optionsColumnWidth.addEventListener("change", () => {
    const n = parseInt(optionsColumnWidth.value, 10);
    if (Number.isFinite(n)) {
      setColumnWidth(n);
      optionsColumnWidth.value = String(columnWidth); // reflect clamping
    }
  });
  optionsShortcut.addEventListener("click", startRecordingShortcut);
  optionsShortcutClear.addEventListener("click", () => {
    void applyShortcut(null);
  });
  optionsShortcutHelp.addEventListener("click", () => {
    shortcutHelpOverlay.hidden = false;
  });
  shortcutHelpClose.addEventListener("click", () => {
    shortcutHelpOverlay.hidden = true;
  });
  optionsSoftClose.addEventListener("click", () =>
    recordInAppShortcut(optionsSoftClose, setSoftClose),
  );
  optionsSoftCloseReset.addEventListener("click", resetSoftClose);
  optionsHardQuit.addEventListener("click", () =>
    recordInAppShortcut(optionsHardQuit, setHardQuit),
  );
  optionsHardQuitReset.addEventListener("click", resetHardQuit);
  optionsColInc.addEventListener("click", () =>
    recordInAppShortcut(optionsColInc, setColInc),
  );
  optionsColIncReset.addEventListener("click", resetColInc);
  optionsColDec.addEventListener("click", () =>
    recordInAppShortcut(optionsColDec, setColDec),
  );
  optionsColDecReset.addEventListener("click", resetColDec);
  optionsHistoryShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsHistoryShortcut, setHistoryShortcut),
  );
  optionsHistoryShortcutReset.addEventListener("click", resetHistoryShortcut);
  optionsOptionsShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsOptionsShortcut, setOptionsShortcut),
  );
  optionsOptionsShortcutReset.addEventListener("click", resetOptionsShortcut);
  optionsSettingsShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsSettingsShortcut, setSettingsShortcut),
  );
  optionsSettingsShortcutReset.addEventListener("click", resetSettingsShortcut);
  optionsCheckLineShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsCheckLineShortcut, setCheckLineShortcut),
  );
  optionsCheckLineShortcutReset.addEventListener("click", resetCheckLineShortcut);
  optionsColumnsToggleShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsColumnsToggleShortcut, setColumnsToggleShortcut),
  );
  optionsColumnsToggleShortcutReset.addEventListener("click", resetColumnsToggleShortcut);
  optionsTabsEnabled.addEventListener("change", () => {
    // Only toggle if state actually differs (avoid re-running for sync-on-open).
    if (optionsTabsEnabled.checked !== tabsEnabled) void toggleTabs();
  });
  optionsTabsToggleShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsTabsToggleShortcut, setTabsToggleShortcut),
  );
  optionsTabsToggleShortcutReset.addEventListener("click", resetTabsToggleShortcut);
  for (let i = 0; i < 5; i++) {
    optionsTabShortcuts[i].addEventListener("click", () =>
      recordInAppShortcut(optionsTabShortcuts[i], (c) => setTabShortcut(i, c)),
    );
    optionsTabShortcutResets[i].addEventListener("click", () => resetTabShortcut(i));
  }
  optionsTabNextShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsTabNextShortcut, setTabNextShortcut),
  );
  optionsTabNextShortcutReset.addEventListener("click", resetTabNextShortcut);
  optionsTabPrevShortcut.addEventListener("click", () =>
    recordInAppShortcut(optionsTabPrevShortcut, setTabPrevShortcut),
  );
  optionsTabPrevShortcutReset.addEventListener("click", resetTabPrevShortcut);
}

function wireSettingsEvents() {
  settingsBtn.addEventListener("click", showSettings);
  settingsClose.addEventListener("click", hideSettings);
  settingsCloseOffline.addEventListener("click", hideSettings);
  settingsConnect.addEventListener("click", connectFromOffline);
  settingsLogout.addEventListener("click", showSignOutConfirm);
  settingsSignoutCancel.addEventListener("click", hideSignOutConfirm);
  settingsSignoutGo.addEventListener("click", performSignOut);
  signoutOverlay.addEventListener("click", (e) => {
    if (e.target === signoutOverlay) hideSignOutConfirm();
  });
  copyTokenBtn.addEventListener("click", copyToken);
  revealTokenBtn.addEventListener("click", () => setTokenRevealed(!tokenRevealed));

  settingsDelete.addEventListener("click", () => {
    settingsDeleteConfirm.hidden = false;
    settingsDeleteInput.focus();
  });
  settingsDeleteCancel.addEventListener("click", () => {
    settingsDeleteConfirm.hidden = true;
    settingsDeleteInput.value = "";
    settingsDeleteError.textContent = "";
    settingsDeleteGo.disabled = true;
  });
  settingsDeleteInput.addEventListener("input", () => {
    settingsDeleteGo.disabled =
      settingsDeleteInput.value !== currentStatus.account_id;
  });
  settingsDeleteGo.addEventListener("click", deleteAccount);
}

async function main() {
  setStatus({ kind: "idle" });
  applyFontSize(loadFontSize());
  applyColor("--bg", optionsBgSwatch, loadColor(BG_COLOR_KEY));
  applyColor("--fg", optionsFgSwatch, loadColor(FG_COLOR_KEY));
  applyColor("--accent", optionsAccentSwatch, loadColor(ACCENT_COLOR_KEY));
  hideFirstSpaceFlag = loadHideFirstSpace();
  caretStyle = loadCaretStyle();
  caretBlink = loadCaretBlink();
  applyCaretStyle(caretStyle);
  columnsMode = loadColumnsMode();
  columnWidth = loadColumnWidth();
  historyHidden = loadHistoryHidden();
  applyHistoryVisibility();
  historyBtn.addEventListener("click", toggleHistory);

  currentShortcut = loadShortcut();
  refreshShortcutButton();
  if (currentShortcut) {
    void applyShortcut(currentShortcut);
  }

  try {
    softCloseShortcut = localStorage.getItem(SOFT_CLOSE_KEY) ?? DEFAULT_SOFT_CLOSE;
    hardQuitShortcut = localStorage.getItem(HARD_QUIT_KEY) ?? DEFAULT_HARD_QUIT;
    colIncShortcut = localStorage.getItem(COL_INC_KEY) ?? DEFAULT_COL_INC;
    colDecShortcut = localStorage.getItem(COL_DEC_KEY) ?? DEFAULT_COL_DEC;
    historyShortcut = localStorage.getItem(HISTORY_SHORTCUT_KEY) ?? DEFAULT_HISTORY_SHORTCUT;
    optionsShortcutCombo = localStorage.getItem(OPTIONS_SHORTCUT_KEY) ?? DEFAULT_OPTIONS_SHORTCUT;
    settingsShortcut = localStorage.getItem(SETTINGS_SHORTCUT_KEY) ?? DEFAULT_SETTINGS_SHORTCUT;
    checkLineShortcut = localStorage.getItem(CHECK_LINE_SHORTCUT_KEY) ?? DEFAULT_CHECK_LINE_SHORTCUT;
    columnsToggleShortcut = localStorage.getItem(COLUMNS_TOGGLE_SHORTCUT_KEY) ?? DEFAULT_COLUMNS_TOGGLE_SHORTCUT;
    tabsEnabled = localStorage.getItem(TABS_ENABLED_KEY) !== "0";
    const savedActive = parseInt(localStorage.getItem(ACTIVE_TAB_KEY) ?? "0", 10);
    activeTabIndex = Number.isFinite(savedActive) && savedActive >= 0 ? savedActive : 0;
    tabsToggleShortcut = localStorage.getItem(TABS_TOGGLE_SHORTCUT_KEY) ?? DEFAULT_TABS_TOGGLE_SHORTCUT;
    for (let i = 0; i < 5; i++) {
      tabShortcuts[i] = localStorage.getItem(TAB_SHORTCUT_KEYS[i]) ?? DEFAULT_TAB_SHORTCUTS[i];
    }
    tabNextShortcut = localStorage.getItem(TAB_NEXT_SHORTCUT_KEY) ?? DEFAULT_TAB_NEXT_SHORTCUT;
    tabPrevShortcut = localStorage.getItem(TAB_PREV_SHORTCUT_KEY) ?? DEFAULT_TAB_PREV_SHORTCUT;
  } catch {}
  optionsSoftClose.textContent = softCloseShortcut;
  optionsHardQuit.textContent = hardQuitShortcut;
  optionsColInc.textContent = colIncShortcut;
  optionsColDec.textContent = colDecShortcut;
  optionsHistoryShortcut.textContent = historyShortcut;
  optionsOptionsShortcut.textContent = optionsShortcutCombo;
  optionsSettingsShortcut.textContent = settingsShortcut;
  optionsCheckLineShortcut.textContent = checkLineShortcut;
  optionsColumnsToggleShortcut.textContent = columnsToggleShortcut;
  optionsTabsToggleShortcut.textContent = tabsToggleShortcut;
  for (let i = 0; i < 5; i++) {
    optionsTabShortcuts[i].textContent = tabShortcuts[i];
  }
  optionsTabNextShortcut.textContent = tabNextShortcut;
  optionsTabPrevShortcut.textContent = tabPrevShortcut;
  todayDateEl.textContent = formatDate(new Date());

  wireSetupEvents();
  wireSettingsEvents();
  wireOptionsEvents();

  for (const el of document.querySelectorAll<HTMLElement>(".resize-handle")) {
    const dir = el.dataset.resize;
    if (!dir) continue;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Cast: API accepts a string union enumerating the 8 directions.
      void getCurrentWindow().startResizeDragging(dir as never);
    });
  }

  await listen<NotebookView>("notebook-updated", async (evt) => {
    // Recompose current state to compare; if it matches the incoming push,
    // there's nothing to update (avoids stomping the user's in-flight edits).
    captureActiveTab();
    const localFull = composeTabs(tabSections);
    if (localFull === evt.payload.today) {
      renderHistory(evt.payload.history);
      return;
    }
    setupTabsForText(evt.payload.today);
    if (activeTabIndex >= tabSections.length) activeTabIndex = 0;
    destroyEditor();
    updateTodoCount(evt.payload.today);
    mountActiveEditor();
    renderTabBar();
    renderHistory(evt.payload.history);
  });

  await listen<SyncStatus>("sync-status", (evt) => {
    setStatus(evt.payload);
  });

  window.addEventListener("keydown", (e) => {
    // User-configurable shortcuts first.
    if (matchesShortcut(e, softCloseShortcut)) {
      e.preventDefault();
      getCurrentWindow().hide();
      return;
    }
    if (matchesShortcut(e, hardQuitShortcut)) {
      e.preventDefault();
      getCurrentWindow().close();
      return;
    }
    if (columnsMode && matchesShortcut(e, colIncShortcut)) {
      e.preventDefault();
      setColumnWidth(columnWidth + COL_WIDTH_STEP);
      return;
    }
    if (columnsMode && matchesShortcut(e, colDecShortcut)) {
      e.preventDefault();
      setColumnWidth(columnWidth - COL_WIDTH_STEP);
      return;
    }
    if (matchesShortcut(e, historyShortcut)) {
      e.preventDefault();
      toggleHistory();
      return;
    }
    if (matchesShortcut(e, optionsShortcutCombo)) {
      e.preventDefault();
      toggleOptions();
      return;
    }
    if (matchesShortcut(e, settingsShortcut)) {
      e.preventDefault();
      toggleSettings();
      return;
    }
    if (matchesShortcut(e, checkLineShortcut)) {
      e.preventDefault();
      checkCurrentLine();
      return;
    }
    if (matchesShortcut(e, columnsToggleShortcut)) {
      e.preventDefault();
      const next = !columnsMode;
      optionsColumns.checked = next;
      void setColumnsMode(next);
      return;
    }
    if (matchesShortcut(e, tabsToggleShortcut)) {
      e.preventDefault();
      void toggleTabs();
      return;
    }
    if (tabsActive()) {
      // Prev first: `Ctrl+Shift+Tab` would otherwise be ambiguous with a
      // generic `Ctrl+Tab` check that ignored Shift.
      if (matchesShortcut(e, tabPrevShortcut)) {
        e.preventDefault();
        prevTab();
        return;
      }
      if (matchesShortcut(e, tabNextShortcut)) {
        e.preventDefault();
        nextTab();
        return;
      }
      for (let i = 0; i < tabShortcuts.length; i++) {
        if (matchesShortcut(e, tabShortcuts[i])) {
          e.preventDefault();
          void switchTab(i);
          return;
        }
      }
    }
    const cmd = e.ctrlKey || e.metaKey;
    if (!cmd) return;
    if (e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      invoke("force_pull");
    } else if (e.code === "Equal" || e.code === "NumpadAdd") {
      e.preventDefault();
      applyFontSize(fontSize + 1);
    } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
      e.preventDefault();
      applyFontSize(fontSize - 1);
    } else if (e.code === "Digit0" || e.code === "Numpad0") {
      e.preventDefault();
      applyFontSize(DEFAULT_FONT_SIZE);
    }
  }, true); // capture phase — keeps our shortcuts (esp. Tab-based ones) from being swallowed by focus-traversal or CodeMirror.

  currentStatus = await invoke<SetupStatus>("setup_status");
  if (currentStatus.configured) {
    appMode = "configured";
    await loadAndMountEditor();
  } else if (isOfflineFlag()) {
    appMode = "offline";
    await loadAndMountEditor();
    setStatus({ kind: "idle" });
  } else {
    appMode = "setup";
    showSetup();
  }
}

main().catch((e) => {
  console.error(e);
  setStatus({ kind: "error", message: String(e) });
});
