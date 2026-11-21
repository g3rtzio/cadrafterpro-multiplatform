import { Injectable, inject, signal } from '@angular/core';
import { Measurement } from '../../models/elements';
import { COLORS, Pt, Rect, TakeoffItem, polygonArea, quantityText } from '../../models/takeoff';
import { DrawingStore } from '../drawing.store/drawing.store';
import { PageGeometry, renderRegion } from '../pdf-render/pdf-render';
import { TextSearch } from '../text-search/text-search';

// AI assistant of the right side bar: connects to Claude, ChatGPT or Gemini with the user's own
// API key, or to a local model server (Ollama, LM Studio) on this computer. Once connected it is a chat about the open drawing (the current page can go along as
// a picture plus its text), and it counts takeoff items: it shows the model the sheet and the
// count items, and puts the counts the model finds straight into the drawing.

export type AiProvider = 'claude' | 'openai' | 'gemini' | 'local';
export type AiDetail = 1 | 2 | 3;            // the page is sent as 1, 2×2 or 3×3 pictures

export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  defaultModel: string;
  models: string[];                          // suggestions; any model id can be typed
  keyUrl: string;                            // where the user gets an API key
  keyHint: string;
}

// Model ids the providers no longer serve; a saved choice with one of these goes back to the default
const RETIRED_MODELS = ['gemini-2.5-pro'];

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
    id: 'gemini', name: 'Gemini', defaultModel: 'gemini-3.1-pro-preview',
    models: ['gemini-3.1-pro-preview'],
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
  },
  {
    // Local models (Qwen, Gemma…) through an OpenAI-compatible server. Its "key" is the server URL.
    id: 'local', name: 'Local', defaultModel: '',
    models: [],
    keyUrl: 'https://ollama.com/download', keyHint: 'http://localhost:11434/v1',
  },
];

// OpenAI-compatible servers that run models on this computer
export const LOCAL_SERVERS = [
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
];

const OPENAI_BASE = 'https://api.openai.com/v1';

// "localhost:11434" → "http://localhost:11434/v1". A full endpoint pasted from the server's
// screen ("…/v1/chat/completions", "…/v1/models") is cut back to "…/v1".
function localBase(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  const v1 = /^(.*?\/v1)(\/.*)?$/i.exec(base);
  if (v1) return v1[1];
  return base.replace(/\/(chat\/completions|completions|models)$/i, '') + '/v1';
}

interface StoredSettings {
  provider: AiProvider;
  remember: boolean;
  keys: Partial<Record<AiProvider, string>>;
  models: Partial<Record<AiProvider, string>>;
}

// One picture of the page sent to the model
// `core`: the part of the page the tile owns (its region without the overlap with its neighbours)
interface Tile { region: Rect; core: Rect; scale: number; width: number; height: number; jpeg: string; }

// What the model answers (the same shape for the three providers)
interface AiMark { tile: number; x: number; y: number; text_id: number; }
interface AiAnswer { items: { item_id: string; marks: AiMark[] }[]; notes: string; }

// What the model answers when it traces lines (walls…) or areas (rooms…): polylines or outlines in tile pixels
interface AiShape { tile: number; points: { x: number; y: number }[]; }
interface AiShapeAnswer { items: { item_id: string; shapes: AiShape[] }[]; notes: string; }

export interface AiRunResult {
  pageIndex: number;
  added: { name: string; color: string; count: number; total?: string }[];   // total: length or area traced
  skipped: number;                           // already counted at the same spot
  notes: string;
}

// MARK: - Chat
// The model can propose a count, a line tracing (walls…) or an area tracing (rooms…);
// the app shows a button that runs it
export interface ChatCountAction {
  kind: 'count' | 'linear' | 'area';         // count symbols, trace Linear lines or trace Areas
  items: string[];                           // takeoff item names (new names become new items of that kind)
  pages: 'current' | 'all';
  instructions: string;
  pageIndex: number;                         // the current page when it was proposed
  state: 'ready' | 'running' | 'done';
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;                              // what is shown (without the action block)
  raw: string;                               // what goes back to the model in the history
  page?: { index: number; name: string; all?: boolean };   // page (or all pages) sent along with a user message
  error?: boolean;
  streaming?: boolean;
  action?: ChatCountAction;
}

// What goes along with a chat message: nothing, the current page or every page of the document
export type ChatAttach = 'none' | 'page' | 'all';

// One turn of the conversation as the providers receive it
interface ChatTurn { role: 'user' | 'assistant'; text: string; images: string[]; }

// The action block: ```takeoff-count / takeoff-linear / takeoff-area, or a plain ```json block with "items"
// (small local models often drop the label)
const ACTION_BLOCK = /```(takeoff-(?:count|linear|area)|json)?[ \t]*\r?\n?(\s*\{[\s\S]*?"items"[\s\S]*?)(```|$)/;
const CHAT_HISTORY = 30;                     // messages sent back to the model
const CHAT_WORDS = 2500;                     // words of page text sent with a message
const ALL_PAGES_MAX = 30;                    // pages sent as pictures with "All pages"
const ALL_PAGES_EDGE = 1024;                 // long edge of each of those pictures, in pixels
const ALL_PAGES_WORDS = 6000;                // words of text for the whole document

