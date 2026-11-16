import { Injectable, inject, signal } from '@angular/core';
import { Measurement } from '../../models/elements';
import { Pt, Rect, TakeoffItem } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { PageGeometry, renderRegion } from '../pdf-render/pdf-render';
import { TextSearch } from '../text-search/text-search';

// AI assistant of the right side bar: connects to Claude, ChatGPT or Gemini with the user's own
// API key, shows the model the sheet (pictures of the page plus the text on it with positions)
// and the count takeoff items, and puts the counts the model finds straight into the drawing.

export type AiProvider = 'claude' | 'openai' | 'gemini';
export type AiDetail = 1 | 2 | 3;            // the page is sent as 1, 2×2 or 3×3 pictures

export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  defaultModel: string;
  models: string[];                          // suggestions; any model id can be typed
  keyUrl: string;                            // where the user gets an API key
  keyHint: string;
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: 'claude', name: 'Claude', defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…',
  },
  {
    id: 'openai', name: 'ChatGPT', defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
    keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
  },
  {
    id: 'gemini', name: 'Gemini', defaultModel: 'gemini-2.5-pro',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
  },
];

interface StoredSettings {
  provider: AiProvider;
  remember: boolean;
  keys: Partial<Record<AiProvider, string>>;
  models: Partial<Record<AiProvider, string>>;
}

// One picture of the page sent to the model
interface Tile { region: Rect; scale: number; width: number; height: number; jpeg: string; }

// What the model answers (the same shape for the three providers)
interface AiMark { tile: number; x: number; y: number; text_id: number; }
interface AiAnswer { items: { item_id: string; marks: AiMark[] }[]; notes: string; }

export interface AiRunResult {
  pageIndex: number;
  added: { name: string; color: string; count: number }[];
  skipped: number;                           // already counted at the same spot
  notes: string;
}

const SETTINGS_KEY = 'cadrafterpro.ai';
const MAX_EDGE = 1568;                       // long edge of each picture, in pixels
const MAX_DPI = 200;
const MAX_WORDS = 3000;

