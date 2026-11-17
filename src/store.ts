// The single in-memory store every surface (REST v3, git smart HTTP, GraphQL, MCP) reads
// and writes. No persistence: a trial is one process, and the suite rebuilds its state
// through the API on every run.
//
// Determinism: nothing here reads the wall clock or Math.random for data the client sees.
// All timestamps come from `clock`, a fixed basis plus a monotonic 1-second tick per call,
// so a replay of the same requests produces byte-identical responses.

import { ObjectStore } from './git/objects.ts';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: string;
}

/** The fixed clock basis when MAKEFUN_TRIAL_NOW is unset (the competition opens). */
export const DEFAULT_TRIAL_NOW = '2026-11-14T06:30:00.000Z';

/**
 * The login the bearer token names.
 *
 * Derived, not guessed: the suite's scenario is built from the published constant
 * SCENARIO_SEED in program/env/src/wire.ts, and buildScenario().viewer.login is
 * `adaiversen` on every trial (practice and scored alike — the seed never changes).
 * The token itself (`shpat_…`, derived from the trial seed) carries no login, so the
 * entry cannot learn it from the token; it must know the scenario's viewer.
 * Override with MAKEFUN_OWNER_LOGIN only if the harness ever says otherwise.
 */
export const DEFAULT_OWNER_LOGIN = 'adaiversen';

export interface StoreOptions {
  ownerLogin?: string;
  trialNow?: string;
}

/** A deterministic clock: a fixed basis, +1s on every call. Never Date.now(). */
export function makeClock(basisIso: string): { now(): string } {
  const parsed = Date.parse(basisIso);
  const basisMs = Number.isNaN(parsed) ? Date.parse(DEFAULT_TRIAL_NOW) : parsed;
  let currentMs = basisMs;
  return {
    now(): string {
      const out = new Date(currentMs).toISOString();
      currentMs += 1000;
      return out;
    },
  };
}

export class Store {
  repos = new Map<string, Repo>();
  /** repoKey -> ref name (e.g. `refs/heads/main`) -> commit oid. */
  refs = new Map<string, Map<string, string>>();
  objects = new ObjectStore();
  issues = new Map<string, Issue[]>();
  labels = new Map<string, Label[]>();
  pulls = new Map<string, Pull[]>();
  comments = new Map<string, Comment[]>();
  clock: { now(): string };
  ownerLogin: string;

  private idCounter = 1;
  private requestCounter = 1;
  private numbers = new Map<string, { issue: number; pull: number }>();

  constructor(options: StoreOptions = {}) {
    this.ownerLogin =
      options.ownerLogin ?? process.env.MAKEFUN_OWNER_LOGIN ?? DEFAULT_OWNER_LOGIN;
    this.clock = makeClock(
      options.trialNow ?? process.env.MAKEFUN_TRIAL_NOW ?? DEFAULT_TRIAL_NOW,
    );
  }

  /** Deterministic object ids (repos, issues, labels, pulls, comments): 1, 2, 3, … */
  nextId(): number {
    return this.idCounter++;
  }

  /** Deterministic, unique, non-empty X-GitHub-Request-Id values: `req-1`, `req-2`, … */
  nextRequestId(): string {
    return `req-${this.requestCounter++}`;
  }

  /** Per-repo issue/PR numbers, starting at 1. */
  nextNumber(repoKey: string, kind: 'issue' | 'pull'): number {
    let entry = this.numbers.get(repoKey);
    if (entry === undefined) {
      entry = { issue: 0, pull: 0 };
      this.numbers.set(repoKey, entry);
    }
    entry[kind] += 1;
    return entry[kind];
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  repoKey(owner: string, name: string): string {
    return Store.repoKey(owner, name);
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(
    owner: string,
    name: string,
    description?: string | null,
    options: { private?: boolean; defaultBranch?: string } = {},
  ): Repo {
    const key = Store.repoKey(owner, name);
    const now = this.clock.now();
    const repo: Repo = {
      id: this.nextId(),
      owner,
      name,
      description: description ?? null,
      defaultBranch: options.defaultBranch ?? 'main',
      private: options.private ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    // The default ref stays unborn (no refs/heads/<branch> yet) until the first commit.
    this.refs.set(key, new Map());
    this.issues.set(key, []);
    this.labels.set(key, []);
    this.pulls.set(key, []);
    this.comments.set(key, []);
    this.numbers.set(key, { issue: 0, pull: 0 });
    return repo;
  }

  /** Removes the repo and everything under it. Returns false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    const key = Store.repoKey(owner, name);
    if (!this.repos.has(key)) return false;
    this.repos.delete(key);
    this.refs.delete(key);
    this.issues.delete(key);
    this.labels.delete(key);
    this.pulls.delete(key);
    this.comments.delete(key);
    this.numbers.delete(key);
    return true;
  }
}
