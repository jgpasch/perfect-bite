// The bits of expo-file-system the app's file code uses, backed by real files under a temp directory.
//
// In a test file:
//   jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
//   beforeEach(() => setAppGroupRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'siri-'))));
//
// `setAppGroupRoot(null)` makes the App Group unavailable, as in Expo Go. `Paths.document` is a temp
// directory of its own, or the one given to `setDocumentRoot`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { APP_GROUP_ID } from '@/features/siri/app-group';

type Part = string | File | Directory;

// A `file://` URI is its path, as for the real module.
const toPath = (p: string) => (p.startsWith('file://') ? decodeURI(p.slice('file://'.length)) : p);
const join = (parts: Part[]) => path.join(...parts.map((p) => (typeof p === 'string' ? toPath(p) : p.path)));

export class File {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}`;
  }
  get name(): string {
    return path.basename(this.path);
  }
  get exists(): boolean {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
  }
  textSync(): string {
    return fs.readFileSync(this.path, 'utf8');
  }
  async base64(): Promise<string> {
    return fs.readFileSync(this.path).toString('base64');
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = fs.readFileSync(this.path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  create(): void {
    fs.writeFileSync(this.path, '', { flag: 'wx' });
  }
  write(text: string): void {
    fs.writeFileSync(this.path, text);
  }
  /** Moves the file to `to` (a file, or a directory to move it into). Throws if it isn't there. */
  moveSync(to: File | Directory): void {
    const target = to instanceof Directory ? path.join(to.path, this.name) : to.path;
    fs.renameSync(this.path, target);
    (this as { path: string }).path = target;
  }
  delete(): void {
    fs.unlinkSync(this.path);
  }
}

export class Directory {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}/`;
  }
  get name(): string {
    return path.basename(this.path);
  }
  get exists(): boolean {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void {
    if (options?.idempotent && this.exists) return;
    fs.mkdirSync(this.path, { recursive: options?.intermediates ?? false });
  }
  list(): (File | Directory)[] {
    return fs
      .readdirSync(this.path, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? new Directory(this.path, e.name) : new File(this.path, e.name)));
  }
  /** Deletes the directory and everything in it. Throws if it isn't there. */
  delete(): void {
    if (!this.exists) throw new Error(`No directory ${this.path}`);
    fs.rmSync(this.path, { recursive: true });
  }
}

let root: string | null = null;
let documentRoot: string | null = null;

/** Points the App Group container at `dir`, or makes it unavailable with null. */
export function setAppGroupRoot(dir: string | null): void {
  root = dir;
}

/** Points `Paths.document` at `dir`. */
export function setDocumentRoot(dir: string): void {
  documentRoot = dir;
}

export const Paths = {
  get appleSharedContainers(): Record<string, Directory> {
    return root ? { [APP_GROUP_ID]: new Directory(root) } : {};
  },
  get document(): Directory {
    documentRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'document-'));
    return new Directory(documentRoot);
  },
};