// JSON schema of the answer (structured output on Claude, described in the prompt for the others)
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'notes'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item_id', 'marks'],
        properties: {
          item_id: { type: 'string' },
          marks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['tile', 'x', 'y', 'text_id'],
              properties: {
                tile: { type: 'integer' },
                x: { type: 'number' },
                y: { type: 'number' },
                text_id: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const SYSTEM_PROMPT = `You are the takeoff assistant of CadrafterPro, a construction estimating app.
You receive one sheet of a construction drawing as one or more pictures ("tiles"), the text printed on the sheet with its position, and a list of count takeoff items. For each takeoff item, find every place on the sheet where the thing it stands for appears, and mark each occurrence exactly once, at its center.

How to mark:
- When the occurrence is a printed tag or label that appears in the text list (for example a door tag "D1" or a fixture mark "WC-1"), give its text_id; x and y are then ignored.
- Otherwise give text_id -1, the tile number and the x, y pixel position of the center of the symbol in that tile (origin at the top left corner of the tile).
- The tiles may overlap a little; do not mark the same occurrence twice.
- Do not mark legends, schedules, title blocks, notes or keys that only describe a symbol: count only the symbols placed on the plan.
- If you are not sure an item is on this sheet, leave its marks empty and say why in notes.

Answer with JSON only, no other text, in this shape:
{"items":[{"item_id":"I1","marks":[{"tile":1,"x":120,"y":340,"text_id":-1}]}],"notes":"short summary for the estimator"}
Write notes in the same language as the user's instructions (English if there are none).`;

@Injectable({ providedIn: 'root' })
export class AiAssistant {
  private readonly store = inject(DrawingStore);
  private readonly text = inject(TextSearch);

  readonly provider = signal<AiProvider>('claude');
  readonly remember = signal(true);
  private readonly keys = signal<Partial<Record<AiProvider, string>>>({});
  private readonly models = signal<Partial<Record<AiProvider, string>>>({});

  readonly busy = signal(false);
  readonly progress = signal('');
  readonly error = signal('');
  readonly status = signal<{ ok: boolean; text: string } | null>(null);   // connection test
  readonly results = signal<AiRunResult[]>([]);
  private run = 0;

  constructor() {
    this.load();
  }

  info(provider = this.provider()): AiProviderInfo {
    return AI_PROVIDERS.find(p => p.id === provider)!;
  }

  apiKey(provider = this.provider()): string { return this.keys()[provider] ?? ''; }
  model(provider = this.provider()): string { return this.models()[provider] || this.info(provider).defaultModel; }

  setProvider(provider: AiProvider): void {
    this.provider.set(provider);
    this.status.set(null);
    this.save();
  }

  setApiKey(key: string): void {
    this.keys.update(k => ({ ...k, [this.provider()]: key.trim() }));
    this.status.set(null);
    this.save();
  }

  setModel(model: string): void {
    this.models.update(m => ({ ...m, [this.provider()]: model.trim() }));
    this.status.set(null);
    this.save();
  }

  setRemember(on: boolean): void {
    this.remember.set(on);
    this.save();
  }

  // Disconnect: the key of the current provider is forgotten
  forgetKey(): void {
    this.keys.update(k => ({ ...k, [this.provider()]: '' }));
    this.status.set(null);
    this.save();
  }

  cancel(): void {
    this.run++;
    this.busy.set(false);
    this.progress.set('');
  }

  // Checks the key and the model without spending tokens (reads the model's information)
  async testConnection(): Promise<void> {
    const provider = this.provider(), key = this.apiKey(), model = this.model();
    this.status.set(null);
    if (!key) {
      this.status.set({ ok: false, text: 'Enter an API key first.' });
      return;
    }
    this.busy.set(true);
    this.progress.set('Connecting…');
    try {
      if (provider === 'claude') {
        const client = await claudeClient(key);
        const m = await client.models.retrieve(model);
        this.status.set({ ok: true, text: `Connected to ${m.display_name || model}.` });
      } else if (provider === 'openai') {
        await getJson(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
        this.status.set({ ok: true, text: `Connected to ChatGPT (${model}).` });
      } else {
        const m = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
          { 'x-goog-api-key': key }) as { displayName?: string };
        this.status.set({ ok: true, text: `Connected to ${m.displayName || model}.` });
      }
    } catch (e) {
      this.status.set({ ok: false, text: errorText(e) });
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }

  // Counts the chosen takeoff items on the pages and adds the counts to the drawing
  // (one Undo step per page). `instructions`: what the items look like, in the user's words.
  async countItems(itemIds: string[], pages: number[], instructions: string, detail: AiDetail, sendText: boolean): Promise<void> {
    const s = this.store;
    const items = itemIds.map(id => s.items.find(i => i.id === id)).filter((i): i is TakeoffItem => !!i && i.kind === 'count');
    this.error.set('');
    if (!this.apiKey()) {
      this.error.set('Connect an AI provider first (API key).');
      return;
    }
    if (!s.hasDocument || !items.length || !pages.length) return;
    const runId = ++this.run;
    this.busy.set(true);
    this.results.set([]);
    try {
      for (const [n, pageIndex] of pages.entries()) {
        const prefix = pages.length > 1 ? `Page ${pageIndex + 1} (${n + 1} of ${pages.length}): ` : '';
        this.progress.set(prefix + 'Preparing the sheet…');
        const g = s.pages[pageIndex];
        if (!g) continue;
        const tiles = await this.tiles(g, detail);
        if (runId !== this.run) return;
        const words = sendText ? await this.words(pageIndex, g, tiles) : [];
        if (runId !== this.run) return;
        this.progress.set(prefix + `Asking ${this.info().name}…`);
        const prompt = this.prompt(items, tiles, words, instructions, pageIndex);
        const answer = await this.ask(tiles, prompt);
        if (runId !== this.run) return;
        const result = this.addCounts(answer, items, tiles, words, g, pageIndex);
        this.results.update(list => [...list, result]);
      }
      const total = this.results().reduce((sum, r) => sum + r.added.reduce((a, b) => a + b.count, 0), 0);
      s.showToast(`AI added ${total} count${total === 1 ? '' : 's'}`);
    } catch (e) {
      if (runId === this.run) this.error.set(errorText(e));
    } finally {
      if (runId === this.run) {
        this.busy.set(false);
        this.progress.set('');
      }
    }
  }

  // MARK: - Sheet for the model
  // The page split in detail × detail pictures with a small overlap
  private async tiles(g: PageGeometry, detail: AiDetail): Promise<Tile[]> {
    const tiles: Tile[] = [];
    const overlap = detail > 1 ? 0.03 : 0;
    const tw = g.width / detail, th = g.height / detail;
    for (let row = 0; row < detail; row++) {
      for (let col = 0; col < detail; col++) {
        const x0 = Math.max(0, col * tw - overlap * g.width), y0 = Math.max(0, row * th - overlap * g.height);
        const x1 = Math.min(g.width, (col + 1) * tw + overlap * g.width), y1 = Math.min(g.height, (row + 1) * th + overlap * g.height);
        const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const scale = Math.min(MAX_EDGE / Math.max(region.w, region.h), MAX_DPI / 72);
        const canvas = await renderRegion(g.page, region, scale);
        if (!canvas) throw new Error('The page could not be drawn.');
        const jpeg = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
        tiles.push({ region, scale, width: canvas.width, height: canvas.height, jpeg });
      }
    }
    return tiles;
  }

  // Text of the page with the tile and pixel where each piece is
  private async words(pageIndex: number, g: PageGeometry, tiles: Tile[]) {
    const list: { id: number; str: string; tile: number; x: number; y: number; center: Pt }[] = [];
    for (const w of await this.text.pageWords(pageIndex)) {
      const center = { x: w.rect.x + w.rect.w / 2, y: w.rect.y + w.rect.h / 2 };
      const v = g.toView(center);
      const t = tiles.findIndex(tile => v.x >= tile.region.x && v.x <= tile.region.x + tile.region.w
        && v.y >= tile.region.y && v.y <= tile.region.y + tile.region.h);
      if (t < 0) continue;
      const tile = tiles[t];
      list.push({
        id: list.length, str: w.str.slice(0, 40), tile: t + 1, center,
        x: Math.round((v.x - tile.region.x) * tile.scale), y: Math.round((v.y - tile.region.y) * tile.scale),
      });
      if (list.length >= MAX_WORDS) break;
    }
    return list;
  }

  private prompt(items: TakeoffItem[], tiles: Tile[], words: { id: number; str: string; tile: number; x: number; y: number }[],
                 instructions: string, pageIndex: number): string {
    const s = this.store;
    const label = s.pageName(pageIndex);
    const lines = [
      `Sheet: ${label} (page ${pageIndex + 1} of ${s.pageCount}).`,
      `Tiles: ${tiles.map((t, i) => `tile ${i + 1} = ${t.width}×${t.height} px`).join('; ')}.`
        + (tiles.length > 1 ? ` The tiles go left to right, then top to bottom (${Math.sqrt(tiles.length)}×${Math.sqrt(tiles.length)} grid).` : ''),
      '',
      'Count takeoff items:',
      ...items.map((item, i) => `- I${i + 1}: "${item.name}" (already counted on this sheet: ${this.countOn(item.id, pageIndex)})`),
    ];
    if (instructions.trim()) lines.push('', 'Instructions from the estimator:', instructions.trim());
    if (words.length) {
      lines.push('', 'Text on the sheet (text_id | tile | x,y | text):');
      for (const w of words) lines.push(`${w.id} | ${w.tile} | ${w.x},${w.y} | ${w.str}`);
    } else {
      lines.push('', 'No text list is available for this sheet: use the pictures only (text_id -1).');
    }
    return lines.join('\n');
  }

  private countOn(itemId: string, pageIndex: number): number {
    return this.store.measurements.filter(m => m.itemId === itemId && m.pageIndex === pageIndex)
      .reduce((n, m) => n + m.points.length, 0);
  }

  // MARK: - Counts into the drawing
  private addCounts(answer: AiAnswer, items: TakeoffItem[], tiles: Tile[],
                    words: { id: number; center: Pt }[], g: PageGeometry, pageIndex: number): AiRunResult {
    const s = this.store;
    // Two marks closer than this are the same occurrence (PDF points)
    const tolerance = Math.max(4, Math.hypot(g.width, g.height) * 0.003);
    const result: AiRunResult = { pageIndex, added: [], skipped: 0, notes: answer.notes ?? '' };
    const made: Measurement[] = [];
    items.forEach((item, i) => {
      const entry = answer.items?.find(e => e.item_id === `I${i + 1}` || e.item_id === item.name);
      const taken: Pt[] = s.measurements.filter(m => m.itemId === item.id && m.pageIndex === pageIndex).flatMap(m => m.points);
      let count = 0;
      for (const mark of entry?.marks ?? []) {
        const p = this.markPoint(mark, tiles, words, g);
        if (!p) continue;
        if (taken.some(q => Math.hypot(q.x - p.x, q.y - p.y) < tolerance)) {
          result.skipped++;
          continue;
        }
        taken.push(p);
        const m = new Measurement('count', pageIndex, item.id);
        m.name = item.name;
        m.lineColor = item.color;
        m.visible = item.isVisible;
        m.points = [p];
        m.contents = '1 ea';
        made.push(m);
        count++;
      }
      result.added.push({ name: item.name, color: item.color, count });
    });
    if (made.length) {
      s.checkpoint();
      s.measurements.push(...made);
      s.touch();
    }
    return result;
  }

  // Page point of a mark: the center of the text it names, or the pixel in its tile
  private markPoint(mark: AiMark, tiles: Tile[], words: { id: number; center: Pt }[], g: PageGeometry): Pt | null {
    if (Number.isInteger(mark.text_id) && mark.text_id >= 0) {
      const word = words[mark.text_id];
      if (word) return { ...word.center };
    }
    const tile = tiles[(mark.tile || 1) - 1];
    if (!tile || !Number.isFinite(mark.x) || !Number.isFinite(mark.y)) return null;
    if (mark.x < 0 || mark.y < 0 || mark.x > tile.width || mark.y > tile.height) return null;
    return g.toPage({ x: tile.region.x + mark.x / tile.scale, y: tile.region.y + mark.y / tile.scale });
  }

  // MARK: - Providers
  private async ask(tiles: Tile[], prompt: string): Promise<AiAnswer> {
    const provider = this.provider(), key = this.apiKey(), model = this.model();
    let text: string;
    if (provider === 'claude') text = await askClaude(key, model, tiles, prompt);
    else if (provider === 'openai') text = await askOpenAI(key, model, tiles, prompt);
    else text = await askGemini(key, model, tiles, prompt);
    return parseAnswer(text);
  }

  // MARK: - Settings (kept only in this browser; the key is never saved in the drawing)
  private load(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<StoredSettings>;
      if (saved.provider && AI_PROVIDERS.some(p => p.id === saved.provider)) this.provider.set(saved.provider);
      this.remember.set(saved.remember !== false);
      this.keys.set(saved.keys ?? {});
      this.models.set(saved.models ?? {});
    } catch {
      // storage blocked or damaged: start empty
    }
  }

  private save(): void {
    const settings: StoredSettings = {
      provider: this.provider(),
      remember: this.remember(),
      keys: this.remember() ? this.keys() : {},
      models: this.models(),
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage blocked: the settings last until the page is closed
    }
  }
}

// MARK: - Claude (Anthropic SDK, loaded only when it is used)
async function claudeClient(apiKey: string) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The key is the user's own and stays in their browser, so calling from the page is intended
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

async function askClaude(apiKey: string, model: string, tiles: Tile[], prompt: string): Promise<string> {
  const client = await claudeClient(apiKey);
  const modern = !/(^claude-3|-4-5|-4-1|-4-0|sonnet-4$|opus-4$)/.test(model);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 32000,
    // If the model declines, the server retries on its default fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(modern ? { output_config: { effort: 'high' as const, format: { type: 'json_schema' as const, schema: ANSWER_SCHEMA } } } : {}),
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...tiles.flatMap((t, i) => [
          { type: 'text' as const, text: `Tile ${i + 1}:` },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: t.jpeg } },
        ]),
        { type: 'text' as const, text: prompt },
      ],
    }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
  }
  if (message.stop_reason === 'max_tokens') throw new Error('The answer was too long. Try fewer items or one page at a time.');
  return message.content.map(b => b.type === 'text' ? b.text : '').join('');
}

