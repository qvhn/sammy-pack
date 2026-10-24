/**
 * Pure: derive a suggested agent slug from a file's location relative to
 * the scan root. Used by both the server-side filesystem scanner and the
 * browser-side `webkitdirectory` picker; same logic, no Node dependencies.
 *
 *   - `<root>/<file>.md`               → `<file>`
 *   - `<root>/<dir>/<file>.md`         → `<dir>-<file>`
 *   - `<root>/components/<d>/<f>.md`   → `<d>-<f>`  (strips the
 *     `components/` wrapper that's common in multi-component agent
 *     repos so the prefix is the component name, not literally
 *     "components-…")
 *
 * Splits on both `/` and `\` so the same function handles
 * `path.relative()` output on Unix/Windows AND browser
 * `File.webkitRelativePath` (always `/`).
 *
 * Returns null if the resulting slug has any character that isn't safe
 * (`[a-zA-Z0-9_-]+`).
 */
export function deriveAgentName(
  relDir: string,
  fileName: string,
): string | null {
  const baseName = fileName.replace(/\.md$/, '');
  let suggested = baseName;
  if (relDir && relDir !== '.') {
    const parts = relDir.split(/[/\\]/).filter(Boolean);
    const prefixParts = parts[0] === 'components' ? parts.slice(1) : parts;
    suggested = [...prefixParts, baseName].filter(Boolean).join('-');
  }
  return /^[a-zA-Z0-9_-]+$/.test(suggested) ? suggested : null;
}

/** File names that are conventionally not agents (docs, templates). */
export function shouldSkipAgentFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower === 'readme.md' || lower === 'component.md';
}

/** Path segments to skip (templates, shared utilities). */
export function shouldSkipAgentDir(dirName: string): boolean {
  return dirName.startsWith('.') || dirName.startsWith('_');
}
