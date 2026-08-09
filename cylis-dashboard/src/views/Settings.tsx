import { Users, Lock } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Card, SectionLabel, Badge, Button, Th } from "@/components/ui";
import { alertConfig, rbacRoles } from "@/data/mockData";

export default function Settings() {
  const t = useTheme();

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
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Users</Th>
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
                  <td style={{ padding: "10px", ...monoFont }}>{r.users}</td>
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
