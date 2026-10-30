import { Doc, Frame, Group, Item, frameOfGroup } from "./tokens";
import { buildPrompt } from "./prompt";
import { isProject } from "./project";
import { Lang } from "./i18n";

/* Optional AI helpers. The browser talks to the model provider directly with the
 * author's own key; there is no server in between. Every action has a fixed
 * prompt and a fixed JSON answer shape, and the result is only applied after the
 * author has looked at it. Coordinates are never touched by the model. */

export type Provider = "claude" | "openai" | "gemini" | "deepseek";

export type AiSettings = {
  provider: Provider;
  baseUrl: string;
  model: string;
  key: string;
};

export const PROVIDERS: { key: Provider; label: string; baseUrl: string; model: string; keysUrl?: string }[] = [
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", keysUrl: "https://platform.openai.com/api-keys" },
  { key: "claude", label: "Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", keysUrl: "https://console.anthropic.com/settings/keys" },
  { key: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", keysUrl: "https://aistudio.google.com/apikey" },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", keysUrl: "https://platform.deepseek.com/api_keys" },
];

export const providerSpec = (k: Provider) => PROVIDERS.find((p) => p.key === k) ?? PROVIDERS[0];

export const DEFAULT_AI: AiSettings = { provider: PROVIDERS[0].key, baseUrl: PROVIDERS[0].baseUrl, model: PROVIDERS[0].model, key: "" };

const STORE_KEY = "m3e:ai";

/** Models that older versions saved as defaults. A custom model is never replaced. */
const LEGACY_MODELS: Record<Provider, string[]> = {
  openai: ["gpt-5.6-luna"],
  claude: [],
  gemini: [],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
};

/** Provider URLs whose API root moved, but which still describe the provider itself. */
const LEGACY_BASE_URLS: Partial<Record<Provider, string[]>> = {
  deepseek: ["https://api.deepseek.com/v1"],
};

/** Parse settings from storage and move known stale defaults to the current recommended model. */
export function normalizeAiSettings(v: Partial<AiSettings> | null | undefined): AiSettings {
  const provider = PROVIDERS.some((p) => p.key === v?.provider) ? (v!.provider as Provider) : DEFAULT_AI.provider;
  const spec = providerSpec(provider);
  const rawUrl = typeof v?.baseUrl === "string" ? v.baseUrl.trim() : "";
  const baseUrl = rawUrl && !LEGACY_BASE_URLS[provider]?.includes(rawUrl) ? rawUrl : spec.baseUrl;
  const rawModel = typeof v?.model === "string" ? v.model.trim() : "";
  const model = rawModel && !LEGACY_MODELS[provider].includes(rawModel) ? rawModel : spec.model;
  return {
    provider,
    baseUrl,
    model,
    key: typeof v?.key === "string" ? v.key : "",
  };
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeAiSettings(JSON.parse(raw) as Partial<AiSettings>);
  } catch {}
  return { ...DEFAULT_AI };
}

/** Settings live in this browser only, like the document itself. */
export function saveAiSettings(s: AiSettings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {}
}

const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u.trim());

/** a hosted endpoint needs a key; a server on this machine may run without one */
export const hasKey = (s: AiSettings) => s.key.trim().length > 0 || isLocal(s.baseUrl);

/** the key must not travel over plain http, except to this machine */
export const isSecureUrl = (u: string) => /^https:\/\//i.test(u.trim()) || isLocal(u);

