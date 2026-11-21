#!/usr/bin/env python3
"""List upstream ESLint feature commits that qualify for a sealed feature group, in a fixed pseudo-random order.

Rule (fixed before looking at any task): first-parent commits dated 2016-01-01 to 2017-12-31 whose subject
starts with "New:" or "Update:", that modify 2-5 existing files under lib/ and add none there, change at least
one file under tests/lib/, leave package.json unchanged, and are not excluded. Candidates are ordered by the
SHA-256 of their abbreviated hash, so the order is reproducible and unrelated to content. Only hashes and file
counts are printed, so choosing does not expose the tasks.

    python3 scripts/select_upstream_features.py <eslint clone> [--exclude HASH ...]
"""
import argparse
import hashlib
import subprocess


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True).stdout


def qualifies(repo, commit):
    changed = [line.split('\t') for line in git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', commit).splitlines()]
    lib = [(status, path) for status, *paths in changed for path in paths[-1:] if path.startswith('lib/')]
    if any(status != 'M' for status, _ in lib) or not 2 <= len(lib) <= 5:
        return None
    if not any(path.startswith('tests/lib/') for _, *paths in changed for path in paths):
        return None
    if any(path == 'package.json' for _, *paths in changed for path in paths):
        return None
    return len(lib)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('repo')
    parser.add_argument('--exclude', nargs='*', default=[])
    args = parser.parse_args()
    log = git(args.repo, 'log', '--first-parent', '--since=2016-01-01', '--until=2017-12-31', '--format=%h %s', '--abbrev=8')
    candidates = []
    for line in log.splitlines():
        commit, subject = line.split(' ', 1)
        if not subject.startswith(('New:', 'Update:')) or any(commit.startswith(x) or x.startswith(commit) for x in args.exclude):
            continue
        files = qualifies(args.repo, commit)
        if files:
            candidates.append((hashlib.sha256(commit.encode()).hexdigest(), commit, files))
    for _, commit, files in sorted(candidates):
        print(commit, files)


if __name__ == '__main__':
    main()
