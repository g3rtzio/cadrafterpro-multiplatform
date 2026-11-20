import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AI_PROVIDERS, AiAssistant, AiProvider } from '../../services/ai-assistant/ai-assistant';
import { DrawingStore } from '../../services/drawing.store/drawing.store';
import { Icon } from '../icon/icon';

// AI panel of the right side bar. Without an API key it is the form to connect Claude, ChatGPT or
// Gemini; once connected it is a chat about the open drawing (the current page goes along as a
// picture plus its text). The chat can propose a count of takeoff items, which runs with one
// click and adds the counts straight into the document (Undo removes them).
@Component({
  selector: 'app-ai-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'properties' },
  template: `
    @let s = store.watch();
    @let info = ai.info();
    @let v = shownView();

    @if (v !== 'settings') {
      <div class="ai-header">
        <app-icon class="icon small" name="auto_awesome" />
        <span class="ai-title" [title]="ai.model()">{{ info.name }} <span class="secondary small">{{ ai.model() }}</span></span>
        <button class="icon-button" [class.active]="v === 'chat'" title="Chat" (click)="view.set('chat')">
          <app-icon class="icon small" name="chat" />
        </button>
        <button class="icon-button" title="New chat" [disabled]="!ai.chat().length" (click)="ai.newChat()">
          <app-icon class="icon small" name="edit_square" />
        </button>
        <button class="icon-button" title="AI provider and API key" (click)="view.set('settings')">
          <app-icon class="icon small" name="settings" />
        </button>
      </div>
    }

    @if (v === 'chat') {
      <div class="chat-list" #chatList>
        @for (m of ai.chat(); track m.id) {
          <div class="bubble" [class.user]="m.role === 'user'" [class.bad]="m.error">
            @if (m.page) { <div class="attached"><app-icon class="icon small" name="description" /> {{ m.page.name }}</div> }
            @if (m.role === 'user') {
              <div class="text">{{ m.text }}</div>
            } @else {
              <div class="text" [innerHTML]="markdown(m.text)"></div>
              @if (m.streaming) { <span class="typing"><i></i><i></i><i></i></span> }
            }
            @if (m.action; as a) {
              <div class="action">
                <div class="secondary small">Count on {{ a.pages === 'all' ? 'all pages' : s.pageName(a.pageIndex) }}:</div>
                <div class="action-items">{{ a.items.join(', ') }}</div>
                @if (a.state === 'ready') {
                  <button class="primary" [disabled]="ai.busy() || !s.hasDocument" (click)="ai.runAction(m.id)">
                    <app-icon class="icon small" name="auto_awesome" /> Count and Add to Drawing
                  </button>
                } @else if (a.state === 'running') {
                  <div class="busy"><span class="spinner"></span> {{ ai.progress() }}</div>
                  <button (click)="ai.cancel()">Stop</button>
                } @else {
                  <div class="secondary small">Done.</div>
                }
              </div>
            }
          </div>
        } @empty {
          <div class="chat-empty">
            <app-icon class="icon" name="auto_awesome" />
            <div>Ask {{ info.name }} about this drawing.</div>
            <div class="secondary small">The current page goes along as a picture with its text. The AI can also count symbols and add them to the takeoff.</div>
            <div class="suggestions">
              @for (q of suggestions; track q) {
                <button [disabled]="!s.hasDocument" (click)="ask(q)">{{ q }}</button>
              }
            </div>
          </div>
        }
      </div>
      <div class="composer">
        <textarea #input rows="3" placeholder="Message {{ info.name }}… (Enter sends, Shift+Enter new line)" [value]="draft()"
                  (input)="draft.set(value($event))" (keydown.enter)="enter($event)"></textarea>
        <div class="composer-row">
          <label class="check small" [class.off]="!s.hasDocument">
            <input type="checkbox" [checked]="withPage() && s.hasDocument" [disabled]="!s.hasDocument" (change)="withPage.set(checked($event))" />
            <span class="page-name">Include page {{ s.hasDocument ? s.pageName(s.currentPageIndex) : '' }}</span>
          </label>
          @if (ai.chatBusy()) {
            <button class="icon-button send" title="Stop" (click)="ai.stopChat()"><app-icon class="icon small" name="stop" /></button>
          } @else {
            <button class="icon-button send primary" title="Send" [disabled]="!draft().trim() || ai.busy()" (click)="ask(draft())">
              <app-icon class="icon small" name="send" />
            </button>
          }
        </div>
      </div>
    }

    @if (v === 'settings') {
    <!-- 1. Connection -->
    <section class="panel-section">
      <h3>AI Provider</h3>
      <div class="segmented">
        @for (p of providers; track p.id) {
          <button [class.active]="ai.provider() === p.id" (click)="setProvider(p.id)">{{ p.name }}</button>
        }
      </div>
      <label class="field">API key
        <div class="key-row">
          <input [type]="showKey() ? 'text' : 'password'" autocomplete="off" spellcheck="false"
                 [placeholder]="info.keyHint" [value]="ai.apiKey()" (change)="ai.setApiKey(value($event))" />
          <button class="icon-button" [title]="showKey() ? 'Hide key' : 'Show key'" (click)="showKey.set(!showKey())">
            <app-icon class="icon small" [name]="showKey() ? 'visibility_off' : 'visibility'" />
          </button>
        </div>
      </label>
      <div class="secondary small">
        Get a key at <a [href]="info.keyUrl" target="_blank" rel="noopener">{{ keyHost(info.keyUrl) }}</a>.
        A Claude Pro or ChatGPT Plus subscription doesn't include API access; the key is billed per use.
      </div>
      <label class="field">Model
        <input [attr.list]="'ai-models-' + info.id" [value]="ai.model()" (change)="ai.setModel(value($event))" />
        <datalist [id]="'ai-models-' + info.id">
          @for (m of ai.modelOptions(info.id); track m) { <option [value]="m"></option> }
        </datalist>
      </label>
      <label class="check"><input type="checkbox" [checked]="ai.remember()" (change)="ai.setRemember(checked($event))" />
        Remember the key on this computer</label>
      <div class="row-buttons">
        <button class="primary" [disabled]="ai.busy() || !ai.apiKey()" (click)="connect()">Connect</button>
        <button [disabled]="!ai.apiKey()" (click)="disconnect()">Disconnect</button>
        @if (ai.apiKey()) { <button (click)="view.set('chat')">Back to Chat</button> }
      </div>
      @if (ai.busy()) { <div class="busy"><span class="spinner"></span> {{ ai.progress() }}</div> }
      @if (ai.status(); as st) {
        <div class="status" [class.ok]="st.ok" [class.bad]="!st.ok">
          <app-icon class="icon small" [name]="st.ok ? 'check_circle' : 'error'" /> {{ st.text }}
        </div>
      }
      <div class="secondary small">The key stays in this browser and is sent only to {{ info.name }}. The AI sees the pictures and text of the pages you send.</div>
    </section>
    }

  `,
  styles: [`
    .segmented { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .segmented button { flex: 1; border: none; border-radius: 0; background: transparent; padding: 4px 0; }
    .segmented button + button { border-left: 1px solid var(--border); }
    .segmented button.active { background: var(--accent); color: #fff; }
    .key-row { display: flex; align-items: center; gap: 2px; }
    .key-row input { flex: 1; min-width: 0; }
    .check { display: flex; align-items: flex-start; gap: 6px; }
    .check input { margin-top: 2px; }
    .status { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    .status.ok { color: #1f9d55; }
    .status.bad { color: #d93025; }
    .item-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    .item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .new-item { display: flex; align-items: center; gap: 4px; }
    .new-item input { flex: 1; min-width: 0; }
    .color-dot { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.2); flex: none; }
    textarea { resize: vertical; font: inherit; }
    .busy { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .spinner { width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%;
      animation: spin 0.8s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .result-page { font-weight: 600; font-size: 12px; margin-top: 4px; }
    .notes { font-size: 12px; white-space: pre-wrap; padding: 6px; border-radius: 6px; background: var(--panel); border: 1px solid var(--border); }
    button.primary { display: flex; align-items: center; justify-content: center; gap: 4px; }
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    :host > .panel-section { flex: none; }
    .ai-header { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--border); flex: none; }
    .ai-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-header .icon-button.active { background: var(--accent); color: #fff; }
    .chat-list { flex: 1; min-height: 120px; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .bubble { max-width: 92%; align-self: flex-start; padding: 6px 9px; border-radius: 10px; font-size: 12.5px; line-height: 1.45;
      background: var(--panel); border: 1px solid var(--border); overflow-wrap: anywhere; }
    .bubble.user { align-self: flex-end; background: var(--accent); color: #fff; border-color: transparent; }
    .bubble.bad { border-color: #d93025; color: #d93025; }
    .bubble .text { white-space: pre-wrap; }
    .bubble .text ::ng-deep pre { white-space: pre-wrap; background: rgba(127, 127, 127, 0.12); padding: 6px; border-radius: 6px; margin: 4px 0; }
    .bubble .text ::ng-deep code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
    .attached { display: flex; align-items: center; gap: 3px; font-size: 11px; opacity: 0.85; margin-bottom: 2px; }
    .action { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    .action-items { font-weight: 600; }
    .typing { display: inline-flex; gap: 3px; padding: 4px 0; }
    .typing i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.4; animation: blink 1.2s infinite; }
    .typing i:nth-child(2) { animation-delay: 0.2s; }
    .typing i:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 50% { opacity: 1; } }
    .chat-empty { margin: auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 4px; }
    .suggestions { display: flex; flex-direction: column; gap: 4px; width: 100%; margin-top: 4px; }
    .suggestions button { text-align: left; white-space: normal; }
    .composer { flex: none; border-top: 1px solid var(--border); padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .composer textarea { width: 100%; box-sizing: border-box; resize: none; }
    .composer-row { display: flex; align-items: center; gap: 6px; }
    .composer-row .check { flex: 1; min-width: 0; align-items: center; }
    .composer-row .check.off { opacity: 0.5; }
    .page-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .send.primary { background: var(--accent); color: #fff; }
    .send:disabled { opacity: 0.4; }
  `],
})
export class AiPanel {
  readonly store = inject(DrawingStore);
  readonly ai = inject(AiAssistant);
  readonly providers = AI_PROVIDERS;

