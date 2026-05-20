import { EditorSelection, EditorState, Extension, Line, Range, SelectionRange, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const HIDE = Decoration.replace({});

const BOLD = Decoration.mark({ class: "cm-md-bold" });
const ITALIC = Decoration.mark({ class: "cm-md-italic" });
const STRIKE = Decoration.mark({ class: "cm-md-strike" });
const INLINE_CODE = Decoration.mark({ class: "cm-md-inline-code" });
const TAG_MARK = Decoration.mark({ class: "cm-md-tag" });
const LINK = Decoration.mark({ class: "cm-md-link" });

interface TagSpec {
  hidden: boolean; // when true, the whole code block is replaced by a small diamond marker when the caret isn't on it
}

const KNOWN_TAGS: Record<string, TagSpec> = {
  persist: { hidden: false },
  expiry: { hidden: false },
  expires: { hidden: true },
  repeat: { hidden: true },
  newtab: { hidden: true },
};

const EXPIRY_RE = /`\s*expiry\s*:\s*(\d+)\s*`/;
const NEWTAB_TAG_RE = /`\s*newtab\s*`/g;
const EXPIRES_TAG_RE = /\s*`\s*expires\s*:\s*\d+\s*`/g;
// Matches both `repeat:N` (bare) and `repeat:N,R`; captures N.
const REPEAT_TAG_RE = /`\s*repeat\s*:\s*(\d+)(?:\s*,\s*\d+)?\s*`/g;

/** Identify whether an inline-code segment is a recognized tag. Accepts
 *  `name` or `name:value` forms. Returns null for unknown names. */
function classifyTag(inner: string): { name: string; spec: TagSpec } | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  const spec = KNOWN_TAGS[name];
  if (!spec) return null;
  return { name, spec };
}

const HEADING_MARKS: Record<string, Decoration> = {
  ATXHeading1: Decoration.mark({ class: "cm-md-h1" }),
  ATXHeading2: Decoration.mark({ class: "cm-md-h2" }),
  ATXHeading3: Decoration.mark({ class: "cm-md-h3" }),
  ATXHeading4: Decoration.mark({ class: "cm-md-h4" }),
  ATXHeading5: Decoration.mark({ class: "cm-md-h5" }),
  ATXHeading6: Decoration.mark({ class: "cm-md-h6" }),
  SetextHeading1: Decoration.mark({ class: "cm-md-h1" }),
  SetextHeading2: Decoration.mark({ class: "cm-md-h2" }),
};

// Parent node names that count as "inline styled spans" — when computing
// whether a marker should be revealed, we use the parent span's range.
const INLINE_SPAN_PARENTS = new Set([
  "StrongEmphasis",
  "Emphasis",
  "Strikethrough",
  "InlineCode",
  "Link",
  "Image",
]);

const HIDDEN_MARKERS = new Set([
  "EmphasisMark",
  "CodeMark",
  "HeaderMark",
  "LinkMark",
  "URLMark",
  "QuoteMark",
  "CodeInfo",
]);

const TODO_RE = /^(\s*)\[( |x|X)?\]/;