const CHAT_PROMPT = `You are the AI assistant of CadrafterPro, a construction takeoff and estimating app (similar to PlanSwift and Bluebeam). You chat with an estimator about the drawing they have open.
- Answer in the same language the user writes in. Be concise and practical; use short lists when they help.
- When a page is attached you see a picture of the sheet and the text printed on it. Read dimensions, notes, schedules, scales, room names and tags from them. If something is too small to read, say so.
- You cannot change or measure the drawing yourself. Never invent counts, lengths or areas and never say you counted, measured, traced or added anything: the app does that only when the user presses the button that appears under your answer.
- When the user asks to count, trace or measure something on the drawing, write one short sentence and end your answer with exactly ONE action block. Use the label after the three backticks exactly as shown:
  Count symbols or tags:
\`\`\`takeoff-count
{"kind":"count","items":["Duplex Outlet","Door D1"],"pages":"current","instructions":"Duplex Outlet = circle with two parallel lines; Door D1 = the D1 tags"}
\`\`\`
  Trace walls or other runs measured in length (curbs, footings, pipes, fences, baseboard…) with the Linear tool:
\`\`\`takeoff-linear
{"kind":"linear","items":["Interior Wall"],"pages":"current","instructions":"interior partitions drawn as thin double lines; skip exterior walls"}
\`\`\`
  Trace the floor area of rooms or zones (flooring, ceilings, slabs, paint areas…) with the Area tool:
\`\`\`takeoff-area
{"kind":"area","items":["Training Room 311"],"pages":"current","instructions":"the room labeled TRAINING 311 in the lower plan, inside face of its walls"}
\`\`\`
  "items" are takeoff item names: use the names listed below when they match; a new name creates a new item of that kind. "pages" is "current" or "all". "instructions" says what to look for and where, in the user's words plus what you see on the sheet.
- Quantities in the takeoff are in EA (counts), FT (lengths) and SF (areas) with the scale of each page.`;

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

