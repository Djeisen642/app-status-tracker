/**
 * The version number, derived from the commits rather than typed by hand.
 *
 * Four files carry it — `package.json`, `src-tauri/tauri.conf.json`,
 * `src-tauri/Cargo.toml` and the `app-status-tracker` entry in `src-tauri/Cargo.lock`
 * — and nothing failed when they disagreed. A Tauri bundle takes its installer
 * version from `tauri.conf.json`, so the number a user sees in Add/Remove
 * Programs came from a different file than the one anybody remembered to edit.
 *
 * So: one bump, computed from the conventional-commit subjects since the last
 * `v*` tag, written to all four at once.
 *
 * ```
 * node --experimental-strip-types scripts/version.ts check        # do the four agree?
 * node --experimental-strip-types scripts/version.ts next         # what would the next one be?
 * node --experimental-strip-types scripts/version.ts sync 0.2.0   # write it everywhere
 * node --experimental-strip-types scripts/version.ts notes 0.2.0  # release notes for it
 * ```
 *
 * The parsing half is pure and tested; only the CLI touches git and the disk.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The crate whose version in `Cargo.lock` tracks this app's. */
export const CRATE_NAME = 'app-status-tracker';

/**
 * The types a commit subject may use — Conventional Commits' set.
 *
 * Only three of them move the number (`feat`, `fix`, `perf`); the rest exist so
 * that a chore or a docs pass can still say what it is without pretending to be
 * a release. That is deliberate: a week of dependency bumps and README fixes
 * should not manufacture versions nobody can tell apart.
 */
export const COMMIT_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export type Bump = 'major' | 'minor' | 'patch';

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ConventionalCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?: (?<description>.+)$/;

/**
 * A `BREAKING CHANGE:` footer. Conventional Commits allows the hyphenated
 * spelling too, because `BREAKING CHANGE` is not a valid git trailer token and
 * tools that parse trailers only ever see `BREAKING-CHANGE`.
 */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*\S/m;

/**
 * Subjects git writes for you, or that a rebase consumes before anyone reads
 * them. Holding these to the convention would mean rejecting `git merge` and
 * `git revert` with their own default messages, so they are simply not commits
 * the version is derived from.
 */
const EXEMPT_SUBJECT = /^(?:Merge\b|Revert\b|fixup!|squash!|amend!|Release v\d)/;

/** Conventional Commits caps a header at 100 characters; so do we. */
export const MAX_SUBJECT_LENGTH = 100;

/** True when git — not a person — wrote this subject, or a rebase will eat it. */
export function isExemptSubject(subject: string): boolean {
  return EXEMPT_SUBJECT.test(subject);
}

function splitMessage(message: string): { subject: string; body: string } {
  // A `#`-commented line is stripped by git before the message is stored, but
  // the commit-msg hook sees the file *with* them still in it.
  const lines = message.split('\n').filter((line) => !line.startsWith('#'));
  const subject = (lines[0] ?? '').trimEnd();
  return { subject, body: lines.slice(1).join('\n') };
}

/**
 * Read a commit message as a conventional commit, or `null` if it isn't one.
 *
 * Any lowercase type parses — an unknown one is a commit this file has no
 * opinion about, not an error. `validateCommitMessage` is the half that
 * rejects, and it is only ever pointed at a message someone is writing now.
 */
export function parseCommit(message: string): ConventionalCommit | null {
  const { subject, body } = splitMessage(message);
  if (isExemptSubject(subject)) return null;

  const match = SUBJECT.exec(subject);
  if (!match?.groups) return null;

  return {
    type: match.groups.type ?? '',
    scope: match.groups.scope ?? null,
    breaking: match.groups.breaking === '!' || BREAKING_FOOTER.test(body),
    description: match.groups.description ?? '',
  };
}

/**
 * What is wrong with this commit message, in a sentence, or `null` if nothing
 * is. Used by the `commit-msg` hook, so the wording is what the author sees at
 * the moment their commit is refused.
 */