  readonly showKey = signal(false);
  // What the panel shows; without a key it is always the connection form
  readonly view = signal<'chat' | 'settings'>(this.ai.apiKey() ? 'chat' : 'settings');
  readonly draft = signal('');
  readonly withPage = signal(true);
  readonly suggestions = [
    'Summarize this sheet',
    'What is the scale of this sheet?',
    'List the rooms with their sizes',
    'Count the electrical outlets on this page',
  ];
  private readonly chatList = viewChild<ElementRef<HTMLElement>>('chatList');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  constructor() {
    // Follow the newest message while it is written
    effect(() => {
      this.ai.chat();
      const list = this.chatList()?.nativeElement;
      if (list) untracked(() => requestAnimationFrame(() => list.scrollTop = list.scrollHeight));
    });
  }

  shownView(): 'chat' | 'settings' {
    return this.ai.apiKey() ? this.view() : 'settings';
  }

  // Connect = check the key; when it works the panel turns into the chat
  async connect(): Promise<void> {
    if (await this.ai.testConnection()) {
      this.view.set('chat');
      setTimeout(() => this.input()?.nativeElement.focus());
    }
  }

  disconnect(): void {
    this.ai.forgetKey();
    this.view.set('settings');
  }

  ask(text: string): void {
    if (!text.trim()) return;
    void this.ai.send(text, this.withPage());
    this.draft.set('');
  }

  enter(e: Event): void {
    const k = e as KeyboardEvent;
    if (k.shiftKey || k.isComposing) return;
    e.preventDefault();
    if (!this.ai.chatBusy()) this.ask(this.draft());
  }

  // Light Markdown for the answers: code, bold, italic, headings (the text is escaped first)
  markdown(text: string): string {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/```[a-z-]*\n?([\s\S]*?)(```|$)/g, (_, code: string) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
  }

  setProvider(p: AiProvider): void {
    this.showKey.set(false);
    this.ai.setProvider(p);
  }

  keyHost(url: string): string { return new URL(url).host; }
  value(e: Event): string { return (e.target as HTMLInputElement).value; }
  checked(e: Event): boolean { return (e.target as HTMLInputElement).checked; }
}
