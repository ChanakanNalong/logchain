import { useEffect, useState } from "react";
import { Users, Lock } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th } from "@/components/ui";
import { alertConfig, rbacRoles } from "@/data/mockData";
import { api } from "@/lib/api";

/** Shape of GET /api/v1/admin/users (admin-only) */
interface AdminUserView {
  id: string;
  username: string;
  enabled: boolean;
  roles: string[];
}

export default function Settings() {
  const t = useTheme();

  // Per-role user counts come from GET /api/v1/admin/users, which is
  // admin-only. Non-admin viewers (and any other failure) get userCounts=null
  // and the Users column is hidden rather than showing a guessed number.
  const [userCounts, setUserCounts] = useState<Record<string, number> | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [countsForbidden, setCountsForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<AdminUserView[]>("/admin/users")
      .then((res) => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const u of res.data) {
          for (const role of u.roles) counts[role] = (counts[role] ?? 0) + 1;
        }
        setUserCounts(counts);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e.response?.status === 403) setCountsForbidden(true);
        else console.error("admin users fetch failed", e);
      })
      .finally(() => {
        if (!cancelled) setCountsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const showUsersColumn = !countsLoading && !countsForbidden && userCounts !== null;

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <SectionLabel dot={t.cyan}>RBAC roles</SectionLabel>
          <Button icon={Users} variant="subtle" small>
            Add role
          </Button>
        </div>
        {countsForbidden && (
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
                    <td style={{ padding: "10px", ...monoFont }}>{userCounts![r.role] ?? 0}</td>
                  )}
                  <td style={{ padding: "10px", color: t.muted }}>{r.perms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
