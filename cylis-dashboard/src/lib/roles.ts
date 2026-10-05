import { keycloak } from '@/lib/keycloak';

// Mirrors APP_ROLES in src/admin/admin.constants.ts (backend) — anything else
// in the token (offline_access, default-roles-*, …) is ignored here.
export const APP_ROLES = ['admin', 'operator', 'ingestor', 'analyst', 'auditor'] as const;

export type AppRole = (typeof APP_ROLES)[number];

// Page id (NAV_ITEMS in App.tsx) → roles that may see it. Matches what the
// backend @Roles allow for the APIs each page calls; hiding a page is only UX,
// the backend still enforces every request. Keep the order of NAV_ITEMS.
export const PAGE_ROLES: Record<string, readonly AppRole[]> = {
  dashboard: ['admin', 'analyst', 'operator'],
  logs: ['admin', 'analyst', 'operator'],
  ml: ['admin', 'analyst', 'operator'],
  dataset: ['admin', 'analyst', 'operator'],
  verify: ['admin', 'analyst', 'operator', 'auditor'],
  alerts: ['admin', 'analyst', 'operator'],
  reports: ['admin', 'auditor'],
  settings: ['admin'],
};

function isAppRole(role: unknown): role is AppRole {
  return typeof role === 'string' && (APP_ROLES as readonly string[]).includes(role);
}

// Same claim the backend reads (top-level `roles`, see jwt.strategy.ts);
// falls back to realm_access.roles when that mapper isn't on the token.
export function currentRoles(): AppRole[] {
  const parsed = keycloak.tokenParsed as
    | { roles?: unknown; realm_access?: { roles?: unknown } }
    | undefined;
  const raw = Array.isArray(parsed?.roles) ? parsed.roles : parsed?.realm_access?.roles;
  return Array.isArray(raw) ? raw.filter(isAppRole) : [];
}

export function canAccessPage(id: string): boolean {
  const allowed = PAGE_ROLES[id];
  if (!allowed) return false;
  const roles = currentRoles();
  return allowed.some((r) => roles.includes(r));
}

export function visiblePages(): string[] {
  return Object.keys(PAGE_ROLES).filter(canAccessPage);
}
