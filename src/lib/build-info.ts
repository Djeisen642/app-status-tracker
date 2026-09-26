/**
 * The build info line shown in the Settings overlay: what version this is and
 * where it came from. Purely informational — nothing else in the app reads it.
 */

export interface BuildInfo {
  readonly version: string;
  /** `null` outside a git checkout (a source tarball, an unusual CI checkout). */
  readonly commit: string | null;
  /** When this build was produced, as an ISO 8601 timestamp. */
  readonly builtAt: string;
}

/** "0.2.0 (a1b2c3d4) · built Sep 26, 2026", or without the commit if there isn't one. */
export function formatBuildInfo(info: BuildInfo): string {
  const version = info.commit === null ? info.version : `${info.version} (${info.commit})`;
  return `${version} · built ${formatDate(info.builtAt)}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
