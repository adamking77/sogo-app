import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
/** Structural stand-in for @lezer/common SyntaxNode (transitive dep only). */
interface ParentChainNode {
  name: string;
  parent: ParentChainNode | null;
}

/**
 * Obsidian-style live preview for markdown: headings render at size, bold /
 * italic / strikethrough / inline code / links render styled with their
 * syntax markers hidden, bullets render as •, [[wiki links]] get accent —
 * and every marker reappears the moment the cursor touches its range. The
 * document stays plain markdown byte-for-byte; only the presentation changes.
 */

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
};

const INLINE_CLASS: Record<string, string | null> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  InlineCode: null, // highlighting already styles code; only markers hide
};

const INLINE_MARK: Record<string, string> = {
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

const WIKI_LINK_PATTERN = /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g;

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }

  eq() {
    return true;
  }
}

function selectionTouches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function insideCode(node: ParentChainNode | null) {
  for (let current = node; current; current = current.parent) {
    if (
      current.name === "InlineCode"
      || current.name === "FencedCode"
      || current.name === "CodeBlock"
      || current.name === "CodeText"
    ) {
      return true;
    }
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const { state } = view;
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node;

        const headingClass = HEADING_CLASS[name];
        if (headingClass) {
          const line = state.doc.lineAt(node.from);
          decorations.push(Decoration.line({ class: headingClass }).range(line.from));
          if (!selectionTouches(state, line.from, line.to)) {
            const mark = node.node.getChild("HeaderMark");
            if (mark) {
              // Include the space after the # run.
              decorations.push(
                Decoration.replace({}).range(mark.from, Math.min(mark.to + 1, line.to)),
              );
            }
          }
          return;
        }

        if (name in INLINE_MARK) {
          const cls = INLINE_CLASS[name];
          if (cls) {
            decorations.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          }
          if (!selectionTouches(state, node.from, node.to)) {
            for (const mark of node.node.getChildren(INLINE_MARK[name])) {
              decorations.push(Decoration.replace({}).range(mark.from, mark.to));
            }
          }
          return;
        }

        if (name === "Link") {
          decorations.push(Decoration.mark({ class: "cm-lp-link" }).range(node.from, node.to));
          if (!selectionTouches(state, node.from, node.to)) {
            const marks = node.node.getChildren("LinkMark");
            if (marks.length >= 2) {
              // Hide "[" and everything from "]" through "(url)".
              decorations.push(Decoration.replace({}).range(marks[0].from, marks[0].to));
              decorations.push(Decoration.replace({}).range(marks[1].from, node.to));
            }
          }
          return;
        }

        if (name === "ListMark") {
          const text = state.doc.sliceString(node.from, node.to);
          if (!/^[-*+]$/.test(text)) return;
          const line = state.doc.lineAt(node.from);
          if (selectionTouches(state, line.from, line.to)) return;
          decorations.push(
            Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
          );
          return;
        }

        if (name === "QuoteMark") {
          decorations.push(Decoration.mark({ class: "cm-lp-quotemark" }).range(node.from, node.to));
        }
      },
    });

    // [[wiki links]] are plain text to the markdown parser; find them by
    // regex and skip any match that sits inside code.
    const text = state.doc.sliceString(from, to);
    WIKI_LINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_PATTERN.exec(text)) !== null) {
      const start = from + match.index;
      const end = start + match[0].length;
      if (insideCode(tree.resolveInner(start + 1, 1))) continue;

      decorations.push(Decoration.mark({ class: "cm-lp-wiki" }).range(start, end));
      if (!selectionTouches(state, start, end)) {
        decorations.push(Decoration.replace({}).range(start, start + 2));
        const pipe = match[0].indexOf("|");
        if (pipe > 0) {
          // [[target|alias]] shows only the alias.
          decorations.push(Decoration.replace({}).range(start + 2, start + pipe + 1));
        }
        decorations.push(Decoration.replace({}).range(end - 2, end));
      }
    }
  }

  return Decoration.set(decorations, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-h1": { fontSize: "1.6em", fontWeight: "600", lineHeight: "1.35" },
  ".cm-lp-h2": { fontSize: "1.35em", fontWeight: "600", lineHeight: "1.35" },
  ".cm-lp-h3": { fontSize: "1.18em", fontWeight: "600", lineHeight: "1.35" },
  ".cm-lp-h4": { fontSize: "1.05em", fontWeight: "600" },
  ".cm-lp-h5": { fontSize: "1em", fontWeight: "600" },
  ".cm-lp-h6": { fontSize: "1em", fontWeight: "600", opacity: "0.85" },
  ".cm-lp-strong": { fontWeight: "600", color: "rgb(var(--cc-foreground-rgb))" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.65" },
  ".cm-lp-link": {
    color: "rgb(var(--cc-accent-rgb))",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    textDecorationColor: "rgba(var(--cc-accent-rgb) / 0.4)",
  },
  ".cm-lp-wiki": { color: "rgb(var(--cc-accent-rgb))" },
  ".cm-lp-bullet": { color: "rgba(var(--cc-muted-rgb) / 0.6)" },
  ".cm-lp-quotemark": { color: "rgba(var(--cc-accent-rgb) / 0.5)" },
});

export function markdownLivePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