/** True if any selection range touches [from, to] inclusive on both edges. */
function touches(
  from: number,
  to: number,
  ranges: readonly SelectionRange[],
): boolean {
  for (const r of ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** True if any cursor / selection endpoint sits *strictly* between `from`
 *  and `to` (not at the edges). Used for atomic widgets like the checkbox
 *  where adjacent positions are legitimately "outside" — e.g. cursor at
 *  position `to` is the natural place to start typing the task text. */
function strictlyInside(
  from: number,
  to: number,
  ranges: readonly SelectionRange[],
): boolean {
  for (const r of ranges) {
    if ((r.from > from && r.from < to) || (r.to > from && r.to < to)) {
      return true;
    }
  }
  return false;
}

class TagMarkerWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-tag-marker";
    wrapper.dataset.label = this.label;
    // Rotation lives on an inner element so the absolutely-positioned tooltip
    // pseudo-element (on the wrapper) isn't dragged into the rotated frame.
    const shape = document.createElement("span");
    shape.className = "cm-md-tag-marker-shape";
    wrapper.appendChild(shape);
    return wrapper;
  }
  eq(other: WidgetType): boolean {
    return other instanceof TagMarkerWidget && other.label === this.label;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Walk upward from `lineNumber` to find the containing group's bounds, then
 *  return the first `` `expiry:N` `` value encountered within (header included).
 *  Returns null if the group has no expiry tag. */
function findGroupExpiry(view: EditorView, lineNumber: number): number | null {
  const doc = view.state.doc;
  let groupStart = 1;
  for (let i = lineNumber - 1; i >= 1; i--) {
    if (doc.line(i).text.startsWith("# ")) {
      groupStart = i;
      break;
    }
  }
  let groupEnd = doc.lines;
  for (let i = lineNumber + 1; i <= doc.lines; i++) {
    if (doc.line(i).text.startsWith("# ")) {
      groupEnd = i - 1;
      break;
    }
  }
  for (let i = groupStart; i <= groupEnd; i++) {
    const m = doc.line(i).text.match(EXPIRY_RE);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Rewrite a checkbox line through the same expires/repeat pipeline used by
 *  the click-toggle widget. `boxFrom..boxTo` is the `[ ]`/`[x]` span. */
function applyCheckboxToggle(
  view: EditorView,
  line: Line,
  boxFrom: number,
  boxTo: number,
  checked: boolean,
): void {
  const before = line.text.slice(0, boxFrom - line.from);
  const after = line.text.slice(boxTo - line.from);

  let newAfter = after;
  if (checked) {
    newAfter = newAfter.replace(
      REPEAT_TAG_RE,
      (_, n) => `\`repeat:${n},${n}\``,
    );
    const expiry = findGroupExpiry(view, line.number);
    if (expiry !== null && !/`\s*expires\s*:\s*\d+\s*`/.test(newAfter)) {
      newAfter = newAfter.replace(/\s+$/, "") + ` \`expires:${expiry}\``;
    }
  } else {
    newAfter = newAfter.replace(EXPIRES_TAG_RE, "");
  }

  const newLine = before + (checked ? "[x]" : "[ ]") + newAfter;
  // We replace the whole line; CodeMirror's default selection mapping would
  // collapse the cursor to the end of the replacement. Map each range
  // explicitly so any cursor on this line keeps its column (clamped), and
  // ranges on later lines shift by the length delta.
  const delta = newLine.length - (line.to - line.from);
  const mapPos = (pos: number): number => {
    if (pos < line.from) return pos;
    if (pos > line.to) return pos + delta;
    const offset = pos - line.from;
    return line.from + Math.min(offset, newLine.length);
  };
  const oldSel = view.state.selection;
  const newRanges = oldSel.ranges.map((r) =>
    EditorSelection.range(mapPos(r.anchor), mapPos(r.head)),
  );
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newLine },
    selection: EditorSelection.create(newRanges, oldSel.mainIndex),
  });
}

/** Toggle the checkbox on the given line. Returns true if a checkbox existed
 *  and was flipped, false otherwise (caller can then no-op the shortcut). */
export function toggleLineCheckbox(
  view: EditorView,
  lineNumber: number,
): boolean {
  const doc = view.state.doc;
  if (lineNumber < 1 || lineNumber > doc.lines) return false;
  const line = doc.line(lineNumber);
  const m = TODO_RE.exec(line.text);
  if (!m) return false;
  const indent = m[1].length;
  const from = line.from + indent;
  const to = from + (m[0].length - indent);
  const wasChecked = m[2] === "x" || m[2] === "X";
  applyCheckboxToggle(view, line, from, to, !wasChecked);
  return true;
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
    readonly readOnly: boolean,
  ) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to &&
      other.readOnly === this.readOnly
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-todo";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.checked;
    cb.tabIndex = -1;
    if (this.readOnly) {
      cb.disabled = true;
    } else {
      cb.addEventListener("mousedown", (e) => e.preventDefault());
      cb.addEventListener("change", () => {
        const line = view.state.doc.lineAt(this.from);
        applyCheckboxToggle(view, line, this.from, this.to, cb.checked);
      });
    }
    wrapper.appendChild(cb);
    return wrapper;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(
  view: EditorView,
  readOnly: boolean,
  hideFirstSpace: boolean,
  hideNewtabWithContent: boolean,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;

  // Only treat selection ranges as "live" when the editor is focused (and not
  // read-only). Otherwise the default position-0 cursor would unfold any span
  // starting at position 0 even before the user clicks in.
  const sel =
    !readOnly && view.hasFocus ? view.state.selection.ranges : [];

  // Pre-scan checkbox spans so pass 1 can skip HIDE decorations that fall
  // inside them. lezer-markdown parses `[]`/`[ ]` as an empty Link with
  // LinkMark children; without this guard, the resulting HIDE replace
  // decorations overlap the CheckboxWidget replace on the same range and
  // CodeMirror drops one of them — manifesting as the checkbox visibly
  // "unrendering" whenever the caret isn't on its line.
  const checkboxSpans: Array<[number, number]> = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = TODO_RE.exec(line.text);
    if (!m) continue;
    const indent = m[1].length;
    const from = line.from + indent;
    const to = from + (m[0].length - indent);
    checkboxSpans.push([from, to]);
  }
  const insideCheckbox = (from: number, to: number): boolean => {
    for (const [f, t] of checkboxSpans) {
      if (from < t && to > f) return true; // any overlap
    }
    return false;
  };

  // Pass 1: syntax-tree-driven decorations.
  syntaxTree(view.state).iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      const name = node.name;

      // Inline code: may be a tag. Visible tags get accent-bordered styling;
      // hidden tags are replaced entirely when the caret isn't touching them.
      if (name === "InlineCode") {
        const text = doc.sliceString(node.from, node.to);
        const inner = text.replace(/^`+|`+$/g, "");
        const tag = classifyTag(inner);
        if (tag) {
          const focused = touches(node.from, node.to, sel);
          if (tag.spec.hidden && !focused) {
            if (tag.name === "newtab" && hideNewtabWithContent) {
              const line = doc.lineAt(node.from);
              const onlyMarker = line.text.replace(NEWTAB_TAG_RE, "").trim() === "";
              if (onlyMarker && line.number < doc.lines) {
                // Lone marker with a line after it → the newtabFold StateField
                // removes the whole line (including its newline). Emit nothing
                // here so we don't overlap that replace decoration.
                return false;
              }
              if (!onlyMarker) {
                // Inline with other text → drop just the marker (+ one space).
                let from = node.from;
                if (from > 0 && doc.sliceString(from - 1, from) === " ") from -= 1;
                ranges.push(HIDE.range(from, node.to));
                return false;
              }
              // Lone marker on the last line → a truly empty tab; fall through
              // to the diamond so the tab stays discoverable.
            }
            ranges.push(
              Decoration.replace({
                widget: new TagMarkerWidget(inner.trim()),
              }).range(node.from, node.to),
            );
            return false; // children (CodeMarks) are already covered by the marker
          }
          ranges.push(
            tag.spec.hidden
              ? INLINE_CODE.range(node.from, node.to)
              : TAG_MARK.range(node.from, node.to),
          );
          return;
        }
        ranges.push(INLINE_CODE.range(node.from, node.to));
        return;
      }

      // Span-level styling — always applied so text reads as formatted, even
      // when markers are revealed on the active span.
      if (name === "StrongEmphasis") {
        ranges.push(BOLD.range(node.from, node.to));
      } else if (name === "Emphasis") {
        ranges.push(ITALIC.range(node.from, node.to));
      } else if (name === "Strikethrough") {
        ranges.push(STRIKE.range(node.from, node.to));
      } else if (name === "Link") {
        ranges.push(LINK.range(node.from, node.to));
      } else if (HEADING_MARKS[name]) {
        ranges.push(HEADING_MARKS[name].range(node.from, node.to));
      }

      if (!HIDDEN_MARKERS.has(name) || node.to <= node.from) return;

      // Skip markers that fall inside a checkbox span. The CheckboxWidget
      // replace already covers the same text; adding another replace
      // decoration here would conflict.
      if (insideCheckbox(node.from, node.to)) return;

      // Determine the "active region" for this marker. If the cursor touches
      // that region (anywhere inside or right at either edge), reveal the
      // marker; otherwise hide it.
      let activeFrom = node.from;
      let activeTo = node.to;

      const parent = node.node.parent;
      if (parent && INLINE_SPAN_PARENTS.has(parent.name)) {
        activeFrom = parent.from;
        activeTo = parent.to;
      } else if (parent && HEADING_MARKS[parent.name]) {
        activeFrom = parent.from;
        activeTo = parent.to;
      } else {
        // Block-level marks (QuoteMark, CodeInfo, etc.): fall back to the line.
        const line = doc.lineAt(node.from);
        activeFrom = line.from;
        activeTo = line.to;
      }

      if (touches(activeFrom, activeTo, sel)) return;

      let to = node.to;
      if (name === "HeaderMark") {
        // HeaderMark covers only the `#` chars; the space between `# ` and
        // the heading text isn't part of any node. Extend the hide range
        // across that whitespace so it doesn't leak through.
        const lineEnd = doc.lineAt(node.from).to;
        const probe = doc.sliceString(to, Math.min(lineEnd, to + 4));
        let i = 0;
        while (i < probe.length && probe[i] === " ") i++;
        to += i;
      }
      ranges.push(HIDE.range(node.from, to));
    },
  });

  // Pass 2: per-line scan for `[]` / `[ ]` / `[x]` todo boxes.
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = TODO_RE.exec(line.text);
    if (!m) continue;
    const indent = m[1].length;
    const from = line.from + indent;
    const to = from + (m[0].length - indent);
    const checked = m[2] === "x" || m[2] === "X";

    // Strike through the rest of the line when the todo is checked, so the
    // visual "done" state extends to the task text. Applies whether the
    // checkbox is rendered as a widget or as raw `[x]` text.
    if (checked && line.to > to) {
      ranges.push(STRIKE.range(to, line.to));
    }

    // In editable mode, drop back to raw `[]` text only when the cursor sits
    // *between* the brackets (so the user can manually toggle / change `x`).
    // Adjacent positions (just before `[` or just after `]`) keep the widget
    // — those are the natural cursor spots for indenting or starting the
    // task text, not for editing the marker itself.
    if (!readOnly && strictlyInside(from, to, sel)) continue;
    ranges.push(
      Decoration.replace({
        widget: new CheckboxWidget(checked, from, to, readOnly),
      }).range(from, to),
    );

    // Optionally collapse the single space immediately after `]` so the
    // checkbox sits flush against the task text. We add this as a separate
    // adjacent replace range so it doesn't disturb the widget's source range
    // (the widget toggles `[x]`/`[ ]` using `from`..`to`).
    if (hideFirstSpace && to < line.to && doc.sliceString(to, to + 1) === " ") {
      ranges.push(HIDE.range(to, to + 1));
    }
  }

  return Decoration.set(ranges, true);
}