export function validateCommitMessage(message: string): string | null {
  const { subject } = splitMessage(message);
  if (isExemptSubject(subject)) return null;

  if (subject.trim() === '') return 'the commit message is empty.';

  const match = SUBJECT.exec(subject);
  if (!match?.groups) {
    return (
      `“${subject}” is not a conventional commit subject.\n` +
      'Expected `type(optional scope): description`, for example:\n' +
      '  feat(schedule): upgrade the first slot of the day to a day-start\n' +
      '  fix: keep a subheading above the list it labels\n' +
      `Types: ${COMMIT_TYPES.join(', ')}.`
    );
  }

  const type = match.groups.type ?? '';
  if (!(COMMIT_TYPES as readonly string[]).includes(type)) {
    return `“${type}” is not a known commit type. Use one of: ${COMMIT_TYPES.join(', ')}.`;
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `the subject is ${String(subject.length)} characters; keep it to ${String(
      MAX_SUBJECT_LENGTH,
    )}.`;
  }

  return null;
}

/**
 * The bump a set of commits earns, or `null` for "nothing to release".
 *
 * The strongest signal wins: one breaking change outranks any number of
 * features, and one feature outranks any number of fixes.
 */
export function releaseBump(commits: readonly ConventionalCommit[]): Bump | null {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  if (commits.some((commit) => commit.type === 'fix' || commit.type === 'perf')) return 'patch';
  return null;
}

export function parseVersion(text: string): SemanticVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`Not a version this project uses: “${text}”. Expected x.y.z.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version: SemanticVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/**
 * Apply a bump.
 *
 * Below 1.0.0 a breaking change bumps the *minor*, because declaring 1.0 is a
 * statement about the app being finished enough to promise compatibility —
 * a decision for a person to make, not something to fall out of a `!` in a
 * commit subject on a pre-release tree. Semver itself says as much: anything
 * may change at any time while the major is 0.
 */
export function nextVersion(current: string, bump: Bump): string {
  const version = parseVersion(current);
  const effective = bump === 'major' && version.major === 0 ? 'minor' : bump;

  switch (effective) {
    case 'major':
      return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
    case 'minor':
      return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 });
    case 'patch':
      return formatVersion({ ...version, patch: version.patch + 1 });
  }
}

/**
 * The version this push should release, or `null` for "nothing to release".
 *
 * A version declared in `package.json` but never tagged is released as itself
 * rather than bumped past. That is what lets a hand-set number reach a tag: 1.0
 * is a person's decision, and without this the first releasable commit after
 * that decision would compute 1.0.1 and v1.0.0 would never exist.
 */
export function versionToRelease(
  current: string,
  currentIsTagged: boolean,
  bump: Bump | null,
): string | null {
  parseVersion(current);
  if (!currentIsTagged) return current;
  return bump === null ? null : nextVersion(current, bump);
}

/* -------------------------------------------------------------------------- */
/* Rewriting the four files                                                   */
/* -------------------------------------------------------------------------- */

/**
 * These edit *text*, not a parsed document, and each throws unless it can find
 * exactly one place to write. Re-serializing would reformat files Prettier and
 * Cargo own — and a JSON round-trip that silently drops a key from
 * `tauri.conf.json` would be a configuration bug with no error message.
 */

const JSON_VERSION = /"version"(\s*:\s*)"([^"]*)"/g;

export function readJsonVersion(text: string): string {
  const matches = [...text.matchAll(JSON_VERSION)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one "version" key, found ${String(matches.length)}.`);
  }
  return matches[0]?.[2] ?? '';
}

export function setJsonVersion(text: string, version: string): string {
  readJsonVersion(text); // Throws unless there is exactly one place to write.
  return text.replace(
    JSON_VERSION,
    (_match, separator: string) => `"version"${separator}"${version}"`,
  );
}

/** The span of `[package]`'s body: everything up to the next section header. */
function packageSection(text: string): { start: number; end: number } {
  const header = /^\[package\][ \t]*$/m.exec(text);
  if (!header) throw new Error('No [package] section in this Cargo manifest.');
  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const next = /^\[/m.exec(rest);
  return { start, end: start + (next ? next.index : rest.length) };
}

const TOML_VERSION = /^version[ \t]*=[ \t]*"([^"]*)"/m;

