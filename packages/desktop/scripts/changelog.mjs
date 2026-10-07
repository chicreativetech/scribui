/**
 * CHANGELOG.md sections: `## <version>` up to the next `## `. A heading may
 * say "(unreleased)" or carry a date after the version.
 */

const heading = (version) => new RegExp(`^## ${version.replace(/\./g, "\\.")}(?=[ \\t(]|$)`, "m");

/** The notes for `version` (without the heading), or null when there's no such section or it's empty. */
export function notesFor(changelog, version) {
  const m = heading(version).exec(changelog);
  if (!m) return null;
  const rest = changelog.slice(m.index);
  const body = rest.slice(rest.indexOf("\n") + 1);
  const next = body.search(/^## /m);
  const notes = (next < 0 ? body : body.slice(0, next)).trim();
  return notes || null;
}

/** The heading for `version` with today's date instead of "(unreleased)". */
export function dateSection(changelog, version, date) {
  return changelog.replace(new RegExp(`^## ${version.replace(/\./g, "\\.")}[^\\n]*$`, "m"), `## ${version} (${date})`);
}
