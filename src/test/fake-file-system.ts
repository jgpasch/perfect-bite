// The bits of expo-file-system the App Group code uses, backed by real files under a temp directory.
//
// In a test file:
//   jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
//   beforeEach(() => setAppGroupRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'siri-'))));
//
// `setAppGroupRoot(null)` makes the App Group unavailable, as in Expo Go.
import fs from 'node:fs';
import path from 'node:path';

import { APP_GROUP_ID } from '@/features/siri/app-group';

type Part = string | File | Directory;

const join = (parts: Part[]) => path.join(...parts.map((p) => (typeof p === 'string' ? p : p.path)));

export class File {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = join(parts);
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
  create(): void {
    fs.writeFileSync(this.path, '', { flag: 'wx' });
  }
  write(text: string): void {
    fs.writeFileSync(this.path, text);
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
}

let root: string | null = null;

/** Points the App Group container at `dir`, or makes it unavailable with null. */
export function setAppGroupRoot(dir: string | null): void {
  root = dir;
}

export const Paths = {
  get appleSharedContainers(): Record<string, Directory> {
    return root ? { [APP_GROUP_ID]: new Directory(root) } : {};
  },
};
