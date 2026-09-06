import { useEffect, useState } from "react";
import { Lock, X, Plus, Power, RefreshCw, LogIn } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th, Td } from "@/components/ui";
import { alertConfig, rbacRoles } from "@/data/mockData";
import { api } from "@/lib/api";
import { keycloak } from "@/lib/keycloak";

/** Shape of GET /api/v1/admin/users (admin-only) — src/admin/admin.controller.ts AdminUserView */
interface AdminUserView {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  roles: string[];
}

/** Turn an admin-mutation failure into the text the user should see. */
function errorMessage(e: any): string {
  const status = e?.response?.status;
  if (status === 409) return "ต้องเหลือ admin อย่างน้อย 1 คน";
  if (status === 403) return "แก้สิทธิ์หรือปิดบัญชีตัวเองไม่ได้";
  if (status === 401) return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่";
  return "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
}

type ConfirmState =
  | { kind: "removeRole"; userId: string; username: string; role: string }
  | { kind: "disableUser"; userId: string; username: string }
  | { kind: "addAdminRole"; userId: string; username: string }
  | null;

/** Small overlay confirm dialog — ui.tsx has no Dialog component, so this stays local to this page. */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: "90vw",
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 14,
          padding: 20,
          boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, ...sansFont }}>{title}</div>
        <div style={{ fontSize: 13, color: t.muted, marginTop: 8, lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <Button variant="ghost" small onClick={onCancel} disabled={busy}>
            ยกเลิก
          </Button>
          <Button variant="primary" small onClick={onConfirm} disabled={busy}>
            {busy ? "กำลังดำเนินการ…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Role pill with a remove ("x") button — Badge in ui.tsx has no built-in affordance for that. */
function RoleChip({ role, onRemove, disabled }: { role: string; onRemove: () => void; disabled: boolean }) {
  const t = useTheme();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 6px 3px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: "rgba(59,130,246,0.12)",
        color: t.blue2,
        border: "1px solid rgba(59,130,246,0.35)",
        ...monoFont,
      }}
    >
      {role}
      <button
        onClick={onRemove}
        disabled={disabled}
        title={`Remove ${role}`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          borderRadius: 999,
          border: "none",
          background: "rgba(59,130,246,0.18)",
          color: t.blue2,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          padding: 0,
        }}
      >
        <X size={10} />
      </button>
    </span>
  );
}

