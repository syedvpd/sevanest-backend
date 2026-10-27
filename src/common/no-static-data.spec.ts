import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for "everything the apps receive comes from the database": the people invented for local demos (src/seed-demo.ts) must not
 * appear in any other source file as data. They may appear only in documentation: OpenAPI `example:` values and comments.
 */
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) && !/^seed-demo/.test(name)
      ? [path]
      : [];
  });
}

function demoFirstNames(): string[] {
  const seed = readFileSync(join(SRC, 'seed-demo.ts'), 'utf8');
  const names = [...seed.matchAll(/'([A-Z][a-z]+) [A-Z][a-z]+'/g)].map((m) => m[1]);
  return [...new Set(names)];
}

describe('no static demo data in the source', () => {
  it('finds the demo names to look for', () => {
    expect(demoFirstNames().length).toBeGreaterThan(10);
  });

  it('keeps demo people out of everything except documentation examples and comments', () => {
    const names = demoFirstNames();
    const found: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          const documentation =
            /^(\*|\/\/|\/\*)/.test(code) || /\bexample:/.test(code) || /\bdescription:/.test(code);
          if (!documentation && names.some((n) => new RegExp(`\\b${n}\\b`).test(line))) {
            found.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${code.slice(0, 100)}`);
          }
        });
    }
    expect(found).toEqual([]);
  });
});