const NEWTAB_LINE_ONLY_RE = /`\s*newtab\s*`/;

/** A line containing only a `newtab` marker (the marker plus whitespace). */
function isNewtabOnlyLine(text: string): boolean {
  return (
    NEWTAB_LINE_ONLY_RE.test(text) && text.replace(NEWTAB_TAG_RE, "").trim() === ""
  );
}

/** True when line `n` is a lone `newtab` marker that has another line after it
 *  — i.e. the tab has moved past the marker, so it should be folded away. */
function isFoldableNewtabLine(state: EditorState, n: number): boolean {
  if (n >= state.doc.lines) return false; // last line → empty tab, keep diamond
  return isNewtabOnlyLine(state.doc.line(n).text);
}

const NEWTAB_FOLD = Decoration.replace({});

/** Compute fold ranges for every foldable `newtab` line. Each range spans the
 *  marker line *and its trailing newline* so the line is removed from layout
 *  entirely (no blank gap). Replacing a line break is only permitted from a
 *  StateField — not a ViewPlugin — which is why this lives in its own field. */
function computeNewtabFolds(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (let i = 1; i < state.doc.lines; i++) {
    if (!isFoldableNewtabLine(state, i)) continue;
    const line = state.doc.line(i);
    ranges.push(NEWTAB_FOLD.range(line.from, line.to + 1));
  }
  return Decoration.set(ranges, true);
}

/** StateField that folds away lone `newtab` marker lines, plus an atomic-range
 *  provider so the caret skips the folded region cleanly (and Backspace at the
 *  start of the following line removes the whole marker, merging tabs). */
function newtabFold(): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => computeNewtabFolds(state),
    update: (deco, tr) => (tr.docChanged ? computeNewtabFolds(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, EditorView.atomicRanges.of((view) => view.state.field(field))];
}

export interface LivePreviewOpts {
  readOnly?: boolean;
  hideFirstSpace?: boolean;
  hideNewtabWithContent?: boolean;
}

export function livePreview(opts: LivePreviewOpts = {}): Extension {
  const readOnly = opts.readOnly ?? false;
  const hideFirstSpace = opts.hideFirstSpace ?? false;
  const hideNewtabWithContent = opts.hideNewtabWithContent ?? false;
  const main = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, readOnly, hideFirstSpace, hideNewtabWithContent);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged
        ) {
          this.decorations = buildDecorations(update.view, readOnly, hideFirstSpace, hideNewtabWithContent);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  return hideNewtabWithContent ? [main, newtabFold()] : main;
}
