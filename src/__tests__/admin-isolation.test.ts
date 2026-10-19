/**
 * @jest-environment node
 */
// admin/ is its own Next.js project (spec 4.12): the app's TypeScript, ESLint, Jest and Metro must leave it alone,
// or Next.js's React could clash with Expo's.
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../..');
const ADMIN = path.join(ROOT, 'admin');

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

describe('admin/ is kept apart from the app', () => {
  it('Metro blocks every file under admin/, and nothing else', () => {
    const config = require('../../metro.config.js');
    const blockList: RegExp[] = [].concat(config.resolver.blockList);
    const blocked = (file: string) => blockList.some((re) => re.test(file));

    expect(blocked(ADMIN)).toBe(true);
    expect(blocked(path.join(ADMIN, 'node_modules/react/index.js'))).toBe(true);
    expect(blocked(path.join(ADMIN, 'app/page.tsx'))).toBe(true);
    expect(blocked(path.join(ROOT, 'administrator/index.ts'))).toBe(false);
    expect(blocked(path.join(ROOT, 'src/features/admin/x.ts'))).toBe(false);
    expect(blocked(path.join(ROOT, 'src/app/_layout.tsx'))).toBe(false);
    expect(blocked(path.join(ROOT, 'node_modules/react/index.js'))).toBe(false);
  });

  it("keeps Expo's default blockList entries", () => {
    const config = require('../../metro.config.js');
    expect(config.resolver.blockList.length).toBeGreaterThan(1);
    expect([].concat(config.resolver.blockList).some((re: RegExp) => re.test('ios/Pods'))).toBe(true);
  });

  it('Jest ignores admin/ for tests and modules', () => {
    const { jest } = readJson('package.json');
    expect(jest.testPathIgnorePatterns).toContain('<rootDir>/admin/');
    expect(jest.modulePathIgnorePatterns).toContain('<rootDir>/admin/');
  });

  it('TypeScript excludes admin/', () => {
    expect(readJson('tsconfig.json').exclude).toContain('admin');
  });

  it('ESLint ignores admin/', () => {
    expect(fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8')).toContain("'admin/**'");
  });

  it('`yarn admin` runs the portal in its own project', () => {
    expect(readJson('package.json').scripts.admin).toBe('yarn --cwd admin dev');
    expect(readJson('admin/package.json').scripts.dev).toBe('next dev');
    expect(fs.existsSync(path.join(ADMIN, 'yarn.lock'))).toBe(true);
  });

  it('the portal is configured with only the URL and publishable key', () => {
    const keys = fs
      .readFileSync(path.join(ADMIN, '.env.example'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split('=')[0]);
    expect(keys).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
  });
});