// JSON schema of a line tracing answer
const SHAPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'notes'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item_id', 'shapes'],
        properties: {
          item_id: { type: 'string' },
          shapes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['tile', 'points'],
              properties: {
                tile: { type: 'integer' },
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['x', 'y'],
                    properties: { x: { type: 'number' }, y: { type: 'number' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const LINE_PROMPT = `You are the takeoff assistant of CadrafterPro, a construction estimating app.
You receive one sheet of a construction drawing as one or more pictures ("tiles") and a list of linear takeoff items (for example walls). For each takeoff item, trace every run of it on the plan as polylines, the way an estimator measures them with a Linear tool.

How to trace:
- Walls are usually drawn as two parallel lines (sometimes filled or hatched). Trace ONE polyline along the middle of the wall (its centerline), not each face.
- A polyline is a list of corner points: { "x", "y" } pixel positions in its tile (origin at the top left corner of the tile). Put a point at every corner and at both ends; straight runs need only their two ends.
- Follow a wall around its corners in one polyline while it continues; start a new polyline at a tee or where the run ends. Keep going through doors and windows unless the instructions say to stop at openings.
- Each polyline lies in one tile. The tiles may overlap a little: a run that crosses into another tile may continue there as a new polyline; the app trims the overlap.
- Do not trace what the estimator already traced unless the instructions ask for it.
- Do not trace dimension lines, grid lines, leaders, text, hatching, furniture, legends, title blocks or details: only the elements placed on the plan.
- Be precise: points must sit on the drawing, not approximately near it. If you are not sure an item is on this sheet, leave its lines empty and say why in notes.

Answer with JSON only, no other text, in this shape:
{"items":[{"item_id":"I1","shapes":[{"tile":1,"points":[{"x":120,"y":340},{"x":620,"y":340},{"x":620,"y":900}]}]}],"notes":"short summary for the estimator"}
Write notes in the same language as the user's instructions (English if there are none).`;

const AREA_PROMPT = `You are the takeoff assistant of CadrafterPro, a construction estimating app.
You receive one sheet of a construction drawing as a picture ("tile") and a list of area takeoff items (for example rooms, floor finishes, slabs). For each takeoff item, trace the outline of every area it stands for, the way an estimator measures it with an Area tool.

How to trace:
- An outline is a closed polygon: the list of its corner points { "x", "y" } in pixels of the tile (origin at the top left corner), going around the area once. Do not repeat the first point at the end.
- For a room, follow the inside face of its walls and put a point at every corner, including the small jogs around columns and recesses. Close the outline across door openings along the wall line.
- Find the room by its name or number tag; the tag sits inside the room. When the same room appears in more than one plan on the sheet, trace it only in the plan the instructions name, or in the main floor plan.
- Do not trace legends, schedules, title blocks, details or keys.
- Be precise: points must sit on the wall lines, not approximately near them. If you cannot find the area, leave its shapes empty and say why in notes.

Answer with JSON only, no other text, in this shape:
{"items":[{"item_id":"I1","shapes":[{"tile":1,"points":[{"x":120,"y":340},{"x":620,"y":340},{"x":620,"y":900},{"x":120,"y":900}]}]}],"notes":"short summary for the estimator"}
Write notes in the same language as the user's instructions (English if there are none).`;

// What one vision request asks for: its system prompt and the JSON schema of the answer
interface AskTask { system: string; schema: object; }
const COUNT_TASK: AskTask = { system: SYSTEM_PROMPT, schema: ANSWER_SCHEMA };
const LINE_TASK: AskTask = { system: LINE_PROMPT, schema: SHAPE_SCHEMA };
const AREA_TASK: AskTask = { system: AREA_PROMPT, schema: SHAPE_SCHEMA };

@Injectable({ providedIn: 'root' })
export class AiAssistant {
  private readonly store = inject(DrawingStore);
  private readonly text = inject(TextSearch);

  readonly provider = signal<AiProvider>('claude');
  readonly remember = signal(true);
  private readonly keys = signal<Partial<Record<AiProvider, string>>>({});
  private readonly models = signal<Partial<Record<AiProvider, string>>>({});
  // Models the provider says this key can use (read on Test connection); replaces the suggestions
  private readonly available = signal<Partial<Record<AiProvider, string[]>>>({});

  readonly busy = signal(false);
  readonly progress = signal('');
  readonly error = signal('');
  readonly status = signal<{ ok: boolean; text: string } | null>(null);   // connection test
  readonly results = signal<AiRunResult[]>([]);
  private run = 0;

  readonly chat = signal<ChatMessage[]>([]);
  readonly chatBusy = signal(false);
  private chatAbort: AbortController | null = null;
  private nextId = 1;

  constructor() {
    this.load();
  }

  info(provider = this.provider()): AiProviderInfo {
    return AI_PROVIDERS.find(p => p.id === provider)!;
  }

  apiKey(provider = this.provider()): string { return this.keys()[provider] ?? ''; }
  model(provider = this.provider()): string { return this.models()[provider] || this.info(provider).defaultModel; }

  // Model ids for the model field: the ones the account can use, or the built-in suggestions
  modelOptions(provider = this.provider()): string[] {
    const list = this.available()[provider];
    return list?.length ? list : this.info(provider).models;
  }

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

  // Checks the key and the model without spending tokens (reads the model's information).
  // true when it worked.
  async testConnection(): Promise<boolean> {
    const provider = this.provider(), key = this.apiKey(), model = this.model();
    this.status.set(null);
    if (!key) {
      this.status.set({ ok: false, text: provider === 'local' ? 'Enter the server URL first.' : 'Enter an API key first.' });
      return false;
    }
    this.busy.set(true);
    this.progress.set('Connecting…');
    try {
      if (provider === 'claude') {
        const client = await claudeClient(key);
        const m = await client.models.retrieve(model);
        this.status.set({ ok: true, text: `Connected to ${m.display_name || model}.` });
      } else if (provider === 'openai') {
        await getJson(`${OPENAI_BASE}/models/${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
        this.status.set({ ok: true, text: `Connected to ChatGPT (${model}).` });
      } else if (provider === 'local') {
        // The models installed on the server (Ollama: "ollama pull qwen3")
        const base = localBase(key);
        const data = await getJson(`${base}/models`, {}) as { data?: { id: string }[] };
        // Embedding models can't chat: leave them out of the list
        const ids = (data.data ?? []).map(m => m.id).filter(id => !/embed/i.test(id)).sort();
        this.available.update(a => ({ ...a, local: ids }));
        if (!ids.length) {
          this.status.set({ ok: false, text: 'The server has no models yet. In Ollama: ollama pull qwen3 (or gemma3).' });
          return false;
        }
        let chosen = model;
        if (!chosen) {
          chosen = ids[0];
          this.setModel(chosen);
        } else if (!ids.includes(chosen)) {
          this.status.set({ ok: false, text: `${chosen} is not installed on the server. Installed: ${ids.slice(0, 8).join(', ')}.` });
          return false;
        }
        this.status.set({ ok: true, text: `Connected to the local server (${chosen}).` });
      } else {
        // Google retires models often: read the list this key can use, then check the chosen one
        const ids = await listGeminiModels(key);
        if (ids.length) this.available.update(a => ({ ...a, gemini: ids }));
        if (ids.length && !ids.includes(model)) {
          const pick = ids.find(id => /pro/.test(id)) ?? ids[0];
          this.status.set({ ok: false, text: `${model} is not available for this key. Choose another model, for example ${pick}.` });
          return false;
        }
        const m = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
          { 'x-goog-api-key': key }) as { displayName?: string };
        this.status.set({ ok: true, text: `Connected to ${m.displayName || model}.` });
      }
      return true;
    } catch (e) {
      // A local server that doesn't answer is usually stopped, on another port, or blocking CORS
      const local = provider === 'local' && e instanceof TypeError;
      this.status.set({ ok: false, text: local
        ? `No answer from ${localBase(key)}. Check that the server is running on that port; in LM Studio also turn on "Enable CORS" in the server settings.`
        : errorText(e) });
      return false;
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }

  // MARK: - Chat
  // Sends a message (with the current page as a picture plus its text when withPage) and
  // streams the answer into the conversation
  async send(text: string, attach: ChatAttach | boolean): Promise<void> {
    const s = this.store;
    const question = text.trim();
    if (!question || this.chatBusy() || this.busy()) return;
    const pageIndex = s.currentPageIndex;
    const mode: ChatAttach = attach === true ? 'page' : attach === false ? 'none' : attach;
    const page = mode === 'none' || !s.hasDocument || !s.pages[pageIndex] ? undefined
      : mode === 'all' ? { index: pageIndex, name: `All pages (${s.pageCount})`, all: true }
      : { index: pageIndex, name: s.pageName(pageIndex) };
    this.chat.update(list => [...list, { id: this.nextId++, role: 'user', text: question, raw: question, page }]);
    const answerId = this.nextId++;
    this.chat.update(list => [...list, { id: answerId, role: 'assistant', text: '', raw: '', streaming: true }]);
    this.chatBusy.set(true);
    const abort = new AbortController();
    this.chatAbort = abort;
    let raw = '';
    try {
      if (!this.apiKey()) throw new Error('Connect an AI provider first (API key or local server).');
      const turns = await this.chatTurns(page?.index, !!page?.all,
        (done, total) => this.patch(answerId, { text: `Reading the pages… (${done} of ${total})` }));
      this.patch(answerId, { text: '' });
      if (abort.signal.aborted) return;
      const onText = (delta: string) => {
        raw += delta;
        this.patch(answerId, { raw, text: visibleText(raw) });
      };
      const provider = this.provider(), key = this.apiKey(), model = this.model(), system = this.chatSystem();
      if (provider === 'claude') await chatClaude(key, model, system, turns, onText, abort.signal);
      else if (provider === 'openai') await chatOpenAI(OPENAI_BASE, key, model, system, turns, onText, abort.signal);
      else if (provider === 'local') await chatOpenAI(localBase(key), '', model, system, turns, onText, abort.signal);
      else await chatGemini(key, model, system, turns, onText, abort.signal);
      const action = parseAction(raw, pageIndex, question);
      this.patch(answerId, { raw, text: visibleText(raw) || (action ? '' : '(No answer)'), streaming: false, action });
    } catch (e) {
      if (abort.signal.aborted) {
        this.patch(answerId, { raw, text: visibleText(raw) || '(Stopped)', streaming: false });
      } else {
        this.patch(answerId, { raw, text: errorText(e), streaming: false, error: true });
      }
    } finally {
      if (this.chatAbort === abort) {
        this.chatAbort = null;
        this.chatBusy.set(false);
      }
    }
  }

  stopChat(): void {
    this.chatAbort?.abort();
    this.chatAbort = null;
    this.chatBusy.set(false);
    this.chat.update(list => list.map(m => m.streaming ? { ...m, streaming: false, text: m.text || '(Stopped)' } : m));
  }

  newChat(): void {
    this.stopChat();
    this.chat.set([]);
  }

  // Runs the action the model proposed: missing items are created, then the counts, lines or areas
  // are added and summed up in the conversation
  async runAction(messageId: number): Promise<void> {
    const s = this.store;
    const message = this.chat().find(m => m.id === messageId);
    const action = message?.action;
    if (!action || action.state !== 'ready' || this.busy() || !s.hasDocument) return;
    const palette = [COLORS.red, COLORS.blue, COLORS.green, COLORS.orange, COLORS.purple];
    const kind = action.kind === 'linear' ? 'length' : action.kind === 'area' ? 'area' : 'count';
    const what = kind === 'area' ? 'area' : 'line';
    const ids: string[] = [];
    for (const name of action.items) {
      let item = s.items.find(i => i.kind === kind && i.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!item) {
        s.addItem(name.trim(), kind, palette[s.items.length % palette.length]);
        item = s.items[s.items.length - 1];
        s.cancelTool();                   // addItem starts measuring with it; here the AI places the marks
        s.touch();
      }
      if (!ids.includes(item.id)) ids.push(item.id);
    }
    const pageIndex = Math.min(action.pageIndex, s.pageCount - 1);
    const pages = action.pages === 'all' ? Array.from({ length: s.pageCount }, (_, i) => i) : [pageIndex];
    this.patch(messageId, { action: { ...action, state: 'running' } });
    // Areas go as one picture of the whole sheet so a room is never cut between two pictures
    if (kind !== 'count') await this.traceShapes(kind, ids, pages, action.instructions, kind === 'area' ? 1 : 2);
    else await this.countItems(ids, pages, action.instructions, 2, true);
    this.patch(messageId, { action: { ...action, state: 'done' } });
    const lines: string[] = [];
    if (this.error()) {
      lines.push(`${kind === 'count' ? 'The count' : 'The tracing'} didn't finish: ${this.error()}`);
    } else {
      for (const r of this.results()) {
        lines.push(`**${s.pageName(r.pageIndex)}**`);
        for (const a of r.added) {
          lines.push(kind === 'count' ? `- ${a.name}: ${a.count} EA added` : `- ${a.name}: ${a.count} ${what}${a.count === 1 ? '' : 's'} added (${a.total})`);
        }
        if (r.skipped) lines.push(kind === 'count' ? `- ${r.skipped} already counted, skipped` : `- ${r.skipped} ${what}${r.skipped === 1 ? '' : 's'} left out (too small or off the sheet)`);
        if (r.notes) lines.push(r.notes);
      }
      lines.push('', kind === 'count'
        ? 'Check the counts on the plan; Undo removes them.'
        : `Check the ${what}s on the plan and adjust their points where needed; Undo removes them.`);
    }
    const text = lines.join('\n');
    this.chat.update(list => [...list, { id: this.nextId++, role: 'assistant', text, raw: text, error: !!this.error() }]);
  }

  private patch(id: number, change: Partial<ChatMessage>): void {
    this.chat.update(list => list.map(m => m.id === id ? { ...m, ...change } : m));
  }

  // The conversation for the model; only the newest message carries its page (picture and text),
  // or every page when `all`
  private async chatTurns(pageIndex: number | undefined, all = false,
                          onProgress?: (done: number, total: number) => void): Promise<ChatTurn[]> {
    const s = this.store;
    const messages = this.chat().filter(m => !m.streaming && !m.error && m.raw).slice(-CHAT_HISTORY);
    while (messages.length && messages[0].role !== 'user') messages.shift();
    const turns: ChatTurn[] = messages.map(m => ({
      role: m.role,
      text: m.page ? `${m.raw}\n\n[${m.page.all ? 'Attached' : 'Page attached'}: ${m.page.name}]` : m.raw,
      images: [],
    }));
    const last = turns[turns.length - 1];
    const question = messages[messages.length - 1]?.raw ?? '';
    if (last && all && pageIndex !== undefined && s.pageCount) {
      const count = Math.min(s.pageCount, ALL_PAGES_MAX);
      const perPage = Math.max(150, Math.floor(ALL_PAGES_WORDS / count));
      const parts = [`Attached: the whole drawing, ${s.pageCount} page${s.pageCount === 1 ? '' : 's'}`
        + (count < s.pageCount ? ` (pictures of the first ${count} only)` : '')
        + `. The user is looking at page ${pageIndex + 1} (${s.pageName(pageIndex)}). The pictures come in page order.`];
      for (let i = 0; i < count; i++) {
        onProgress?.(i + 1, count);
        const g = s.pages[i];
        if (!g) continue;
        const [tile] = await this.tiles(g, 1, ALL_PAGES_EDGE);
        last.images.push(tile.jpeg);
        const text = this.pageText(await this.text.pageTextWords(i), perPage);
        parts.push(`--- Page ${i + 1}: ${s.pageName(i)} ---` + (text ? `\n${text}` : '\n(no text layer: read the picture)'));
      }
      last.text = `${parts.join('\n\n')}\n\n${question}`;
    } else {
      const g = pageIndex === undefined ? undefined : s.pages[pageIndex];
      if (last && g && pageIndex !== undefined) {
        const [tile] = await this.tiles(g, 1);
        last.images.push(tile.jpeg);
        const text = this.pageText(await this.text.pageTextWords(pageIndex), CHAT_WORDS);
        last.text = `Attached: the sheet "${s.pageName(pageIndex)}" (page ${pageIndex + 1} of ${s.pageCount}).`
          + (text ? `\nText printed on the sheet:\n${text}` : '\nThe sheet has no text layer (scanned): read the picture.')
          + `\n\n${question}`;
      }
    }
    // Providers want user and assistant turns to alternate: merge neighbours
    const merged: ChatTurn[] = [];
    for (const t of turns) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === t.role) {
        prev.text += '\n\n' + t.text;
        prev.images.push(...t.images);
      } else {
        merged.push({ ...t, images: [...t.images] });
      }
    }
    return merged;
  }

  // Words of a page as lines of text, at most `limit` words
  private pageText(words: { str: string; line: number }[], limit: number): string {
    let text = '';
    let line = -1;
    for (const w of words.slice(0, limit)) {
      if (text) text += w.line === line ? ' ' : '\n';
      text += w.str;
      line = w.line;
    }
    return text;
  }

  // System prompt plus what the app knows about the open document
  private chatSystem(): string {
    const s = this.store;
    if (!s.hasDocument) return CHAT_PROMPT + '\n\nNo drawing is open.';
    const lines = [
      CHAT_PROMPT, '',
      `Open drawing: ${s.fileName || 'untitled'} (${s.pageCount} page${s.pageCount === 1 ? '' : 's'}).`,
      `Current page: ${s.pageName(s.currentPageIndex)} (page ${s.currentPageIndex + 1}).`,
      `Pages: ${Array.from({ length: Math.min(s.pageCount, 200) }, (_, i) => `${i + 1}. ${s.pageName(i)}`).join('; ')}`,
    ];
    if (s.items.length) {
      lines.push('', 'Takeoff items (quantity on the current page / whole drawing):');
      for (const item of s.items.slice(0, 200)) {
        const unit = item.kind === 'count' ? 'EA' : item.kind === 'area' ? 'SF' : 'FT';
        let total = 0;
        for (let p = 0; p < s.pageCount; p++) total += s.quantity(item, p);
        const here = s.quantity(item, s.currentPageIndex);
        lines.push(`- ${item.name} (${item.kind}): ${round2(here)} / ${round2(total)} ${unit}`);
      }
    } else {
      lines.push('', 'There are no takeoff items yet.');
    }
    return lines.join('\n');
  }

  // Counts the chosen takeoff items on the pages and adds the counts to the drawing
  // (one Undo step per page). `instructions`: what the items look like, in the user's words.
  async countItems(itemIds: string[], pages: number[], instructions: string, detail: AiDetail, sendText: boolean): Promise<void> {
    const s = this.store;
    const items = itemIds.map(id => s.items.find(i => i.id === id)).filter((i): i is TakeoffItem => !!i && i.kind === 'count');
    this.error.set('');
    if (!this.apiKey()) {
      this.error.set('Connect an AI provider first (API key or local server).');
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
        const answer = parseAnswer(await this.ask(tiles, prompt, COUNT_TASK));
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

  // Traces the chosen linear items (walls…) or area items (rooms…) on the pages from the picture
  // of the sheet and adds them as Linear or Area measurements (one Undo step per page)
  async traceShapes(kind: 'length' | 'area', itemIds: string[], pages: number[], instructions: string, detail: AiDetail): Promise<void> {
    const s = this.store;
    const items = itemIds.map(id => s.items.find(i => i.id === id)).filter((i): i is TakeoffItem => !!i && i.kind === kind);
    this.error.set('');
    if (!this.apiKey()) {
      this.error.set('Connect an AI provider first (API key or local server).');
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
        this.progress.set(prefix + `Asking ${this.info().name} to trace…`);
        const prompt = this.shapePrompt(kind, items, tiles, instructions, pageIndex);
        const answer = parseShapeAnswer(await this.ask(tiles, prompt, kind === 'area' ? AREA_TASK : LINE_TASK));
        if (runId !== this.run) return;
        this.results.update(list => [...list, this.addShapes(kind, answer, items, tiles, g, pageIndex)]);
      }
      const total = this.results().reduce((sum, r) => sum + r.added.reduce((a, b) => a + b.count, 0), 0);
      const what = kind === 'area' ? 'area' : 'line';
      s.showToast(`AI added ${total} ${what}${total === 1 ? '' : 's'}`);
    } catch (e) {
      if (runId === this.run) this.error.set(errorText(e));
    } finally {
      if (runId === this.run) {
        this.busy.set(false);
        this.progress.set('');
      }
    }
  }

  private shapePrompt(kind: 'length' | 'area', items: TakeoffItem[], tiles: Tile[], instructions: string, pageIndex: number): string {
    const s = this.store;
    const lines = [
      `Sheet: ${s.pageName(pageIndex)} (page ${pageIndex + 1} of ${s.pageCount}).`,
      `Tiles: ${tiles.map((t, i) => `tile ${i + 1} = ${t.width}×${t.height} px`).join('; ')}.`
        + (tiles.length > 1 ? ` The tiles go left to right, then top to bottom (${Math.sqrt(tiles.length)}×${Math.sqrt(tiles.length)} grid).` : ''),
      '',
      kind === 'area' ? 'Area takeoff items to trace:' : 'Linear takeoff items to trace:',
      ...items.map((item, i) => `- I${i + 1}: "${item.name}" (${kind === 'area' ? 'areas' : 'lines'} already traced on this sheet: ${this.countOn(item.id, pageIndex, false)})`),
    ];
    if (instructions.trim()) lines.push('', 'Instructions from the estimator:', instructions.trim());
    return lines.join('\n');
  }

  // MARK: - Lines and areas into the drawing
  // Each shape is trimmed to the part of the page its tile owns, so the overlap is not measured twice
  private addShapes(kind: 'length' | 'area', answer: AiShapeAnswer, items: TakeoffItem[], tiles: Tile[],
                    g: PageGeometry, pageIndex: number): AiRunResult {
    const s = this.store;
    const minLength = Math.max(6, Math.hypot(g.width, g.height) * 0.004);   // smaller pieces are noise (PDF points)
    const unit = s.unitFor(kind);
    const result: AiRunResult = { pageIndex, added: [], skipped: 0, notes: answer.notes ?? '' };
    const made: Measurement[] = [];
    items.forEach((item, i) => {
      const entry = answer.items?.find(e => e.item_id === `I${i + 1}` || e.item_id === item.name);
      const before = made.length;
      for (const shape of entry?.shapes ?? []) {
        const tile = tiles[(shape.tile || 1) - 1];
        const pts = (Array.isArray(shape.points) ? shape.points : [])
          .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
          .map(p => ({
            x: tile ? tile.region.x + Math.min(Math.max(p.x, 0), tile.width) / tile.scale : NaN,
            y: tile ? tile.region.y + Math.min(Math.max(p.y, 0), tile.height) / tile.scale : NaN,
          }));
        if (kind === 'area' && pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-3) pts.pop();
        if (!tile || pts.length < (kind === 'area' ? 3 : 2)) {
          result.skipped++;
          continue;
        }
        const pieces = kind === 'area' ? [clipPolygon(pts, tile.core)].filter(p => p.length >= 3) : clipPolyline(pts, tile.core);
        if (!pieces.length) result.skipped++;           // all of it in the overlap: the next tile has it
        for (const piece of pieces) {
          const points = piece.map(p => g.toPage(p));
          const tooSmall = kind === 'area' ? polygonArea(points) < minLength * minLength : polyLength(points) < minLength;
          if (tooSmall) {
            result.skipped++;
            continue;
          }
          const m = new Measurement(kind, pageIndex, item.id);
          m.name = item.name;
          m.lineColor = item.color;
          m.visible = item.isVisible;
          m.lengthUnit = unit;
          m.points = points;
          m.contents = s.liveText(points, kind, pageIndex);
          made.push(m);
        }
      }
      const mine = made.slice(before);
      const total = mine.reduce((sum, m) => sum + s.value(m.points, kind, pageIndex), 0);
      result.added.push({ name: item.name, color: item.color, count: mine.length, total: quantityText(total, kind, unit) });
    });
    if (made.length) {
      s.checkpoint();
      s.measurements.push(...made);
      s.touch();
    }
    return result;
  }

  // MARK: - Sheet for the model
  // The page split in detail × detail pictures with a small overlap
  private async tiles(g: PageGeometry, detail: AiDetail, maxEdge = MAX_EDGE): Promise<Tile[]> {
    const tiles: Tile[] = [];
    const overlap = detail > 1 ? 0.03 : 0;
    const tw = g.width / detail, th = g.height / detail;
    for (let row = 0; row < detail; row++) {
      for (let col = 0; col < detail; col++) {
        const x0 = Math.max(0, col * tw - overlap * g.width), y0 = Math.max(0, row * th - overlap * g.height);
        const x1 = Math.min(g.width, (col + 1) * tw + overlap * g.width), y1 = Math.min(g.height, (row + 1) * th + overlap * g.height);
        const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const core = { x: col * tw, y: row * th, w: tw, h: th };
        const scale = Math.min(maxEdge / Math.max(region.w, region.h), MAX_DPI / 72);
        const canvas = await renderRegion(g, region, scale);
        if (!canvas) throw new Error('The page could not be drawn.');
        const jpeg = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
        tiles.push({ region, core, scale, width: canvas.width, height: canvas.height, jpeg });
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

  // Counts already on the sheet (points), or lines (measurements) with byPoint false
  private countOn(itemId: string, pageIndex: number, byPoint = true): number {
    const list = this.store.measurements.filter(m => m.itemId === itemId && m.pageIndex === pageIndex);
    return byPoint ? list.reduce((n, m) => n + m.points.length, 0) : list.length;
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
  // The model's answer text (JSON) for the pictures, the prompt and the task
  private async ask(tiles: Tile[], prompt: string, task: AskTask): Promise<string> {
    const provider = this.provider(), key = this.apiKey(), model = this.model();
    let text: string;
    if (provider === 'claude') text = await askClaude(key, model, tiles, prompt, task);
    else if (provider === 'openai') text = await askOpenAI(OPENAI_BASE, key, model, tiles, prompt, task);
    else if (provider === 'local') text = await askOpenAI(localBase(key), '', model, tiles, prompt, task);
    else text = await askGemini(key, model, tiles, prompt, task);
    return text;
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
      const models = { ...(saved.models ?? {}) };
      // Models Google no longer serves: back to the current default
      if (models.gemini && RETIRED_MODELS.includes(models.gemini)) delete models.gemini;
      this.models.set(models);
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

async function askClaude(apiKey: string, model: string, tiles: Tile[], prompt: string, task: AskTask): Promise<string> {
  const client = await claudeClient(apiKey);
  const modern = !/(^claude-3|-4-5|-4-1|-4-0|sonnet-4$|opus-4$)/.test(model);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 32000,
    // If the model declines, the server retries on its default fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(modern ? { output_config: { effort: 'high' as const, format: { type: 'json_schema' as const, schema: task.schema as Record<string, unknown> } } } : {}),
    system: task.system,
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

async function chatClaude(apiKey: string, model: string, system: string, turns: ChatTurn[],
                          onText: (delta: string) => void, signal: AbortSignal): Promise<void> {
  const client = await claudeClient(apiKey);
  const modern = !/(^claude-3|-4-5|-4-1|-4-0|sonnet-4$|opus-4$)/.test(model);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(modern ? { output_config: { effort: 'medium' as const } } : {}),
    system,
    messages: turns.map(t => ({
      role: t.role,
      content: [
        ...t.images.map(data => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } })),
        { type: 'text' as const, text: t.text },
      ],
    })),
  }, { signal });
  stream.on('text', delta => onText(delta));
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
  }
}

// MARK: - ChatGPT (OpenAI REST API) and local servers with the same API (Ollama, LM Studio)
// `base`: https://api.openai.com/v1 or the local server; `apiKey` empty for local servers.
function openAiHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// ChatGPT takes json_object; local servers (LM Studio, Bionic…) only json_schema or text, and some
// none of them: each format is tried in turn when the server rejects it
async function askOpenAI(base: string, apiKey: string, model: string, tiles: Tile[], prompt: string, task: AskTask): Promise<string> {
  const formats: (object | null)[] = base === OPENAI_BASE
    ? [{ type: 'json_object' }]
    : [{ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: task.schema } }, { type: 'json_object' }, null];
  const messages = [
    { role: 'system', content: task.system },
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
  ];
  let json: { choices?: { message?: { content?: string; refusal?: string } }[] } | undefined;
  for (const [i, format] of formats.entries()) {
    try {
      json = await postJson(`${base}/chat/completions`, openAiHeaders(apiKey),
        { model, messages, ...(format ? { response_format: format } : {}) }) as typeof json;
      break;
    } catch (e) {
      const last = i === formats.length - 1;
      if (last || !/\b400\b.*(response_format|json_schema|json_object|grammar)/is.test(e instanceof Error ? e.message : '')) throw e;
    }
  }
  const message = json?.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`ChatGPT declined: ${message.refusal}`);
  return message?.content ?? '';
}

async function chatOpenAI(base: string, apiKey: string, model: string, system: string, turns: ChatTurn[],
                          onText: (delta: string) => void, signal: AbortSignal): Promise<void> {
  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      ...turns.map(t => t.images.length ? {
        role: t.role,
        content: [
          ...t.images.map(data => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}`, detail: 'high' } })),
          { type: 'text', text: t.text },
        ],
      } : { role: t.role, content: t.text }),
    ],
  };
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...openAiHeaders(apiKey) },
    body: JSON.stringify(body),
  });
  await readEvents(response, json => {
    const delta = (json as { choices?: { delta?: { content?: string; refusal?: string } }[] }).choices?.[0]?.delta;
    if (delta?.refusal) throw new Error(`ChatGPT declined: ${delta.refusal}`);
    if (delta?.content) onText(delta.content);
  });
}

// MARK: - Gemini (Google Generative Language REST API)
async function askGemini(apiKey: string, model: string, tiles: Tile[], prompt: string, task: AskTask): Promise<string> {
  const body = {
    systemInstruction: { parts: [{ text: task.system }] },
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

async function chatGemini(apiKey: string, model: string, system: string, turns: ChatTurn[],
                          onText: (delta: string) => void, signal: AbortSignal): Promise<void> {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map(t => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [...t.images.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } })), { text: t.text }],
    })),
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const response = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  await readEvents(response, json => {
    const chunk = json as { candidates?: { content?: { parts?: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
    if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini declined: ${chunk.promptFeedback.blockReason}`);
    const text = chunk.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    if (text) onText(text);
  });
}

// Server-sent events of a streamed answer ("data: {...}" lines)
async function readEvents(response: Response, onData: (json: unknown) => void): Promise<void> {
  if (!response.ok || !response.body) {
    await readJson(response);
    throw new Error(`${response.status}: no answer`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json: unknown;
      try { json = JSON.parse(data); } catch { continue; }
      onData(json);
    }
  }
}

// The answer without the action block (also while it is still being written)
function visibleText(raw: string): string {
  return raw.replace(ACTION_BLOCK, '').trim();
}

// `question`: what the user asked, to tell the kind of action when the model left out the label
function parseAction(raw: string, pageIndex: number, question = ''): ChatCountAction | undefined {
  const match = ACTION_BLOCK.exec(raw);
  if (!match) return undefined;
  try {
    const body = match[2].trim();
    const json = JSON.parse(body.slice(0, body.lastIndexOf('}') + 1)) as { kind?: unknown; items?: unknown; pages?: unknown; instructions?: unknown };
    const items = Array.isArray(json.items) ? json.items.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
    if (!items.length) return undefined;
    const instructions = typeof json.instructions === 'string' ? json.instructions : '';
    const label = (match[1] ?? '').replace('takeoff-', '');
    const said = typeof json.kind === 'string' ? json.kind.toLowerCase() : '';
    let kind: ChatCountAction['kind'];
    if (label === 'count' || label === 'linear' || label === 'area') kind = label;
    else if (said === 'count' || said === 'linear' || said === 'area') kind = said;
    else if (said === 'length') kind = 'linear';
    else {
      const words = `${question} ${items.join(' ')} ${instructions}`.toLowerCase();
      kind = /\b(area|[aá]rea|room|cuarto|habitaci[oó]n|sala|floor|piso|ceiling|cielo|slab|losa|sf|m2|m²)\b/.test(words) ? 'area'
        : /\b(wall|muro|pared|linear|lineal|length|largo|longitud|trace|traza|trazar|curb|bordillo|footing|zapata|pipe|tuber[ií]a|fence|baseboard)\b/.test(words) ? 'linear'
        : 'count';
    }
    return { kind, items: items.slice(0, 20), pages: json.pages === 'all' ? 'all' : 'current', instructions, pageIndex, state: 'ready' };
  } catch {
    return undefined;
  }
}

// Length of a polyline (same units as its points)
function polyLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

// The pieces of a polyline inside a rectangle (each segment cut with Liang–Barsky)
function clipPolyline(points: Pt[], r: Rect): Pt[][] {
  const pieces: Pt[][] = [];
  let current: Pt[] = [];
  const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1, inside = true;
    for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]]) {
      if (p === 0) {
        if (q < 0) { inside = false; break; }
      } else {
        const t = q / p;
        if (p < 0) { if (t > t1) { inside = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { inside = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!inside) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const start = { x: a.x + dx * t0, y: a.y + dy * t0 }, end = { x: a.x + dx * t1, y: a.y + dy * t1 };
    if (current.length && near(current[current.length - 1], start)) {
      current.push(end);
    } else {
      if (current.length > 1) pieces.push(current);
      current = [start, end];
    }
    if (t1 < 1) {                       // the line leaves the rectangle here
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

// The part of a polygon inside a rectangle (Sutherland–Hodgman)
function clipPolygon(points: Pt[], r: Rect): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [p => p.x >= r.x, (a, b) => ({ x: r.x, y: a.y + (b.y - a.y) * (r.x - a.x) / (b.x - a.x) })],
    [p => p.x <= r.x + r.w, (a, b) => ({ x: r.x + r.w, y: a.y + (b.y - a.y) * (r.x + r.w - a.x) / (b.x - a.x) })],
    [p => p.y >= r.y, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y - a.y) / (b.y - a.y), y: r.y })],
    [p => p.y <= r.y + r.h, (a, b) => ({ x: a.x + (b.x - a.x) * (r.y + r.h - a.y) / (b.y - a.y), y: r.y + r.h })],
  ];
  let out = points;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    input.forEach((b, i) => {
      const a = input[(i + input.length - 1) % input.length];
      if (inside(b)) {
        if (!inside(a)) out.push(cross(a, b));
        out.push(b);
      } else if (inside(a)) {
        out.push(cross(a, b));
      }
    });
    if (!out.length) break;
  }
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// MARK: - Helpers
// Gemini models this key can use for chat (generateContent), newest names first
async function listGeminiModels(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await getJson(url, { 'x-goog-api-key': apiKey }) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string;
    };
    for (const m of data.models ?? []) {
      const id = m.name.replace(/^models\//, '');
      if (m.supportedGenerationMethods?.includes('generateContent') && /^gemini-/.test(id)) ids.push(id);
    }
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

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

// The JSON of a line or area tracing answer (also takes "lines" or "polygons" for "shapes")
function parseShapeAnswer(text: string): AiShapeAnswer {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not return any shapes. Try again or add instructions.');
  const json = JSON.parse(text.slice(start, end + 1)) as { items?: Record<string, unknown>[]; notes?: unknown };
  const items = (Array.isArray(json.items) ? json.items : []).map(e => ({
    item_id: String(e['item_id'] ?? ''),
    shapes: (e['shapes'] ?? e['lines'] ?? e['polygons'] ?? []) as AiShape[],
  }));
  return { items, notes: typeof json.notes === 'string' ? json.notes : '' };
}

function errorText(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 401 || /\b401\b|invalid.*key|API key not valid|authentication/i.test(message)) return 'The API key was not accepted. Check it and try again.';
  if (status === 404 || /\b404\b|not.?found/i.test(message)) return `Model not found: ${message}`;
  if (status === 429 || /\b429\b/.test(message)) return 'Rate limit or quota reached on this account. Wait a moment or check billing.';
  if (e instanceof DOMException && e.name === 'AbortError') return 'Stopped.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Could not reach the AI service (network or browser blocked the request).';
  return message;
}