const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {}
  }
  return `${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/** one round trip: a system prompt and a user message in, the model's text out */
export async function complete(s: AiSettings, system: string, user: string, signal?: AbortSignal, maxTokens = 4096): Promise<string> {
  const base = trimSlash(s.baseUrl);
  const model = s.model.trim();
  if (!model) throw new Error("model");
  if (!isSecureUrl(base)) throw new Error("insecure");
  if (s.provider === "claude") {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": s.key.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: Math.min(maxTokens, 8192), system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const j = await res.json();
    if (j.stop_reason === "refusal") throw new Error("refusal");
    if (j.stop_reason === "max_tokens") throw new Error("long");
    return (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.key.trim()) headers.authorization = `Bearer ${s.key.trim()}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model,
      /* OpenAI's newer models refuse `max_tokens` and default generously, so they get no budget;
         the other compatible endpoints cap around 8k */
      ...(s.provider === "openai" ? {} : { max_tokens: Math.min(maxTokens, 8192) }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const j = await res.json();
  if (j.choices?.[0]?.finish_reason === "length") throw new Error("long");
  const c = j.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: { text?: string }) => x.text ?? "").join("");
  throw new Error("empty");
}

/** Verify the provider settings with the smallest possible model request. */
export async function testConnection(s: AiSettings, signal?: AbortSignal): Promise<string> {
  if (!hasKey(s)) throw new Error("key");
  if (!s.model.trim()) throw new Error("model");
  if (!isSecureUrl(s.baseUrl)) throw new Error("insecure");

  const ac = new AbortController();
  let timedOut = false;
  const cancel = () => ac.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, 20_000);
  try {
    const reply = await complete(
      s,
      "You are a connectivity check. Follow the user's instruction exactly.",
      "Reply with exactly: CONNECTED",
      ac.signal,
      24,
    );
    if (!reply.trim()) throw new Error("empty");
    return reply.trim().slice(0, 200);
  } catch (e) {
    if (timedOut) throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/** the first JSON object in a reply, with any code fence stripped */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("json");
  const v = JSON.parse(cleaned.slice(a, b + 1));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("json");
  return v as Record<string, unknown>;
}

/* ---------- actions ---------- */

const LANG_NAME: Record<Lang, string> = { ja: "Japanese", en: "English", zh: "Simplified Chinese", ko: "Korean" };

const hasText = (v?: string | null) => !!v && v.trim().length > 0;

const itemsOnFrame = (doc: Doc, frame: Frame, widths: Record<string, number>): Item[] =>
  doc.groups.filter((g: Group) => frameOfGroup(g, doc.frames, widths)?.id === frame.id).flatMap((g) => g.items);

const describeItem = (it: Item) => {
  const bits = [`id=${it.id}`, `kind=${it.kind}`];
  if (hasText(it.label)) bits.push(`label=${JSON.stringify(it.label)}`);
  if (hasText(it.supporting)) bits.push(`supporting=${JSON.stringify(it.supporting)}`);
  if (it.icon) bits.push(`icon=${it.icon}`);
  if (it.tabs?.length) bits.push(`items=${JSON.stringify(it.tabs.map((t) => t.label || t.icon))}`);
  if (it.action) bits.push(`tap=${it.action.to}`);
  if (it.toggle) bits.push("toggle");
  if (hasText(it.note)) bits.push(`current_note=${JSON.stringify(it.note)}`);
  return bits.join(" ");
};

const context = (doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang) =>
  [
    "The author is sketching a Material 3 Expressive app. Below is the generated description of the whole design, then the screen to work on.",
    "",
    "=== Whole design ===",
    buildPrompt(doc, widths, undefined, lang),
    "",
    `=== Screen to work on: ${JSON.stringify(frame.name || "(unnamed)")} ===`,
  ].join("\n");

const SYSTEM = "You help an app designer finish a sketch. Answer with a single JSON object and nothing else: no prose, no markdown fence.";

/** picks the strings the model returned for exactly the parts asked about */
function pickStrings(v: unknown, parts: Item[], max: number): Record<string, string> {
  const map = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const it of parts) {
    const s = map[it.id];
    if (typeof s === "string" && s.trim()) out[it.id] = s.trim().slice(0, max);
  }
  return out;
}

