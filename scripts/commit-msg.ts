/**
 * The `commit-msg` hook: hold a subject to Conventional Commits, because the
 * version number is now derived from it.
 *
 * This is the enforcement half of `version.ts`. A subject that says nothing
 * about the kind of change it makes is no longer just untidy — it is a release
 * the tooling cannot classify, and the failure mode is silent: the commit lands
 * and the version simply doesn't move.
 *
 * Run by lefthook with the path to the message file. Merge, revert and
 * fixup subjects are exempt; see `isExemptSubject`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { validateCommitMessage } from './version.ts';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error('Usage: commit-msg.ts <path-to-message-file>');

  const problem = validateCommitMessage(await readFile(path, 'utf8'));
  if (problem === null) return;

  throw new Error(
    `Commit rejected: ${problem}\n\n` +
      'The version is derived from these subjects, so the type is what decides\n' +
      'whether this ships as a major, minor or patch. See “Versioning” in README.md.',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
