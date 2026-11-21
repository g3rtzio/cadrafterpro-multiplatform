// PDF file pickers that open in the last folder used (Open File, From PDF, Insert Pages, Save As).
// Chromium remembers the folder per picker `id`; the last file handle is also kept in IndexedDB
// and passed as `startIn`, so the folder survives restarts of the desktop (Electron) window too.

export interface PickedFile {
  file: File;
  handle: FileSystemFileHandle | null;     // null when the browser has no File System Access API
}

const PICKER_ID = 'cadrafter-pdf';
const PDF_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];
const DB_NAME = 'cadrafterpro-files';
const STORE = 'handles';
const LAST_KEY = 'lastFile';

type OpenPicker = (options: object) => Promise<FileSystemFileHandle[]>;
type SavePicker = (options: object) => Promise<FileSystemFileHandle>;

// Opens the system dialog for one or more PDFs. Empty when cancelled.
export async function pickPdfFiles(multiple: boolean): Promise<PickedFile[]> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
  if (!picker) return pickWithInput(multiple);
  const options = { id: PICKER_ID, multiple, types: PDF_TYPES, excludeAcceptAllOption: false };
  let handles: FileSystemFileHandle[];
  try {
    handles = await withStartIn(start => picker(start ? { ...options, startIn: start } : options));
  } catch {
    return [];                                               // cancelled
  }
  if (handles[0]) void rememberFile(handles[0]);
  return Promise.all(handles.map(async handle => ({ file: await handle.getFile(), handle })));
}

// Save As dialog in the last folder used (null when cancelled or not supported)
export async function pickSavePdf(suggestedName: string, current: FileSystemFileHandle | null): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return null;
  const options = { id: PICKER_ID, suggestedName, types: PDF_TYPES };
  try {
    const handle = await withStartIn(start => picker(start ? { ...options, startIn: start } : options), current);
    void rememberFile(handle);
    return handle;
  } catch {
    return null;
  }
}

// Remembers a file opened another way (dropped on the window), so the next dialog starts beside it
export async function rememberFile(handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openDb();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(handle, LAST_KEY));
    db.close();
  } catch {
    // private window or blocked storage: Chromium's own per-id memory still works
  }
}

// Tries with the remembered folder; if that file or folder is gone, asks again without it
async function withStartIn<T>(open: (start: FileSystemHandle | null) => Promise<T>,
                              preferred: FileSystemHandle | null = null): Promise<T> {
  const start = preferred ?? await lastFile();
  if (!start) return open(null);
  try {
    return await open(start);
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') throw error;   // the user cancelled
    return open(null);
  }
}

async function lastFile(): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDb();
    const value = await request<FileSystemFileHandle | undefined>(db.transaction(STORE).objectStore(STORE).get(LAST_KEY));
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Safari and Firefox: a hidden file input (the browser decides the folder)
function pickWithInput(multiple: boolean): Promise<PickedFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])].map(file => ({ file, handle: null }))));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

// "002^A0.1" before "010^A1.2", "Sheet 2" before "Sheet 10" (the order Explorer shows by name)
export function byFileName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}