/** a short behavior note for one part; an existing note is refined rather than replaced */
export async function proposeBehavior(s: AiSettings, doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang, itemId: string, signal?: AbortSignal): Promise<string | undefined> {
  const parts = itemsOnFrame(doc, frame, widths).filter((it) => it.id === itemId);
  if (!parts.length) return undefined;
  const user = [
    context(doc, widths, frame, lang),
    "",
    "For the part listed below, write what happens when the user interacts with it: what it does, where it leads, what it shows. One sentence, concrete, in the voice of a product spec (no 'should', no hedging). Infer from the labels, icons and the other screens; do not invent screens that do not exist.",
    "A part with a current_note already has the author's own wording: keep its intent and facts, and improve it (clearer, more specific, consistent with the rest of the screen). Do not contradict it.",
    `Write in ${LANG_NAME[lang]}.`,
    "",
    "Part:",
    describeItem(parts[0]),
    "",
    'Answer as {"notes": {"<id>": "<sentence>"}} using exactly the id above.',
  ].join("\n");
  const j = parseJsonObject(await complete(s, SYSTEM, user, signal));
  return pickStrings(j.notes, parts, 300)[itemId];
}

/** a name (only when the screen has none) and a one-line purpose for the screen; an existing description is refined */
export async function proposeDescription(s: AiSettings, doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang, signal?: AbortSignal): Promise<{ name?: string; note: string }> {
  const user = [
    context(doc, widths, frame, lang),
    "",
    "Describe this screen's purpose in one or two sentences: who opens it, what they see and what they can do here. Also propose a short screen name (one to three words).",
    hasText(frame.note) ? `The author's current description is ${JSON.stringify(frame.note)}: keep its intent and facts, and improve it.` : "",
    `Write in ${LANG_NAME[lang]}.`,
    "",
    'Answer as {"name": "<name>", "description": "<sentences>"}.',
  ]
    .filter((l) => l !== "")
    .join("\n");
  const j = parseJsonObject(await complete(s, SYSTEM, user, signal));
  const note = typeof j.description === "string" ? j.description.trim().slice(0, 400) : "";
  if (!note) throw new Error("json");
  const name = typeof j.name === "string" ? j.name.trim().slice(0, 40) : "";
  return { name: !hasText(frame.name) && name ? name : undefined, note };
}

/** the value a rewritten field had before, so the rewrite can be undone; an empty field leaves nothing to go back to */
export const pushHistory = (history: string[] | undefined, replaced: string | undefined): string[] | undefined => {
  const cur = (replaced ?? "").trim();
  return cur ? [cur] : history?.length ? history : undefined;
};

/** the patch that swaps a field with what it said before the AI wrote it; pressing again swaps back */
export function popHistory<V extends string, H extends string>(current: string | undefined, history: string[] | undefined, valueKey: V, historyKey: H): Record<V, string> & Record<H, string[] | undefined> {
  const [prev] = history ?? [];
  const cur = (current ?? "").trim();
  return { [valueKey]: prev ?? "", [historyKey]: cur ? [cur] : undefined } as Record<V, string> & Record<H, string[] | undefined>;
}

/** A whole design from an idea, drafted by the author's own model. `guide` is the same
 *  agent guide a coding agent reads (public/agent.md), so both paths follow one spec.
 *  The answer is the document itself; a link would be pointless here. */
export async function draftDesign(s: AiSettings, guide: string, idea: string, lang: Lang, signal?: AbortSignal): Promise<Doc> {
  const system = [
    "You draft M3E Canvas designs. Follow the guide below exactly.",
    "Reply with the JSON document only: no share link, no prose, no markdown fence, no explanation.",
    "",
    guide,
  ].join("\n");
  const user = [`Sketch this app: ${idea.trim()}`, `Write every label, title and note in ${LANG_NAME[lang]}.`, "Three to five screens. Keep it simple."].join("\n");
  const j = parseJsonObject(await complete(s, system, user, signal, 12000));
  if (!isProject(j)) throw new Error("json");
  return j;
}

