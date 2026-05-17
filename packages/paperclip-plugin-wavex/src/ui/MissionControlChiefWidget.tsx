/** Mission Control — Chief of Staff (Phase 6).
 *
 *  Shows the current chief config + rules + a one-click "evaluate now"
 *  button. Triggered evaluations emit chief_pattern_detected and
 *  chief_rebalance_recommended events that show up live in the Stream
 *  widget above. Operators can toggle rules on/off here and add new
 *  rules via a small form. */

import { useEffect, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

type TriggerKind =
  | "kpi_threshold"
  | "kpi_variance"
  | "schedule"
  | "pattern"
  | "capacity_imbalance";

interface ChiefRule {
  id: string;
  name: string;
  description: string;
  triggerKind: TriggerKind;
  triggerConfig: Record<string, unknown>;
  enabled: boolean;
}
interface ChiefConfig {
  instanceId: string;
  enabled: boolean;
  mode: string;
  dailyBudgetUSD: number;
  cooldownMinutes: number;
  maxOriginationsPerDay: number;
  responsibilities: string[];
  originationRules: ChiefRule[];
}
interface ChiefResponse {
  ok: boolean;
  config: ChiefConfig | null;
  error?: string;
}

interface EvaluationTriggered {
  ruleId: string;
  ruleName: string;
  triggerKind: string;
  detail: string;
  eventKind: string;
}

export function MissionControlChiefWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<ChiefResponse>(
    "mission-control-chief",
    { companyId },
  );
  const evaluate = usePluginAction("mission-control-chief-evaluate");
  const upsertConfig = usePluginAction("mission-control-chief-upsert-config");
  const addRule = usePluginAction("mission-control-chief-add-rule");
  const toggleRule = usePluginAction("mission-control-chief-toggle-rule");

  const [lastResult, setLastResult] = useState<{
    triggered: EvaluationTriggered[];
    skipped: number;
    evaluatedRules: number;
  } | null>(null);
  const [newRule, setNewRule] = useState({
    name: "",
    triggerKind: "kpi_threshold" as TriggerKind,
    kpiId: "",
    minRatio: 0.7,
  });

  useEffect(() => {
    setLastResult(null);
  }, [companyId]);

  if (!companyId) {
    return (
      <Card label="Mission Control — Chief of Staff">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }
  if (loading && !data) {
    return (
      <Card label="Mission Control — Chief of Staff">
        <div style={{ opacity: 0.6 }}>Loading chief config…</div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card label="Mission Control — Chief of Staff">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't load: {error.message}{" "}
          <button type="button" onClick={refresh} style={linkStyle}>
            retry
          </button>
        </div>
      </Card>
    );
  }
  const cfg = data?.config;

  return (
    <Card label="Mission Control — Chief of Staff">
      {!cfg ? (
        <div>
          <div style={{ opacity: 0.7, marginBottom: 8 }}>
            No chief config for this instance yet.
          </div>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={async () => {
              await upsertConfig({
                companyId,
                mode: "solo_founder",
                enabled: true,
              });
              refresh();
            }}
          >
            create default config
          </button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
            <strong>{cfg.mode}</strong> · daily budget $
            {cfg.dailyBudgetUSD.toFixed(2)} · cooldown {cfg.cooldownMinutes}m ·
            max {cfg.maxOriginationsPerDay} originations/day ·{" "}
            {cfg.enabled ? "enabled" : "disabled"}
          </div>
          <h4 style={subHeadingStyle}>Origination rules</h4>
          {cfg.originationRules.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 10 }}>
              No rules yet — add one below.
            </div>
          ) : (
            <ul style={listStyle}>
              {cfg.originationRules.map((rule) => (
                <li
                  key={rule.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    fontSize: 13,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <div>
                    <strong>{rule.name}</strong>
                    <div style={{ fontSize: 11, opacity: 0.6 }}>
                      {rule.triggerKind} ·{" "}
                      {JSON.stringify(rule.triggerConfig).slice(0, 80)}
                    </div>
                  </div>
                  <label
                    style={{
                      fontSize: 11,
                      opacity: 0.85,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={async (e) => {
                        await toggleRule({
                          ruleId: rule.id,
                          enabled: e.target.checked,
                        });
                        refresh();
                      }}
                      style={{ marginRight: 4 }}
                    />
                    enabled
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newRule.name) return;
              const triggerConfig: Record<string, unknown> =
                newRule.triggerKind === "kpi_threshold" ||
                newRule.triggerKind === "kpi_variance"
                  ? { kpiId: newRule.kpiId, minRatio: newRule.minRatio }
                  : {};
              await addRule({
                companyId,
                name: newRule.name,
                triggerKind: newRule.triggerKind,
                triggerConfig,
              });
              setNewRule({ ...newRule, name: "" });
              refresh();
            }}
            style={{
              display: "grid",
              gap: 6,
              gridTemplateColumns: "1fr 1fr",
              marginTop: 8,
            }}
          >
            <input
              type="text"
              value={newRule.name}
              onChange={(e) =>
                setNewRule({ ...newRule, name: e.target.value })
              }
              placeholder="Rule name"
              style={inputStyle}
            />
            <select
              value={newRule.triggerKind}
              onChange={(e) =>
                setNewRule({
                  ...newRule,
                  triggerKind: e.target.value as TriggerKind,
                })
              }
              style={selectStyle}
            >
              <option value="kpi_threshold">kpi_threshold</option>
              <option value="kpi_variance">kpi_variance</option>
              <option value="capacity_imbalance">capacity_imbalance</option>
              <option value="schedule">schedule</option>
              <option value="pattern">pattern (no-op)</option>
            </select>
            {newRule.triggerKind === "kpi_threshold" ||
            newRule.triggerKind === "kpi_variance" ? (
              <>
                <input
                  type="text"
                  value={newRule.kpiId}
                  onChange={(e) =>
                    setNewRule({ ...newRule, kpiId: e.target.value })
                  }
                  placeholder="kpiId"
                  style={inputStyle}
                />
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="2"
                  value={newRule.minRatio}
                  onChange={(e) =>
                    setNewRule({
                      ...newRule,
                      minRatio: Number(e.target.value),
                    })
                  }
                  placeholder="min ratio"
                  style={inputStyle}
                />
              </>
            ) : null}
            <button
              type="submit"
              style={{ ...primaryButtonStyle, gridColumn: "1 / -1" }}
            >
              add rule
            </button>
          </form>
          <div
            style={{
              marginTop: 12,
              paddingTop: 8,
              borderTop: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 6,
            }}
          >
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={async () => {
                const res = (await evaluate({ companyId })) as {
                  result?: typeof lastResult;
                };
                if (res?.result) setLastResult(res.result);
              }}
            >
              evaluate now
            </button>
            {lastResult ? (
              <div style={{ fontSize: 11, opacity: 0.75 }}>
                {lastResult.triggered.length} fired ·{" "}
                {lastResult.skipped} skipped
              </div>
            ) : null}
          </div>
          {lastResult && lastResult.triggered.length > 0 ? (
            <ul style={{ ...listStyle, marginTop: 6 }}>
              {lastResult.triggered.map((t, i) => (
                <li
                  key={i}
                  style={{ fontSize: 12, opacity: 0.85, padding: "2px 0" }}
                >
                  <span style={{ color: WAVEX_COLOR }}>{t.ruleName}</span>:{" "}
                  {t.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Card>
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

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const subHeadingStyle: React.CSSProperties = {
  margin: "4px 0",
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  opacity: 0.65,
  color: WAVEX_COLOR,
};
const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
};
const selectStyle: React.CSSProperties = inputStyle;
const linkStyle: React.CSSProperties = {
  background: "none",
  color: WAVEX_COLOR,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
const primaryButtonStyle: React.CSSProperties = {
  background: `color-mix(in srgb, ${WAVEX_COLOR} 18%, transparent)`,
  color: WAVEX_COLOR,
  border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 45%, transparent)`,
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};
