// Loader for role mandates: parses the frontmatter + prose files in src/roles/*.md into Role
// objects. The mandate text (everything after the frontmatter) becomes the role's system prompt
// verbatim; nothing here rewrites it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffortLevel, PermissionMode, Role } from './types.js';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
];

function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

interface Frontmatter {
  [key: string]: string;
}

function splitFrontmatter(content: string, fileName: string): { frontmatter: Frontmatter; body: string } {
  const lines = content.split('\n');
  if (lines[0] === undefined || lines[0].trim() !== '---') {
    throw new Error(`${fileName}: missing frontmatter block, expected '---' on the first line`);
  }

  const frontmatter: Frontmatter = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`${fileName}: malformed frontmatter line '${line}'`);
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  if (i >= lines.length) {
    throw new Error(`${fileName}: unterminated frontmatter block, missing closing '---'`);
  }

  const body = lines.slice(i + 1).join('\n');
  return { frontmatter, body };
}

function requireField(frontmatter: Frontmatter, key: string, fileName: string): string {
  const value = frontmatter[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`${fileName}: missing required frontmatter field '${key}'`);
  }
  return value;
}

export function parseRoleFile(name: string, content: string): Role {
  const { frontmatter, body } = splitFrontmatter(content, name);

  const roleName = requireField(frontmatter, 'name', name);
  const label = requireField(frontmatter, 'label', name);
  const model = requireField(frontmatter, 'model', name);
  const effort = requireField(frontmatter, 'effort', name);
  const permissionMode = requireField(frontmatter, 'permissionMode', name);
  const canProposeRaw = requireField(frontmatter, 'canPropose', name);
  const toolsRaw = frontmatter['tools'];

  if (!isEffortLevel(effort)) {
    throw new Error(`${name}: invalid effort '${effort}', expected one of ${EFFORT_LEVELS.join(', ')}`);
  }
  if (!isPermissionMode(permissionMode)) {
    throw new Error(
      `${name}: invalid permissionMode '${permissionMode}', expected one of ${PERMISSION_MODES.join(', ')}`,
    );
  }
  if (canProposeRaw !== 'true' && canProposeRaw !== 'false') {
    throw new Error(`${name}: invalid canPropose '${canProposeRaw}', expected 'true' or 'false'`);
  }

  const tools =
    toolsRaw !== undefined
      ? toolsRaw
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : undefined;

  return {
    id: roleName,
    name: roleName,
    label,
    mandate: body.trim(),
    model,
    effort,
    tools,
    permissionMode,
    canPropose: canProposeRaw === 'true',
  };
}

// Two levels up from src/core (or dist/core) always lands on the project root, so this
// resolves to src/roles whether the module is running from source (tsx) or from dist (node).
const DEFAULT_ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'roles');

export function loadDefaultRoles(dir?: string): Role[] {
  const rolesDir = dir ?? DEFAULT_ROLES_DIR;
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.md'));

  const roles = files.map((file) => {
    const filePath = join(rolesDir, file);
    const content = readFileSync(filePath, 'utf8');
    return parseRoleFile(file, content);
  });

  return roles.sort((a, b) => a.name.localeCompare(b.name));
}
