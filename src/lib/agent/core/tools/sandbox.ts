import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SandboxViolationError } from '../types/errors';
import type { Sandbox } from '../types/tools';

const isWindows = process.platform === 'win32';

function pathContains(root: string, target: string): boolean {
  // Case-folded on Windows, where `C:\WS` and `c:\ws` are the same directory and
  // a differently-cased prefix is still an escape attempt.
  const rel = path.relative(normCase(root), normCase(target));
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function normCase(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

function hasNullByte(p: string): boolean {
  return p.includes('\0');
}

export interface SandboxOptions {
  root: string;
  additionalRoots?: string[];
  allowSymlinksEscaping?: boolean;
}

export class PathSandbox implements Sandbox {
  readonly root: string;
  readonly additionalRoots: readonly string[];
  private readonly resolveLinks: boolean;

  constructor(opts: SandboxOptions) {
    this.root = path.resolve(opts.root);
    this.additionalRoots = (opts.additionalRoots ?? []).map((r) => path.resolve(r));
    this.resolveLinks = opts.allowSymlinksEscaping !== true;
  }

  isInside(absolutePath: string): boolean {
    const p = path.resolve(absolutePath);
    if (pathContains(this.root, p)) return true;
    return this.additionalRoots.some((r) => pathContains(r, p));
  }

  private assertInside(absolutePath: string, input: string): string {
    if (!this.isInside(absolutePath)) {
      throw new SandboxViolationError(input, `resolves outside the allowed workspace (${[this.root, ...this.additionalRoots].join(', ')})`);
    }
    return absolutePath;
  }

  resolveSync(inputPath: string): string {
    if (hasNullByte(inputPath)) throw new SandboxViolationError(inputPath, 'contains a NUL byte');
    const base = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(this.root, inputPath);
    return this.assertInside(base, inputPath);
  }

  async resolve(inputPath: string): Promise<string> {
    if (hasNullByte(inputPath)) throw new SandboxViolationError(inputPath, 'contains a NUL byte');
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(this.root, inputPath);
    this.assertInside(absolute, inputPath);
    if (!this.resolveLinks) return absolute;

    const real = await this.realpathWithFallback(absolute);
    return this.assertInside(real, inputPath);
  }

  private async realpathWithFallback(target: string): Promise<string> {
    let current = target;
    const tail: string[] = [];
    while (true) {
      try {
        const real = await fs.realpath(current);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
        const parent = path.dirname(current);
        if (parent === current) return target;
        tail.push(path.basename(current));
        current = parent;
      }
    }
  }
}

export function relativeToRoot(root: string, target: string): string {
  const rel = path.relative(root, target);
  return isWindows ? rel.split(path.sep).join('/') : rel;
}

export function displayPath(root: string, target: string): string {
  const rel = relativeToRoot(root, target);
  return rel.startsWith('..') ? target : rel;
}
