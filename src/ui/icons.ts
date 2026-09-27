/**
 * The app's tiny icon set, built as DOM nodes rather than a Unicode glyph: a
 * bare character like × is rendered by whatever font the OS falls back to for
 * that codepoint, which differs by platform and can come out as a blurry
 * bitmap emoji. An SVG is the same crisp vector at any size or DPI, always.
 *
 * Kept in sync with the equivalent inline `<svg>` markup in index.html, for
 * the icons that are static there (settings, add) rather than built per row.
 */

function icon(pathData: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon-glyph');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

/** The × used to dismiss a popup alert or remove a watched service. */
export function closeIcon(): SVGElement {
  return icon('M6 6l12 12M18 6L6 18');
}

/** The chevron after a link that leaves the app (the popup's status-page link). */
export function forwardIcon(): SVGElement {
  return icon('m9 6 6 6-6 6');
}
