"use client";

import { useEffect, useRef, useState } from "react";
import { Palette } from "@/lib/tokens";
import { t, useLang } from "@/lib/i18n";
import { AiSettings, PROVIDERS, Provider, hasKey, isSecureUrl, providerSpec, testConnection } from "@/lib/ai";
import { Icon } from "./M3Node";

/** the message shown for a failed request, mapped from the error codes lib/ai throws */
export function aiErrorText(e: unknown, lang: ReturnType<typeof useLang>): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === "refusal") return t("aiErrorRefusal", lang);
  if (m === "json" || m === "empty") return t("aiErrorJson", lang);
  if (m === "key") return t("aiNoKey", lang);
  if (m === "model") return t("aiErrorModel", lang);
  if (m === "insecure") return t("aiErrorInsecure", lang);
  if (m === "timeout" || (e instanceof Error && e.name === "AbortError")) return t("aiErrorTimeout", lang);
  if (/failed to fetch|networkerror|load failed/i.test(m)) return t("aiErrorNetwork", lang);
  return `${t("aiError", lang)}: ${m}`;
}

export type AiActionKey = "behavior" | "describe";

/** The button that asks the model to write the field above it; spins while it works. */
export function AiWriteBtn({ p, busy, disabled, onClick, onCancel, label, title }: { p: Palette; busy: boolean; disabled?: boolean; onClick: () => void; onCancel: () => void; label: string; title: string }) {
  const lang = useLang();
  const shown = busy ? t("cancel", lang) : title;
  return (
    <button
      onClick={busy ? onCancel : onClick}
      disabled={disabled}
      title={shown}
      aria-label={shown}
      className="m3-press"
      style={{
        height: 40,
        padding: "0 16px 0 12px",
        borderRadius: 20,
        border: "none",
        background: disabled ? p.surfaceContainerHighest : p.primary,
        color: disabled ? p.onSurfaceVariant : p.onPrimary,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        flex: "0 0 auto",
        opacity: disabled ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <span className={busy ? "m3-spin" : undefined} style={{ display: "inline-flex" }}>
        <Icon name={busy ? "progress_activity" : "auto_awesome"} size={20} />
      </span>
      {/* both labels are laid out so the button keeps one width while it flips */}
      <span style={{ display: "grid" }}>
        <span style={{ gridArea: "1 / 1", visibility: busy ? "hidden" : "visible" }}>{label}</span>
        <span style={{ gridArea: "1 / 1", visibility: busy ? "visible" : "hidden", textAlign: "center" }}>{t("cancel", lang)}</span>
      </span>
    </button>
  );
}

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const field = (p: Palette): React.CSSProperties => ({
  width: "100%",
  height: 44,
  padding: "0 14px",
  borderRadius: 22,
  border: `1px solid ${p.outlineVariant}`,
  background: p.surface,
  color: p.onSurface,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  outline: "none",
  boxSizing: "border-box",
});

function Input({ value, onChange, placeholder, p, type = "text", label }: { value: string; onChange: (v: string) => void; placeholder?: string; p: Palette; type?: string; label: string }) {
  return <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" style={field(p)} />;
}

const Label = ({ children, p, right }: { children: React.ReactNode; p: Palette; right?: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: p.onSurfaceVariant, marginBottom: 6, padding: "0 4px" }}>
    <span style={{ flex: 1 }}>{children}</span>
    {right}
  </div>
);

/** The providers as one connected button group; each segment shows the provider's mark in the button's color. */
function ProviderGroup({ value, onChange, p }: { value: Provider; onChange: (k: Provider) => void; p: Palette }) {
  const n = PROVIDERS.length;
  const ref = useRef<HTMLDivElement>(null);
  const move = (from: number, delta: number) => {
    const to = (from + delta + n) % n;
    onChange(PROVIDERS[to].key);
    (ref.current?.children[to] as HTMLElement | undefined)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" style={{ display: "flex", gap: 3 }}>
      {PROVIDERS.map((pr, i) => {
        const on = pr.key === value;
        const outer = 22;
        const inner = 8;
        const l = i === 0 ? outer : inner;
        const r = i === n - 1 ? outer : inner;
        return (
          <button
            key={pr.key}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={pr.label}
            aria-label={pr.label}
            onClick={() => onChange(pr.key)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className="m3-press"
            style={{
              flex: 1,
              height: 44,
              border: "none",
              borderRadius: `${l}px ${r}px ${r}px ${l}px`,
              background: on ? p.primary : p.surfaceContainerHigh,
              color: on ? p.onPrimary : p.onSurfaceVariant,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              transition: "background 160ms, color 160ms",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                display: "block",
                background: "currentColor",
                WebkitMaskImage: `url(${BASE}/logos/${pr.key}.svg)`,
                maskImage: `url(${BASE}/logos/${pr.key}.svg)`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

type TestState = { kind: "idle" | "testing" | "ok" | "error"; message?: string };

/** The AI tab of the left rail: the provider settings. Changes are local until saved, and Test
 *  performs a real, minimal completion request against the selected model. */
export function AiPanel({
  p,
  settings,
  savedSettings,
  onChange,
  onSave,
}: {
  p: Palette;
  settings: AiSettings;
  savedSettings: AiSettings;
  onChange: (s: AiSettings) => void;
  onSave: (s: AiSettings) => void;
}) {
  const lang = useLang();
  const spec = providerSpec(settings.provider);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const testAbort = useRef<AbortController | null>(null);
  useEffect(() => () => testAbort.current?.abort(), []);

  const edit = (next: AiSettings) => {
    testAbort.current?.abort();
    setTest({ kind: "idle" });
    onChange(next);
  };
  const pick = (k: Provider) => {
    const s = providerSpec(k);
    edit({ ...settings, provider: k, baseUrl: s.baseUrl, model: s.model });
  };
  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const validBase = isSecureUrl(settings.baseUrl);
  const canSave = dirty && settings.model.trim().length > 0 && validBase;
  const testReason = !settings.model.trim()
    ? t("aiErrorModel", lang)
    : !validBase
      ? t("aiErrorInsecure", lang)
      : !hasKey(settings)
        ? t("aiNoKey", lang)
        : undefined;
  const canTest = !testReason && test.kind !== "testing";
  const save = () => {
    if (!canSave) return;
    onSave(settings);
    setTest((s) => (s.kind === "ok" ? s : { kind: "idle" }));
  };
  const runTest = async () => {
    if (!canTest) return;
    testAbort.current?.abort();
    const ac = new AbortController();
    testAbort.current = ac;
    setTest({ kind: "testing" });
    try {
      await testConnection(settings, ac.signal);
      setTest({ kind: "ok" });
    } catch (e) {
      if (!ac.signal.aborted) setTest({ kind: "error", message: aiErrorText(e, lang) });
    }
  };
  const status =
    test.kind === "testing"
      ? t("aiTesting", lang)
      : test.kind === "ok"
        ? t("aiTestSuccess", lang)
        : test.kind === "error"
          ? test.message
          : dirty
            ? t("aiUnsaved", lang)
            : t("aiSaved", lang);
  const statusColor = test.kind === "error" ? p.error : test.kind === "ok" ? p.primary : p.onSurfaceVariant;
  const actionButton = (label: string, icon: string, onClick: () => void, disabled: boolean, title: string, primary = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="m3-press"
      style={{
        flex: 1,
        height: 44,
        borderRadius: 22,
        border: primary ? "none" : `1px solid ${p.outlineVariant}`,
        background: disabled ? p.surfaceContainerHighest : primary ? p.primary : p.surface,
        color: disabled ? p.onSurfaceVariant : primary ? p.onPrimary : p.primary,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontSize: 13,
        fontWeight: 700,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.62 : 1,
      }}
    >
      <span className={test.kind === "testing" && !primary ? "m3-spin" : undefined} style={{ display: "inline-flex" }}>
        <Icon name={test.kind === "testing" && !primary ? "progress_activity" : icon} size={19} />
      </span>
      {label}
    </button>
  );
  return (
    <div className="no-scrollbar" style={{ height: "100%", overflowY: "auto", padding: "12px 12px 20px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: p.onSurfaceVariant, padding: "8px 6px 12px" }}>{t("aiSettings", lang)}</div>
      <div style={{ padding: "0 4px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <Label p={p}>{t("aiProvider", lang)}</Label>
            <ProviderGroup value={settings.provider} onChange={pick} p={p} />
          </div>
          <div>
            <Label p={p}>{t("aiModel", lang)}</Label>
            <Input label={t("aiModel", lang)} value={settings.model} onChange={(model) => edit({ ...settings, model })} placeholder={spec.model || "model"} p={p} />
            <div style={{ fontSize: 12, lineHeight: 1.5, color: p.onSurfaceVariant, marginTop: 8, padding: "0 4px" }}>{t("aiModelHint", lang)}</div>
          </div>
          <div>
            <Label p={p}>{t("aiBaseUrl", lang)}</Label>
            <Input label={t("aiBaseUrl", lang)} value={settings.baseUrl} onChange={(baseUrl) => edit({ ...settings, baseUrl })} placeholder={spec.baseUrl} p={p} />
          </div>
          <div>
            <Label
              p={p}
              right={
                spec.keysUrl && (
                  <a href={spec.keysUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: p.primary }}>
                    {t("aiGetKey", lang)}
                  </a>
                )
              }
            >
              {t("aiKey", lang)}
            </Label>
            <Input label={t("aiKey", lang)} value={settings.key} onChange={(key) => edit({ ...settings, key })} placeholder="sk-…" p={p} type="password" />
            <div style={{ fontSize: 12, lineHeight: 1.5, color: p.onSurfaceVariant, marginTop: 8, padding: "0 4px" }}>{t("aiKeyHint", lang)}</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {actionButton(t("aiSave", lang), "save", save, !canSave, dirty ? t("aiSave", lang) : t("aiSaved", lang), true)}
            {actionButton(
              test.kind === "testing" ? t("aiTesting", lang) : t("aiTest", lang),
              "network_check",
              () => void runTest(),
              !canTest,
              testReason ?? t("aiTestTitle", lang),
            )}
          </div>
          <div
            role="status"
            aria-live="polite"
            style={{ minHeight: 20, padding: "0 4px", fontSize: 12, lineHeight: 1.5, color: statusColor, textWrap: "pretty" }}
          >
            {status}
          </div>
        </div>
      </div>
    </div>
  );
}
