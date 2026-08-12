import { findPlaceholders } from '../template/placeholder.js';
import { decodeXmlText, encodeXmlText } from './xml.js';

/**
 * Placeholder substitution inside WordprocessingML.
 *
 * The complication this module exists to solve: Word does not store a
 * paragraph's text as one string. Revision tracking, spell-check state and
 * formatting cause it to split text across many `<w:r>` runs, so a template
 * that reads `{{NAME}}` on screen is very often stored as
 *
 *   <w:r><w:t>{{NA</w:t></w:r><w:r><w:t>ME}}</w:t></w:r>
 *
 * A plain string replacement over the XML therefore misses most real-world
 * templates. Instead, the text nodes are stitched into one virtual string,
 * matching happens there, and the result is written back across the original
 * nodes — the whole replacement landing in the first node of the match so the
 * substituted text inherits that run's formatting.
 */

/** Matches a `<w:t>` element, self-closing or not, capturing attrs and body. */
const TEXT_NODE_RE = /<w:t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:t>)/g;

interface TextNode {
  /** Offset of `<` in the source XML. */
  readonly start: number;
  /** Offset just past the element's final `>`. */
  readonly end: number;
  /** Attribute text of the opening tag, e.g. ` xml:space="preserve"`. */
  readonly attrs: string;
  /** Decoded plain text held by this node. */
  text: string;
}

export interface ReplaceResult {
  readonly xml: string;
  /** Number of placeholder occurrences replaced. */
  readonly replaced: number;
}

/** Resolves a placeholder to its replacement text. */
export type PlaceholderResolver = (key: string, original: string) => string;

/**
 * Replace every placeholder in a WordprocessingML part.
 *
 * `resolve` may throw (for example on a missing value); the error propagates
 * unchanged so the caller can attribute it to a row.
 */
export function replacePlaceholdersInXml(xml: string, resolve: PlaceholderResolver): ReplaceResult {
  const nodes = collectTextNodes(xml);
  if (nodes.length === 0) return { xml, replaced: 0 };

  let replaced = 0;
  for (const group of groupByParagraph(xml, nodes)) {
    replaced += replaceWithinGroup(group, resolve);
  }
  if (replaced === 0) return { xml, replaced: 0 };

  return { xml: rebuild(xml, nodes), replaced };
}

/** Collect every `<w:t>` element in document order with its decoded text. */
function collectTextNodes(xml: string): TextNode[] {
  const nodes: TextNode[] = [];
  TEXT_NODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_NODE_RE.exec(xml)) !== null) {
    nodes.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1] ?? '',
      text: decodeXmlText(match[2] ?? ''),
    });
  }
  return nodes;
}

/**
 * Split text nodes into groups that a placeholder may span.
 *
 * A placeholder cannot cross a paragraph boundary, so an unclosed `{{` in one
 * paragraph must not pair with a `}}` far away in another and swallow all the
 * text between them. Consecutive nodes are grouped until a `</w:p>` appears
 * between them in the source.
 */
