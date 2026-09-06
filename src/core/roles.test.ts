import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDefaultRoles, parseRoleFile } from './roles.js';

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles');
const ROLE_NAMES = ['boatswain', 'captain', 'cartographer', 'deckhand', 'lookout', 'scribe', 'watch'];

describe('parseRoleFile', () => {
  for (const name of ROLE_NAMES) {
    it(`parses ${name}.md`, () => {
      const content = readFileSync(join(ROLES_DIR, `${name}.md`), 'utf8');
      const role = parseRoleFile(`${name}.md`, content);
      expect(role.id).toBe(name);
      expect(role.name).toBe(name);
      expect(role.label.length).toBeGreaterThan(0);
      expect(role.mandate.length).toBeGreaterThan(0);
      expect(typeof role.canPropose).toBe('boolean');
    });
  }

  it('gives the captain its tools', () => {
    const content = readFileSync(join(ROLES_DIR, 'captain.md'), 'utf8');
    const role = parseRoleFile('captain.md', content);
    expect(role.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch']);
  });

  it('leaves the deckhand with no tools restriction', () => {
    const content = readFileSync(join(ROLES_DIR, 'deckhand.md'), 'utf8');
    const role = parseRoleFile('deckhand.md', content);
    expect(role.tools).toBeUndefined();
  });

  it('sets the lookout to canPropose: false', () => {
    const content = readFileSync(join(ROLES_DIR, 'lookout.md'), 'utf8');
    const role = parseRoleFile('lookout.md', content);
    expect(role.canPropose).toBe(false);
  });

  it('sets the scribe to canPropose: true', () => {
    const content = readFileSync(join(ROLES_DIR, 'scribe.md'), 'utf8');
    const role = parseRoleFile('scribe.md', content);
    expect(role.canPropose).toBe(true);
  });

  it('throws a clear error naming the file on a bad effort value', () => {
    const bad = [
      '---',
      'name: rogue',
      'label: Rogue',
      'model: claude-sonnet-5',
      'effort: extreme',
      'permissionMode: dontAsk',
      'canPropose: false',
      '---',
      'You are the rogue.',
    ].join('\n');
    expect(() => parseRoleFile('rogue.md', bad)).toThrow(/rogue\.md/);
    expect(() => parseRoleFile('rogue.md', bad)).toThrow(/effort/i);
  });

  it('throws a clear error naming the file on a bad permissionMode value', () => {
    const bad = [
      '---',
      'name: rogue',
      'label: Rogue',
      'model: claude-sonnet-5',
      'effort: high',
      'permissionMode: askNicely',
      'canPropose: false',
      '---',
      'You are the rogue.',
    ].join('\n');
    expect(() => parseRoleFile('rogue.md', bad)).toThrow(/rogue\.md/);
    expect(() => parseRoleFile('rogue.md', bad)).toThrow(/permissionMode/i);
  });
});

describe('loadDefaultRoles', () => {
  it('loads all seven real role files, sorted by name', () => {
    const roles = loadDefaultRoles();
    expect(roles.map((r) => r.name)).toEqual([...ROLE_NAMES].sort());
  });

  it('accepts an override directory', () => {
    const roles = loadDefaultRoles(ROLES_DIR);
    expect(roles.length).toBe(ROLE_NAMES.length);
  });
});
