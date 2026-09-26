import { describe, expect, it } from 'vitest';

import {
  COMMIT_TYPES,
  MAX_SUBJECT_LENGTH,
  formatVersion,
  isExemptSubject,
  nextVersion,
  parseCommit,
  parseVersion,
  readCargoLockVersion,
  readCargoTomlVersion,
  readJsonVersion,
  releaseBump,
  renderReleaseNotes,
  setCargoLockVersion,
  setCargoTomlVersion,
  setJsonVersion,
  validateCommitMessage,
  versionToRelease,
} from './version.ts';
import type { ConventionalCommit } from './version.ts';

function commit(partial: Partial<ConventionalCommit>): ConventionalCommit {
  return { type: 'chore', scope: null, breaking: false, description: 'something', ...partial };
}

describe('parseCommit', () => {
  it('reads a bare type and description', () => {
    expect(parseCommit('fix: keep a subheading above its list')).toEqual({
      type: 'fix',
      scope: null,
      breaking: false,
      description: 'keep a subheading above its list',
    });
  });

  it('reads a scope', () => {
    expect(parseCommit('feat(schedule): upgrade the first slot to a day-start')?.scope).toBe(
      'schedule',
    );
  });

  it('reads the `!` breaking marker, scope or no scope', () => {
    expect(parseCommit('feat!: rewrite the day file')?.breaking).toBe(true);
    expect(parseCommit('feat(vault)!: rewrite the day file')?.breaking).toBe(true);
  });

  it('reads a BREAKING CHANGE footer in the body', () => {
    const message = 'feat: stamp a format version\n\nBREAKING CHANGE: v1 files no longer parse.';
    expect(parseCommit(message)?.breaking).toBe(true);
  });

  it('reads the hyphenated footer, which is the valid git trailer spelling', () => {
    const message = 'feat: stamp a format version\n\nBREAKING-CHANGE: v1 files no longer parse.';
    expect(parseCommit(message)?.breaking).toBe(true);
  });

  it('does not read a BREAKING CHANGE mention that carries no footer text', () => {
    expect(
      parseCommit('fix: explain a BREAKING CHANGE: in the docs\n\nBREAKING CHANGE:')?.breaking,
    ).toBe(false);
  });

  it('ignores the subjects git writes for you', () => {
    expect(parseCommit('Merge pull request #13 from Djeisen642/fix')).toBeNull();
    expect(parseCommit('Revert "feat: rank the top five"')).toBeNull();
    expect(parseCommit('fixup! feat: rank the top five')).toBeNull();
    expect(parseCommit('Release v0.2.0')).toBeNull();
  });

  it('ignores a prose subject, which is what this repo wrote before', () => {
    expect(parseCommit('Read the vault the way people write it')).toBeNull();
  });

  it('does not mistake a colon in prose for a type', () => {
    expect(parseCommit('Rank the day: the top five tasks')).toBeNull();
  });

  it('parses a type it does not know — classifying is not its job', () => {
    expect(parseCommit('wibble: do a thing')?.type).toBe('wibble');
  });

  it('ignores the comment lines git has not stripped yet', () => {
    expect(parseCommit('# Please enter a message\nfeat: add a thing')?.type).toBe('feat');
  });
});

describe('validateCommitMessage', () => {
  it('accepts every type it documents', () => {
    for (const type of COMMIT_TYPES) {
      expect(validateCommitMessage(`${type}: do the thing`)).toBeNull();
    }
  });

  it('accepts a scope and a breaking marker', () => {
    expect(validateCommitMessage('feat(tray)!: change the status line')).toBeNull();
  });

  it('exempts what git wrote itself', () => {
    expect(validateCommitMessage('Merge branch "main" into feature')).toBeNull();
  });

  it('rejects a prose subject, and shows the shape it wanted', () => {
    const problem = validateCommitMessage('Rank the top five tasks');
    expect(problem).toContain('not a conventional commit subject');
    expect(problem).toContain('type(optional scope): description');
  });

  it('rejects a type nobody defined, and lists the ones that exist', () => {
    const problem = validateCommitMessage('feet: rank the top five');
    expect(problem).toContain('“feet” is not a known commit type');
    expect(problem).toContain('feat');
  });

  it('rejects an empty message', () => {
    expect(validateCommitMessage('\n\n# a comment\n')).toContain('empty');
  });

  it('rejects a subject longer than the cap', () => {
    const subject = `feat: ${'x'.repeat(MAX_SUBJECT_LENGTH)}`;
    expect(validateCommitMessage(subject)).toContain('keep it to');
  });

  it('accepts a subject exactly at the cap', () => {
    const description = 'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length);
    expect(validateCommitMessage(`feat: ${description}`)).toBeNull();
  });

  it('rejects a type with no description', () => {
    expect(validateCommitMessage('feat:')).not.toBeNull();
    expect(validateCommitMessage('feat: ')).not.toBeNull();
  });
});