export default function Settings() {
  const t = useTheme();
  const currentUserId = keycloak.subject;

  const [users, setUsers] = useState<AdminUserView[] | null>(null);
  const [roles, setRoles] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [addRoleChoice, setAddRoleChoice] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null); // action key currently in flight
  const [actionError, setActionError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  function loadAll() {
    let cancelled = false;
    setLoading(true);
    setForbidden(false);
    setSessionExpired(false);
    setLoadError("");

    Promise.all([api.get<AdminUserView[]>("/admin/users"), api.get<string[]>("/admin/roles")])
      .then(([usersRes, rolesRes]) => {
        if (cancelled) return;
        setUsers(usersRes.data);
        setRoles(rolesRes.data);
      })
      .catch((e) => {
        if (cancelled) return;
        const status = e.response?.status;
        if (status === 401) setSessionExpired(true);
        else if (status === 403) setForbidden(true);
        else {
          console.error("admin users/roles fetch failed", e);
          setLoadError("โหลดรายชื่อผู้ใช้ไม่สำเร็จ");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }

  useEffect(loadAll, [reloadKey]);

  async function runAction(key: string, fn: () => Promise<any>) {
    setPending(key);
    setActionError("");
    try {
      await fn();
      setReloadKey((k) => k + 1); // last-admin/self rules live in the backend — always refetch, never assume
    } catch (e: any) {
      const status = e.response?.status;
      if (status === 401) setSessionExpired(true);
      else setActionError(errorMessage(e));
      console.error("admin action failed", e);
    } finally {
      setPending(null);
    }
  }

  function addRole(userId: string, role: string) {
    if (!role) return;
    runAction(`${userId}:role-add:${role}`, () => api.post(`/admin/users/${userId}/roles`, { role }));
  }

  function removeRole(userId: string, role: string) {
    runAction(`${userId}:role-remove:${role}`, () =>
      api.delete(`/admin/users/${userId}/roles/${role}`),
    );
  }

  function setEnabled(userId: string, enabled: boolean) {
    runAction(`${userId}:enabled`, () => api.patch(`/admin/users/${userId}`, { enabled }));
  }

  function closeConfirm() {
    if (pending) return; // don't let the dialog disappear mid-request
    setConfirm(null);
  }

  async function confirmAndRun() {
    if (!confirm) return;
    if (confirm.kind === "removeRole") {
      await runAction(`${confirm.userId}:role-remove:${confirm.role}`, () =>
        api.delete(`/admin/users/${confirm.userId}/roles/${confirm.role}`),
      );
    } else if (confirm.kind === "addAdminRole") {
      await runAction(`${confirm.userId}:role-add:admin`, () =>
        api.post(`/admin/users/${confirm.userId}/roles`, { role: "admin" }),
      );
    } else {
      await runAction(`${confirm.userId}:enabled`, () =>
        api.patch(`/admin/users/${confirm.userId}`, { enabled: false }),
      );
    }
    setConfirm(null);
  }

  // Per-role user counts come from GET /api/v1/admin/users (already fetched
  // above for the Users table), so this stays in sync with loading/forbidden.
  const showUsersColumn = !loading && !forbidden && !sessionExpired && users !== null;
  const userCounts: Record<string, number> = {};
  if (users) {
    for (const u of users) for (const role of u.roles) userCounts[role] = (userCounts[role] ?? 0) + 1;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <SectionLabel>Alert configuration</SectionLabel>
        <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
          {alertConfig.map((item) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderTop: `1px solid ${t.border}`,
                paddingTop: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                <div style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{item.desc}</div>
              </div>
              <Badge tone="blue">{item.value}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionLabel dot={t.cyan}>RBAC roles</SectionLabel>
        {forbidden && (
          <div style={{ fontSize: 11.5, color: t.muted, marginTop: 8 }}>
            User counts need the <b>admin</b> role — signed in as a different role, so that column is hidden.
          </div>
        )}
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <Th>Role</Th>
                {showUsersColumn && <Th>Users</Th>}
                <Th>Permissions</Th>
              </tr>
            </thead>
            <tbody>
              {rbacRoles.map((r) => (
                <tr key={r.role} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: "10px", display: "flex", alignItems: "center", gap: 8 }}>
                    <Lock size={13} color={t.blue2} />
                    {r.role}
                  </td>
                  {showUsersColumn && (
                    <td style={{ padding: "10px", ...monoFont }}>{userCounts[r.role] ?? 0}</td>
                  )}
                  <td style={{ padding: "10px", color: t.muted }}>{r.perms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel dot={t.blue}>Users</SectionLabel>
          <Button icon={RefreshCw} variant="ghost" small onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
            Refresh
          </Button>
        </div>

        {actionError && (
          <div style={{ marginTop: 12, color: t.danger, fontSize: 13, ...sansFont }}>{actionError}</div>
        )}

        {loading ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>Loading…</div>
        ) : sessionExpired ? (
          <div style={{ padding: 20 }}>
            <div style={{ color: t.warn, fontSize: 13 }}>เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่</div>
            <div style={{ marginTop: 12 }}>
              <Button icon={LogIn} small onClick={() => keycloak.login()}>
                เข้าสู่ระบบใหม่
              </Button>
            </div>
          </div>
        ) : forbidden ? (
          <div style={{ color: t.warn, padding: 20, fontSize: 13 }}>
            Not authorised — this page needs the <b>admin</b> role.
          </div>
        ) : loadError ? (
          <div style={{ padding: "20px 0 0" }}>
            <div style={{ color: t.danger, fontSize: 13 }}>{loadError}</div>
            <div style={{ marginTop: 12 }}>
              <Button icon={RefreshCw} small onClick={() => setReloadKey((k) => k + 1)}>
                ลองใหม่
              </Button>
            </div>
          </div>
        ) : !users || users.length === 0 ? (
          <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>No users found</div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <Th>Username</Th>
                  <Th>Email</Th>
                  <Th>Status</Th>
                  <Th>Roles</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = !!currentUserId && u.id === currentUserId;
                  const enabledPendingKey = `${u.id}:enabled`;
                  const isEnabledPending = pending === enabledPendingKey;
                  const assignableRoles = (roles ?? []).filter((r) => !u.roles.includes(r));
                  const choice = addRoleChoice[u.id] ?? assignableRoles[0] ?? "";
                  const addKey = `${u.id}:role-add:${choice}`;

                  return (
                    <tr key={u.id} style={{ borderTop: `1px solid ${t.border}` }}>
                      <Td style={{ fontWeight: 600 }}>{u.username}</Td>
                      <Td style={{ color: t.muted }}>{u.email ?? "—"}</Td>
                      <Td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Badge tone={u.enabled ? "good" : "danger"}>{u.enabled ? "Enabled" : "Disabled"}</Badge>
                          <Button
                            icon={Power}
                            variant="ghost"
                            small
                            disabled={isSelf || isEnabledPending}
                            onClick={() =>
                              u.enabled
                                ? setConfirm({ kind: "disableUser", userId: u.id, username: u.username })
                                : setEnabled(u.id, true)
                            }
                          >
                            {isEnabledPending ? "…" : u.enabled ? "Disable" : "Enable"}
                          </Button>
                        </div>
                      </Td>
                      <Td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                          {u.roles.length === 0 && <span style={{ color: t.muted, fontSize: 12 }}>—</span>}
                          {u.roles.map((role) => {
                            const removeKey = `${u.id}:role-remove:${role}`;
                            return (
                              <RoleChip
                                key={role}
                                role={role}
                                disabled={pending === removeKey}
                                onRemove={() => setConfirm({ kind: "removeRole", userId: u.id, username: u.username, role })}
                              />
                            );
                          })}
                          {assignableRoles.length > 0 && (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
                              <select
                                value={choice}
                                onChange={(e) =>
                                  setAddRoleChoice((prev) => ({ ...prev, [u.id]: e.target.value }))
                                }
                                disabled={pending === addKey}
                                style={{
                                  background: t.surface2,
                                  border: `1px solid ${t.border}`,
                                  borderRadius: 8,
                                  color: t.text,
                                  padding: "4px 6px",
                                  fontSize: 11.5,
                                  ...monoFont,
                                }}
                              >
                                {assignableRoles.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                              <Button
                                icon={Plus}
                                variant="subtle"
                                small
                                disabled={!choice || pending === addKey}
                                onClick={() =>
                                  choice === "admin"
                                    ? setConfirm({ kind: "addAdminRole", userId: u.id, username: u.username })
                                    : addRole(u.id, choice)
                                }
                              >
                                Add
                              </Button>
                            </div>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {confirm?.kind === "removeRole" && (
        <ConfirmDialog
          title="Remove role"
          body={`Remove role "${confirm.role}" from ${confirm.username}?`}
          confirmLabel="Remove"
          busy={pending === `${confirm.userId}:role-remove:${confirm.role}`}
          onConfirm={confirmAndRun}
          onCancel={closeConfirm}
        />
      )}
      {confirm?.kind === "addAdminRole" && (
        <ConfirmDialog
          title="Grant admin role"
          body={`Give "${confirm.username}" the admin role? This grants full access — admin can manage every user, role, and setting.`}
          confirmLabel="Grant admin"
          busy={pending === `${confirm.userId}:role-add:admin`}
          onConfirm={confirmAndRun}
          onCancel={closeConfirm}
        />
      )}
      {confirm?.kind === "disableUser" && (
        <ConfirmDialog
          title="Disable user"
          body={`Disable account "${confirm.username}"? They won't be able to sign in until re-enabled.`}
          confirmLabel="Disable"
          busy={pending === `${confirm.userId}:enabled`}
          onConfirm={confirmAndRun}
          onCancel={closeConfirm}
        />
      )}
    </div>
  );
}
