/** Mission Control — ScopeNode profile (Phase 4).
 *
 *  Operator picks a node from the dropdown (sourced from the same
 *  scope-tree handler the Stream widget uses) and sees: open
 *  assignments to that node, plus a free-form task-id input that lets
 *  them inspect the full assignment chain for any task. Mode-aware
 *  via the node names in the scope tree. */

import { useEffect, useMemo, useState } from "react";
import {
  usePluginData,
  type PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";
import type { AssignmentLink } from "@wavex-os/shared/types/mission-control";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface ScopeNode {
  id: string;
  name: string;
  kind: string;
}
interface ScopeTreeResponse {
  ok: boolean;
  tree?: { nodes?: ScopeNode[] };
}

interface OpenAssignment {
  id: string;
  taskRefId: string;
  kind: string;
  fromNodeId: string | null;
  toNodeId: string | null;
  reason: string | null;
  at: string;
}
interface OpenAssignmentsResponse {
  ok: boolean;
  open: OpenAssignment[];
  error?: string;
}

interface ChainResponse {
  ok: boolean;
  chain: AssignmentLink[];
  currentOwner: string | null;
  error?: string;
}

export function MissionControlNodeProfileWidget({
  context,
}: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const tree = usePluginData<ScopeTreeResponse>(
    "mission-control-scope-tree",
    { companyId },
  );
  const nodes = useMemo(() => tree.data?.tree?.nodes ?? [], [tree.data]);

  const [selectedNode, setSelectedNode] = useState<string>("");
  useEffect(() => {
    if (!selectedNode && nodes.length > 0) setSelectedNode(nodes[0]!.id);
  }, [nodes, selectedNode]);

  const open = usePluginData<OpenAssignmentsResponse>(
    "mission-control-node-open-assignments",
    { companyId, nodeId: selectedNode },
  );

  const [taskInput, setTaskInput] = useState("");
  const [pendingTaskId, setPendingTaskId] = useState("");
  const chain = usePluginData<ChainResponse>(
    "mission-control-task-chain",
    pendingTaskId ? { companyId, taskRefId: pendingTaskId } : { companyId },
  );

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  if (!companyId) {
    return (
      <Card label="Mission Control — Node Profile">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }

  return (
    <Card label="Mission Control — Node Profile">
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label
            htmlFor="mc-node-picker"
            style={{ fontSize: 11, opacity: 0.65, textTransform: "uppercase" }}
          >
            Node
          </label>
          <select
            id="mc-node-picker"
            value={selectedNode}
            onChange={(e) => setSelectedNode(e.target.value)}
            style={selectStyle}
          >
            {nodes.length === 0 ? (
              <option value="">(no nodes — scope tree empty)</option>
            ) : (
              nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} · {n.kind}
                </option>
              ))
            )}
          </select>
        </div>

        <section>
          <h4 style={subHeadingStyle}>Open assignments</h4>
          {open.loading && !open.data ? (
            <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
          ) : open.error ? (
            <div style={{ color: "#ff6b6b", fontSize: 13 }}>
              {open.error.message}
            </div>
          ) : (open.data?.open ?? []).length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 13 }}>
              No open assignments for this node.
            </div>
          ) : (
            <ul style={listStyle}>
              {(open.data?.open ?? []).map((row) => (
                <li
                  key={row.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    setTaskInput(row.taskRefId);
                    setPendingTaskId(row.taskRefId);
                  }}
                >
                  <strong style={{ color: WAVEX_COLOR }}>
                    {row.taskRefId.slice(0, 12)}
                  </strong>{" "}
                  · {row.kind}
                  {row.reason ? (
                    <span style={{ opacity: 0.6 }}> — {row.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 style={subHeadingStyle}>Inspect chain</h4>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setPendingTaskId(taskInput.trim());
            }}
            style={{ display: "flex", gap: 6, marginBottom: 8 }}
          >
            <input
              type="text"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="task-ref-id"
              style={{ ...selectStyle, flex: 1, fontFamily: "ui-monospace, monospace" }}
            />
            <button type="submit" style={{ ...linkStyle, padding: "3px 8px" }}>
              load
            </button>
          </form>
          {pendingTaskId ? (
            chain.loading && !chain.data ? (
              <div style={{ opacity: 0.6, fontSize: 13 }}>Loading chain…</div>
            ) : chain.error ? (
              <div style={{ color: "#ff6b6b", fontSize: 13 }}>
                {chain.error.message}
              </div>
            ) : (chain.data?.chain ?? []).length === 0 ? (
              <div style={{ opacity: 0.7, fontSize: 13 }}>
                No chain entries for {pendingTaskId}.
              </div>
            ) : (
              <ChainView
                chain={chain.data!.chain}
                currentOwner={chain.data!.currentOwner}
                nodeNameById={nodeNameById}
              />
            )
          ) : (
            <div style={{ opacity: 0.55, fontSize: 12 }}>
              Pick an open assignment above or paste a task id to reconstruct
              its full assignment chain.
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}

function ChainView({
  chain,
  currentOwner,
  nodeNameById,
}: {
  chain: AssignmentLink[];
  currentOwner: string | null;
  nodeNameById: Map<string, string>;
}) {
  const nm = (id: string) => (id ? nodeNameById.get(id) ?? id : "—");
  return (
    <div>
      {currentOwner ? (
        <div
          style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}
        >
          <strong style={{ color: WAVEX_COLOR }}>Current owner:</strong>{" "}
          {nm(currentOwner)}
        </div>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
          Chain terminal — no current owner.
        </div>
      )}
      <ol style={{ ...listStyle, paddingLeft: 14 }}>
        {chain.map((link, idx) => (
          <li
            key={idx}
            style={{
              padding: "4px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              fontSize: 13,
            }}
          >
            <span style={{ color: WAVEX_COLOR }}>
              {nm(link.fromNodeId)} → {nm(link.toNodeId)}
            </span>
            {link.reason ? (
              <span style={{ opacity: 0.7 }}> — {link.reason}</span>
            ) : null}
            <div style={{ fontSize: 11, opacity: 0.5 }}>
              {new Date(link.assignedAt).toLocaleString()}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      style={{
        padding: "12px 14px",
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 25%, transparent)`,
        background: WAVEX_BG,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 8,
          color: WAVEX_COLOR,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

const subHeadingStyle: React.CSSProperties = {
  margin: "4px 0",
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  opacity: 0.65,
  color: WAVEX_COLOR,
};
const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
};
const linkStyle: React.CSSProperties = {
  background: "none",
  color: WAVEX_COLOR,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