export function readCargoTomlVersion(text: string): string {
  const { start, end } = packageSection(text);
  const match = TOML_VERSION.exec(text.slice(start, end));
  if (!match) throw new Error('No version key in the [package] section.');
  return match[1] ?? '';
}

export function setCargoTomlVersion(text: string, version: string): string {
  const { start, end } = packageSection(text);
  const section = text.slice(start, end);
  const match = TOML_VERSION.exec(section);
  if (!match) throw new Error('No version key in the [package] section.');
  const rewritten = section.replace(TOML_VERSION, `version = "${version}"`);
  return text.slice(0, start) + rewritten + text.slice(end);
}

/** The span of the `[[package]]` block for one crate in a Cargo lockfile. */
function lockEntry(text: string, crate: string): { start: number; end: number } {
  const headers = [...text.matchAll(/^\[\[package\]\][ \t]*$/gm)];
  for (const [index, header] of headers.entries()) {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    if (new RegExp(`^name[ \\t]*=[ \\t]*"${crate}"$`, 'm').test(text.slice(start, end))) {
      return { start, end };
    }
  }
  throw new Error(`No [[package]] entry for “${crate}” in the lockfile.`);
}

export function readCargoLockVersion(text: string, crate: string): string {
  const { start, end } = lockEntry(text, crate);
  const match = TOML_VERSION.exec(text.slice(start, end));
  if (!match) throw new Error(`No version key in the lockfile entry for “${crate}”.`);
  return match[1] ?? '';
}

export function setCargoLockVersion(text: string, version: string, crate: string): string {
  const { start, end } = lockEntry(text, crate);
  const entry = text.slice(start, end);
  if (!TOML_VERSION.test(entry)) {
    throw new Error(`No version key in the lockfile entry for “${crate}”.`);
  }
  return (
    text.slice(0, start) + entry.replace(TOML_VERSION, `version = "${version}"`) + text.slice(end)
  );
}

/* -------------------------------------------------------------------------- */
/* Release notes                                                              */
/* -------------------------------------------------------------------------- */

const NOTE_SECTIONS: readonly { heading: string; types: readonly string[] }[] = [
  { heading: 'Features', types: ['feat'] },
  { heading: 'Fixes', types: ['fix'] },
  { heading: 'Performance', types: ['perf'] },
  {
    heading: 'Under the hood',
    types: ['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test'],
  },
];

function bullet(commit: ConventionalCommit): string {
  return commit.scope ? `- **${commit.scope}:** ${commit.description}` : `- ${commit.description}`;
}

/**
 * Markdown for a release body. Breaking changes lead, because that is the part
 * a reader is scanning for; everything else follows in descending consequence.
 */
export function renderReleaseNotes(commits: readonly ConventionalCommit[]): string {
  const blocks: string[] = [];

  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    blocks.push(['### Breaking changes', '', ...breaking.map(bullet)].join('\n'));
  }

  for (const section of NOTE_SECTIONS) {
    const matching = commits.filter(
      (commit) => !commit.breaking && section.types.includes(commit.type),
    );
    if (matching.length > 0) {
      blocks.push([`### ${section.heading}`, '', ...matching.map(bullet)].join('\n'));
    }
  }

  // `revert` and any type this file doesn't group still belong in the notes.
  const grouped = new Set(NOTE_SECTIONS.flatMap((section) => section.types));
  const rest = commits.filter((commit) => !commit.breaking && !grouped.has(commit.type));
  if (rest.length > 0) {
    blocks.push(['### Other', '', ...rest.map(bullet)].join('\n'));
  }

  return blocks.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface VersionFile {
  readonly path: string;
  readonly read: (text: string) => string;
  readonly write: (text: string, version: string) => string;
}