// MARK: - ChatGPT (OpenAI REST API)
async function askOpenAI(apiKey: string, model: string, tiles: Tile[], prompt: string): Promise<string> {
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          ...tiles.flatMap((t, i) => [
            { type: 'text', text: `Tile ${i + 1}:` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${t.jpeg}`, detail: 'high' } },
          ]),
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
  const json = await postJson('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, body) as {
    choices?: { message?: { content?: string; refusal?: string } }[];
  };
  const message = json.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`ChatGPT declined: ${message.refusal}`);
  return message?.content ?? '';
}

// MARK: - Gemini (Google Generative Language REST API)
async function askGemini(apiKey: string, model: string, tiles: Tile[], prompt: string): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        ...tiles.flatMap((t, i) => [{ text: `Tile ${i + 1}:` }, { inline_data: { mime_type: 'image/jpeg', data: t.jpeg } }]),
        { text: prompt },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const json = await postJson(url, { 'x-goog-api-key': apiKey }, body) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (json.promptFeedback?.blockReason) throw new Error(`Gemini declined: ${json.promptFeedback.blockReason}`);
  return json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

// MARK: - Helpers
async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  return readJson(response);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) {
    const err = (json as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`${response.status}: ${err || text.slice(0, 200) || response.statusText}`);
  }
  return json;
}

// The JSON in the model's answer (tolerates text or code fences around it)
function parseAnswer(text: string): AiAnswer {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not return a list of counts. Try again or add instructions.');
  const json = JSON.parse(text.slice(start, end + 1)) as Partial<AiAnswer>;
  return { items: Array.isArray(json.items) ? json.items : [], notes: typeof json.notes === 'string' ? json.notes : '' };
}

function errorText(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 401 || /\b401\b|invalid.*key|API key not valid|authentication/i.test(message)) return 'The API key was not accepted. Check it and try again.';
  if (status === 404 || /\b404\b|not.?found/i.test(message)) return `Model not found: ${message}`;
  if (status === 429 || /\b429\b/.test(message)) return 'Rate limit or quota reached on this account. Wait a moment or check billing.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Could not reach the AI service (network or browser blocked the request).';
  return message;
}