describe('isExemptSubject', () => {
  it('does not exempt a word that merely starts like one', () => {
    expect(isExemptSubject('Merged the two parsers')).toBe(false);
    expect(isExemptSubject('Reverting is not the same as revert')).toBe(false);
  });
});

describe('releaseBump', () => {
  it('is null when nothing releasable landed', () => {
    expect(releaseBump([commit({ type: 'chore' }), commit({ type: 'docs' })])).toBeNull();
  });

  it('is null for an empty history', () => {
    expect(releaseBump([])).toBeNull();
  });

  it('patches for a fix', () => {
    expect(releaseBump([commit({ type: 'fix' })])).toBe('patch');
  });

  it('patches for a perf change', () => {
    expect(releaseBump([commit({ type: 'perf' })])).toBe('patch');
  });

  it('minors for a feature, whatever else is in the set', () => {
    expect(releaseBump([commit({ type: 'fix' }), commit({ type: 'feat' })])).toBe('minor');
  });

  it('majors for a breaking change, whatever else is in the set', () => {
    expect(releaseBump([commit({ type: 'feat' }), commit({ type: 'chore', breaking: true })])).toBe(
      'major',
    );
  });
});

describe('nextVersion', () => {
  it('bumps each field and zeroes the ones below it', () => {
    expect(nextVersion('1.4.7', 'patch')).toBe('1.4.8');
    expect(nextVersion('1.4.7', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.7', 'major')).toBe('2.0.0');
  });

  it('does not let a breaking change declare 1.0 on its own', () => {
    expect(nextVersion('0.1.0', 'major')).toBe('0.2.0');
    expect(nextVersion('0.9.3', 'major')).toBe('0.10.0');
  });

  it('still bumps minor and patch normally below 1.0', () => {
    expect(nextVersion('0.1.0', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
  });

  it('carries two digits rather than rolling over', () => {
    expect(nextVersion('0.9.9', 'patch')).toBe('0.9.10');
  });

  it('refuses a version that is not x.y.z', () => {
    expect(() => nextVersion('0.1', 'patch')).toThrow(/x\.y\.z/);
    expect(() => nextVersion('v0.1.0', 'patch')).toThrow(/x\.y\.z/);
  });
});

describe('versionToRelease', () => {
  it('releases a declared-but-untagged version as itself, so 1.0.0 can exist', () => {
    expect(versionToRelease('1.0.0', false, 'patch')).toBe('1.0.0');
  });

  it('releases an untagged version even when nothing since would earn a bump', () => {
    expect(versionToRelease('1.0.0', false, null)).toBe('1.0.0');
  });

  it('bumps once the declared version has a tag of its own', () => {
    expect(versionToRelease('1.0.0', true, 'minor')).toBe('1.1.0');
  });

  it('is null when the version is tagged and nothing releasable landed', () => {
    expect(versionToRelease('1.0.0', true, null)).toBeNull();
  });

  it('costs a major once past 1.0, where a breaking change is no longer free', () => {
    expect(versionToRelease('1.0.0', true, 'major')).toBe('2.0.0');
  });

  it('refuses a version that is not x.y.z rather than releasing it', () => {
    expect(() => versionToRelease('1.0', false, null)).toThrow(/x\.y\.z/);
  });
});

describe('parseVersion / formatVersion', () => {
  it('round-trips', () => {
    expect(formatVersion(parseVersion('12.3.45'))).toBe('12.3.45');
  });
});

const PACKAGE_JSON = `{
  "name": "app-status-tracker",
  "private": true,
  "version": "0.1.0",
  "engines": {
    "node": ">=22.12"
  }
}
`;

const TAURI_CONF = `{
  "productName": "App Status Tracker",
  "version": "0.1.0",
  "app": {
    "windows": [{ "width": 420 }]
  }
}
`;

describe('the JSON files', () => {
  it('reads the version', () => {
    expect(readJsonVersion(PACKAGE_JSON)).toBe('0.1.0');
    expect(readJsonVersion(TAURI_CONF)).toBe('0.1.0');
  });

  it('writes the version and changes nothing else', () => {
    const next = setJsonVersion(PACKAGE_JSON, '0.2.0');
    expect(readJsonVersion(next)).toBe('0.2.0');
    expect(next).toBe(PACKAGE_JSON.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  });

  it('keeps the file byte-identical apart from the number', () => {
    const next = setJsonVersion(TAURI_CONF, '1.0.0');
    expect(next.split('\n').length).toBe(TAURI_CONF.split('\n').length);
    expect(next).toContain('"productName": "App Status Tracker"');
  });

  it('refuses a file with two version keys rather than guessing', () => {
    const ambiguous = '{ "version": "1.0.0", "dep": { "version": "2.0.0" } }';
    expect(() => readJsonVersion(ambiguous)).toThrow(/exactly one/);
    expect(() => setJsonVersion(ambiguous, '3.0.0')).toThrow(/exactly one/);
  });

  it('refuses a file with none', () => {
    expect(() => readJsonVersion('{ "name": "x" }')).toThrow(/exactly one/);
  });
});

const CARGO_TOML = `[package]
name = "app-status-tracker"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
serde_json = "1"
`;

describe('Cargo.toml', () => {
  it('reads the package version', () => {
    expect(readCargoTomlVersion(CARGO_TOML)).toBe('0.1.0');
  });

  it('writes the package version and leaves dependency versions alone', () => {
    const next = setCargoTomlVersion(CARGO_TOML, '0.2.0');
    expect(readCargoTomlVersion(next)).toBe('0.2.0');
    expect(next).toContain('tauri-build = { version = "2", features = [] }');
    expect(next).toContain('tauri = { version = "2", features = ["tray-icon"] }');
  });

  it('does not reach into a later section for a version key', () => {
    const noPackageVersion = `[package]
name = "app-status-tracker"

[dependencies.tauri]
version = "2"
`;
    expect(() => readCargoTomlVersion(noPackageVersion)).toThrow(/\[package\]/);
  });

  it('refuses a manifest with no [package] section', () => {
    expect(() => setCargoTomlVersion('[workspace]\nmembers = []\n', '1.0.0')).toThrow(
      /\[package\]/,
    );
  });
});

const CARGO_LOCK = `version = 4

[[package]]
name = "anyhow"
version = "1.0.100"

[[package]]
name = "app-status-tracker"
version = "0.1.0"
dependencies = [
 "serde",
 "tauri",
]

[[package]]
name = "zerocopy"
version = "0.8.28"
`;

describe('Cargo.lock', () => {
  it('reads the crate its own entry', () => {
    expect(readCargoLockVersion(CARGO_LOCK, 'app-status-tracker')).toBe('0.1.0');
  });

  it('writes only that entry, not the crates around it', () => {
    const next = setCargoLockVersion(CARGO_LOCK, '0.2.0', 'app-status-tracker');
    expect(readCargoLockVersion(next, 'app-status-tracker')).toBe('0.2.0');
    expect(readCargoLockVersion(next, 'anyhow')).toBe('1.0.100');
    expect(readCargoLockVersion(next, 'zerocopy')).toBe('0.8.28');
  });

  it('leaves the lockfile format version at the top alone', () => {
    expect(setCargoLockVersion(CARGO_LOCK, '9.9.9', 'app-status-tracker')).toContain(
      'version = 4\n',
    );
  });

  it('does not match a crate whose name merely contains the one asked for', () => {
    const lock = `[[package]]
name = "app-status-tracker-extras"
version = "3.0.0"
`;
    expect(() => readCargoLockVersion(lock, 'app-status-tracker')).toThrow(/app-status-tracker/);
  });

  it('refuses a lockfile without the crate', () => {
    expect(() => setCargoLockVersion(CARGO_LOCK, '1.0.0', 'nope')).toThrow(/nope/);
  });
});

describe('renderReleaseNotes', () => {
  const COMMITS = [
    commit({ type: 'feat', description: 'rank the day’s top five tasks' }),
    commit({ type: 'feat', scope: 'tray', description: 'refresh the status line on tick' }),
    commit({ type: 'fix', description: 'keep a subheading above its list' }),
    commit({ type: 'chore', description: 'update five dev dependencies' }),
  ];

  it('groups by consequence, features before fixes before chores', () => {
    const notes = renderReleaseNotes(COMMITS);
    expect(notes.indexOf('### Features')).toBeLessThan(notes.indexOf('### Fixes'));
    expect(notes.indexOf('### Fixes')).toBeLessThan(notes.indexOf('### Under the hood'));
  });

  it('leads with breaking changes', () => {
    const notes = renderReleaseNotes([
      ...COMMITS,
      commit({ type: 'feat', breaking: true, description: 'drop v1 day files' }),
    ]);
    expect(notes.startsWith('### Breaking changes')).toBe(true);
  });

  it('lists a breaking change once, not in its type section too', () => {
    const notes = renderReleaseNotes([
      commit({ type: 'feat', breaking: true, description: 'drop v1 day files' }),
    ]);
    expect(notes.match(/drop v1 day files/g)).toHaveLength(1);
    expect(notes).not.toContain('### Features');
  });

  it('shows a scope in bold and omits it when there is none', () => {
    const notes = renderReleaseNotes(COMMITS);
    expect(notes).toContain('- **tray:** refresh the status line on tick');
    expect(notes).toContain('- rank the day’s top five tasks');
  });

  it('keeps a type it has no section for rather than dropping it', () => {
    expect(
      renderReleaseNotes([commit({ type: 'revert', description: 'undo the thing' })]),
    ).toContain('- undo the thing');
  });

  it('is empty for an empty release', () => {
    expect(renderReleaseNotes([])).toBe('');
  });
});
