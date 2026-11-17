// JavaScript formulas: a formula that starts with "js:" is JavaScript code instead of arithmetic.
//   js: [Qty] > 100 ? [Cost Each] * 0.9 : [Cost Each]
//   js: let waste = 1.1; return Math.ceil([Area] * waste / 32);
// [Name], [..] and [Parts:Name] work as in simple formulas. Helpers: v("Name"), parent("Name"),
// parts("Name"), round(x, decimals). Without "return", the code is one expression.
//
// Safety: estimates travel inside PDF files, and the browser keeps settings (AI keys) for this
// site. So code only runs when it was written in this browser (or the user allowed it): the
// formulas are remembered in localStorage. A document from someone else shows its JavaScript
// formulas as blocked until the user presses Allow.

const PREFIX = /^\s*js\s*:/i;
const STORAGE_KEY = 'trustedFormulaScripts';
const MAX_TRUSTED = 2000;

export function isScriptFormula(formula: string | null | undefined): boolean {
  return !!formula && PREFIX.test(formula);
}

// The code after "js:"
export function scriptCode(formula: string): string {
  return formula.replace(PREFIX, '').trim();
}

export function toScriptFormula(code: string): string {
  return `js: ${code.trim()}`;
}

// MARK: - Trusted code

let trusted: string[] | null = null;
const sessionTrusted = new Set<string>();      // typed in this session, not saved yet

function trustedList(): string[] {
  if (trusted) return trusted;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    trusted = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    trusted = [];
  }
  return trusted;
}

export function isScriptTrusted(code: string): boolean {
  const key = code.trim();
  return sessionTrusted.has(key) || trustedList().includes(key);
}

// Code the user typed or allowed. persist = false while typing (only the final text is saved).
export function trustScripts(codes: string[], persist = true): void {
  const keys = codes.map(c => c.trim()).filter(Boolean);
  keys.forEach(k => sessionTrusted.add(k));
  if (!persist || keys.length === 0) return;
  const list = trustedList().filter(k => !keys.includes(k));
  list.push(...keys);
  trusted = list.slice(-MAX_TRUSTED);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trusted)); } catch { /* storage full or blocked */ }
}

// The JavaScript formulas of a list of properties
export function scriptsOf(props: { formula: string }[]): string[] {
  return props.filter(p => isScriptFormula(p.formula)).map(p => scriptCode(p.formula));
}

// MARK: - Running

export interface ScriptHelpers {
  ref(name: string): number | string;          // [Name], [..], [Parts:Name]
  parent(name?: string): number | string;
  parts(name: string): number;
}

type Compiled = (...args: unknown[]) => unknown;
const compiled = new Map<string, Compiled | Error>();

// Globals hidden from formula code (it still isn't a sandbox; that's what the trust check is for)
const HIDDEN = ['window', 'self', 'globalThis', 'document', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'location', 'history', 'open',
  'postMessage', 'Worker', 'SharedWorker', 'importScripts', 'caches', 'cookieStore', 'alert', 'confirm', 'prompt'];

function compile(code: string): Compiled | Error {
  const cached = compiled.get(code);
  if (cached) return cached;
  let result: Compiled | Error;
  try {
    // [Name] → ref("Name")
    const body = code.replace(/\[([^\]]*)\]/g, (_, name: string) => `ref(${JSON.stringify(name)})`);
    const text = /\breturn\b/.test(body) ? body : `return (${body}\n);`;
    result = new Function('ref', 'v', 'parent', 'parts', 'round', ...HIDDEN, `"use strict";\n${text}`) as Compiled;
  } catch (e) {
    result = e instanceof Error ? e : new Error('Invalid JavaScript');
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(code, result);
  return result;
}

// Runs the code; throws with a readable message when it fails or isn't trusted
export function runScript(code: string, helpers: ScriptHelpers): number | string {
  if (!isScriptTrusted(code)) throw new ScriptBlockedError();
  const fn = compile(code);
  if (fn instanceof Error) throw new Error(`JavaScript: ${fn.message}`);
  const round = (x: number, decimals = 0) => {
    const f = Math.pow(10, decimals);
    return Math.round(Number(x) * f) / f;
  };
  const value = fn.call(undefined, helpers.ref, helpers.ref, helpers.parent, helpers.parts, round);
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 0;
  return String(value);
}

export const SCRIPT_BLOCKED = 'JavaScript blocked: written on another computer';

export class ScriptBlockedError extends Error {
  constructor() { super(SCRIPT_BLOCKED); }
}