const FILES: readonly VersionFile[] = [
  { path: 'package.json', read: readJsonVersion, write: setJsonVersion },
  { path: 'src-tauri/tauri.conf.json', read: readJsonVersion, write: setJsonVersion },
  { path: 'src-tauri/Cargo.toml', read: readCargoTomlVersion, write: setCargoTomlVersion },
  {
    path: 'src-tauri/Cargo.lock',
    read: (text) => readCargoLockVersion(text, CRATE_NAME),
    write: (text, version) => setCargoLockVersion(text, version, CRATE_NAME),
  },
];

async function readVersions(): Promise<{ path: string; version: string }[]> {
  return Promise.all(
    FILES.map(async (file) => ({
      path: file.path,
      version: file.read(await readFile(join(ROOT, file.path), 'utf8')),
    })),
  );
}

async function currentVersion(): Promise<string> {
  return readJsonVersion(await readFile(join(ROOT, 'package.json'), 'utf8'));
}

function git(args: string[], quiet = false): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // `git describe` reports "No names found" on an untagged repository, which
    // is the expected state before the first release rather than an error to
    // put in front of anyone.
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  }).trimEnd();
}

/** The newest `v1.2.3` tag reachable from HEAD, or `null` if there is none. */
export function lastReleaseTag(): string | null {
  try {
    return (
      git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], true) || null
    );
  } catch {
    return null;
  }
}

/**
 * Every commit since a tag, as conventional commits. Merges are skipped: their
 * subjects are git's own, and the work they carry is in the log already.
 */
function commitsSince(tag: string | null): ConventionalCommit[] {
  const range = tag === null ? 'HEAD' : `${tag}..HEAD`;
  const log = git(['log', range, '--no-merges', '--format=%B%x1e']);
  return log
    .split('\x1e')
    .map((message) => parseCommit(message.trim()))
    .filter((commit): commit is ConventionalCommit => commit !== null);
}

async function check(): Promise<void> {
  const versions = await readVersions();
  const expected = versions[0]?.version ?? '';
  parseVersion(expected);

  for (const { path, version } of versions) {
    console.log(`${version === expected ? '✓' : '✗'} ${version.padEnd(10)} ${path}`);
  }

  const drifted = versions.filter(({ version }) => version !== expected);
  if (drifted.length > 0) {
    throw new Error(
      `Version drift: ${drifted.map(({ path }) => path).join(', ')} ` +
        `disagree with package.json (${expected}). Run \`pnpm run version:sync\`.`,
    );
  }
  console.log(`All four agree on ${expected}.`);
}

async function sync(target: string | undefined): Promise<void> {
  const version = target ?? (await currentVersion());
  parseVersion(version);

  for (const file of FILES) {
    const path = join(ROOT, file.path);
    const text = await readFile(path, 'utf8');
    const next = file.write(text, version);
    if (next !== text) {
      await writeFile(path, next, 'utf8');
      console.log(`${file.path} → ${version}`);
    }
  }
}

/** Has the version currently declared in `package.json` already been tagged? */
function isVersionTagged(version: string): boolean {
  try {
    return git(['tag', '--list', `v${version}`], true) !== '';
  } catch {
    return false;
  }
}

async function next(): Promise<void> {
  const current = await currentVersion();
  const tagged = isVersionTagged(current);
  const tag = lastReleaseTag();
  const version = versionToRelease(current, tagged, releaseBump(commitsSince(tag)));

  // Nothing on stdout means nothing to release, which is what the release
  // workflow tests. Reasoning goes to stderr so it stays out of that answer.
  if (!tagged) {
    console.error(`v${current} is declared but never tagged — releasing it as it stands.`);
  } else {
    console.error(`Since ${tag ?? 'the start of the history'}.`);
    if (version === null) {
      console.error('No feat, fix, perf or breaking change since then — nothing to release.');
    }
  }

  if (version !== null) console.log(version);
}

function notes(): void {
  console.log(renderReleaseNotes(commitsSince(lastReleaseTag())));
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case 'check':
      return check();
    case 'sync':
      return sync(argument);
    case 'next':
      return next();
    case 'notes':
      return notes();
    default:
      throw new Error(`Usage: version.ts <check|sync [version]|next|notes>`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