function groupByParagraph(xml: string, nodes: readonly TextNode[]): TextNode[][] {
  const groups: TextNode[][] = [];
  let current: TextNode[] = [];
  let previousEnd = 0;

  for (const node of nodes) {
    const between = xml.slice(previousEnd, node.start);
    if (current.length > 0 && between.includes('</w:p>')) {
      groups.push(current);
      current = [];
    }
    current.push(node);
    previousEnd = node.end;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Run placeholder replacement across one group of contiguous text nodes.
 *
 * Matches are applied last-to-first so that earlier offsets stay valid while
 * the group is being rewritten.
 */
function replaceWithinGroup(group: TextNode[], resolve: PlaceholderResolver): number {
  const virtual = group.map((node) => node.text).join('');
  const matches = findPlaceholders(virtual);
  if (matches.length === 0) return 0;

  // Offset of each node's text within the virtual string.
  const offsets: number[] = [];
  let cursor = 0;
  for (const node of group) {
    offsets.push(cursor);
    cursor += node.text.length;
  }

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const original = virtual.slice(match.start, match.end);
    const replacement = resolve(match.key, original);
    applyReplacement(group, offsets, match.start, match.end, replacement);
  }

  return matches.length;
}

/**
 * Write `replacement` over the virtual range [start, end) of a node group.
 *
 * The full replacement goes into the node holding the start of the match; the
 * remainder of the match is deleted from the nodes it spanned. This preserves
 * the formatting of the run where the placeholder began, which is the run the
 * template author styled.
 */
function applyReplacement(
  group: TextNode[],
  offsets: readonly number[],
  start: number,
  end: number,
  replacement: string,
): void {
  let written = false;

  for (let i = 0; i < group.length; i += 1) {
    const node = group[i]!;
    const nodeStart = offsets[i]!;
    const nodeEnd = nodeStart + node.text.length;

    // Skip nodes entirely outside the match.
    if (nodeEnd <= start || nodeStart >= end) continue;

    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(node.text.length, end - nodeStart);
    const before = node.text.slice(0, localStart);
    const after = node.text.slice(localEnd);

    node.text = written ? before + after : before + replacement + after;
    written = true;
  }
}

/** Splice the (possibly rewritten) node texts back into the source XML. */
function rebuild(xml: string, nodes: readonly TextNode[]): string {
  let out = xml;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    out = out.slice(0, node.start) + renderTextNode(node) + out.slice(node.end);
  }
  return out;
}

/**
 * Serialise one text node.
 *
 * `xml:space="preserve"` is always set on rewritten nodes because substituted
 * values routinely begin or end with a space (`{{TITLE}} {{NAME}}`), and Word
 * strips leading and trailing whitespace from nodes that lack the attribute.
 *
 * Newlines and tabs in a value are promoted to real Word elements. A raw
 * newline inside `<w:t>` is collapsed to nothing on screen, so a multi-line
 * address would otherwise render as one run-on line.
 */
function renderTextNode(node: TextNode): string {
  const attrs = ensureSpacePreserve(node.attrs);
  const body = encodeXmlText(node.text.replace(/\r\n?/g, '\n'))
    .replace(/\n/g, `</w:t><w:br/><w:t${attrs}>`)
    .replace(/\t/g, `</w:t><w:tab/><w:t${attrs}>`);
  return `<w:t${attrs}>${body}</w:t>`;
}

function ensureSpacePreserve(attrs: string): string {
  const withoutSpace = attrs.replace(/\s*xml:space\s*=\s*"[^"]*"/g, '').trimEnd();
  return `${withoutSpace} xml:space="preserve"`;
}

/** Extract the plain text of a WordprocessingML part, paragraph by paragraph. */
export function extractTextFromXml(xml: string): string {
  const nodes = collectTextNodes(xml);
  return groupByParagraph(xml, nodes)
    .map((group) => group.map((node) => node.text).join(''))
    .join('\n');
}

/**
 * The visible text of a document part, including its tabs and line breaks.
 *
 * {@link extractTextFromXml} sees only `<w:t>` nodes, because that is what
 * placeholder matching needs — a tab inside a placeholder would be a mistake,
 * not something to match across. But a reader sees tabs, and a label/value
 * layout is nothing but tabs: without them `Position\tData Analyst` reads back
 * as `PositionData Analyst`, which looks like lost text and is not.
 */
export function extractVisibleText(xml: string): string {
  // Tabs and breaks are turned into their characters before the text nodes are
  // collected, so they keep their place in the run order.
  const marked = xml
    .replace(/<w:tab\b[^>]*\/>/g, '<w:t>\t</w:t>')
    .replace(/<w:br\b[^>]*\/>/g, '<w:t>\n</w:t>');
  return extractTextFromXml(marked);
}
