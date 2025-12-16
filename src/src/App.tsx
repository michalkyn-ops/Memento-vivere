import React, { useEffect, useMemo, useRef, useState } from "react";
import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Firestore,
  type Timestamp,
} from "firebase/firestore";

// ------------------------------------------------------------
// Memento Vivere
// - režim bez účtu: localStorage
// - režim se synchronizací: "Magic link" na e-mail (Firebase Auth) + Firestore
// ------------------------------------------------------------

// ⚠️ FIREBASE CONFIG
// Vyplň hodnotami z Firebase Console → Project settings → SDK setup.
// Pokud nevyplníš, aplikace poběží v LOCAL režimu (bez synchronizace).
const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME",
  projectId: "REPLACE_ME",
  appId: "REPLACE_ME",
};

type FirebaseBundle = { app: FirebaseApp; auth: Auth; db: Firestore };

function isConfigFilled(cfg: Record<string, string>) {
  return Object.values(cfg).every((v) => typeof v === "string" && v.trim() && v !== "REPLACE_ME");
}

function initFirebaseSafely(): { ok: true; fb: FirebaseBundle } | { ok: false } {
  if (!isConfigFilled(FIREBASE_CONFIG)) return { ok: false };
  try {
    const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    const db = getFirestore(app);
    return { ok: true, fb: { app, auth, db } };
  } catch {
    return { ok: false };
  }
}

type EntryDoc = {
  success: string;
  emoji: string;
  color: string;
  createdAt: Timestamp | any;
};

type Entry = {
  id: string; // docId (cloud) nebo uuid (local)
  createdAtMs: number;
  success: string;
  emoji: string;
  color: string;
};

type Draft = {
  success: string;
  emoji: string;
};

type StorageShape = {
  version: 1;
  entriesById: Record<string, { id: string; createdAt: number; success: string; emoji: string; color: string }>;
  order: string[];
};

const STORAGE_KEY = "memento_vivere_v1";
const EMAIL_FOR_SIGNIN_KEY = "mv_email_for_signin";

const COLOR_PALETTE = [
  "bg-rose-200",
  "bg-amber-200",
  "bg-lime-200",
  "bg-emerald-200",
  "bg-teal-200",
  "bg-cyan-200",
  "bg-sky-200",
  "bg-indigo-200",
  "bg-violet-200",
  "bg-fuchsia-200",
];

const EMOJI_CHOICES = ["✨", "🏆", "🤝", "💡", "📈", "🌱", "❤️", "🎯", "🧠", "🧹", "📚", "🏠"];

function pickColor(seed: number) {
  return COLOR_PALETTE[seed % COLOR_PALETTE.length];
}

function makeEmptyDraft(): Draft {
  return { success: "", emoji: "✨" };
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadLocal(): StorageShape {
  const parsed = safeParse<StorageShape>(localStorage.getItem(STORAGE_KEY));
  if (!parsed || parsed.version !== 1) return { version: 1, entriesById: {}, order: [] };
  return parsed;
}

function saveLocal(data: StorageShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

// Grid layout (responsivní)
const CELL_DESKTOP = 120;
const CELL_MOBILE = 88;
const GAP = 0;
const PAD_DESKTOP = 16;
const PAD_MOBILE = 8;

export default function MementoVivere() {
  const fbInit = useMemo(() => initFirebaseSafely(), []);
  const auth = fbInit.ok ? fbInit.fb.auth : null;
  const db = fbInit.ok ? fbInit.fb.db : null;

  // Mode:
  // - pokud je Firebase nakonfigurovaný → nabízíme synchronizaci (magic link)
  // - pokud není → jedeme čistě local
  const syncAvailable = !!(auth && db);

  // Auth state (jen pro sync režim)
  const [user, setUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);

  // Entries
  const [localStore, setLocalStore] = useState<StorageShape>(() => loadLocal());
  const [cloudEntries, setCloudEntries] = useState<Entry[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);

  // Editor
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(makeEmptyDraft());
  const [isOpen, setIsOpen] = useState(false);

  // Viewport
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0, scrollTop: 0 });
  const isMobile = viewport.w > 0 && viewport.w < 640;
  const CELL = isMobile ? CELL_MOBILE : CELL_DESKTOP;
  const PAD = isMobile ? PAD_MOBILE : PAD_DESKTOP;

  // Persist local
  useEffect(() => {
    saveLocal(localStore);
  }, [localStore]);

  // Track scroll/resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => setViewport((v) => ({ ...v, scrollTop: el.scrollTop }));
    const ro = new ResizeObserver(() => setViewport((v) => ({ ...v, w: el.clientWidth, h: el.clientHeight })));

    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    setViewport({ w: el.clientWidth, h: el.clientHeight, scrollTop: el.scrollTop });

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // Auth listener
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, [auth]);

  // Complete magic link sign-in if URL contains it
  useEffect(() => {
    if (!auth) return;
    const href = window.location.href;
    if (!isSignInWithEmailLink(auth, href)) return;

    const storedEmail = localStorage.getItem(EMAIL_FOR_SIGNIN_KEY) || "";
    // V rámci tohoto chatu nechceme vyskakovat prompt – použijeme uložený e-mail.
    // Pokud není, zobrazíme UI pro zadání.
    if (!storedEmail) return;

    (async () => {
      try {
        setAuthBusy(true);
        await signInWithEmailLink(auth, storedEmail, href);
        localStorage.removeItem(EMAIL_FOR_SIGNIN_KEY);
        // Odstraníme query parametry z URL (čistší UX)
        window.history.replaceState({}, document.title, window.location.pathname);
      } finally {
        setAuthBusy(false);
      }
    })();
  }, [auth]);

  // Realtime cloud sync
  useEffect(() => {
    if (!db || !user) {
      setCloudEntries([]);
      return;
    }

    setCloudLoading(true);

    const colRef = collection(db, "users", user.uid, "entries");
    const q = query(colRef, orderBy("createdAt", "asc"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: Entry[] = snap.docs.map((d) => {
          const data = d.data() as EntryDoc;
          const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
          return {
            id: d.id,
            createdAtMs,
            success: (data.success || "").toString(),
            emoji: (data.emoji || "✨").toString(),
            color: (data.color || pickColor(createdAtMs)).toString(),
          };
        });
        setCloudEntries(next);
        setCloudLoading(false);
      },
      () => {
        setCloudEntries([]);
        setCloudLoading(false);
      },
    );

    return () => unsub();
  }, [db, user]);

  // Active entries source
  const entries: Entry[] = useMemo(() => {
    if (user && syncAvailable) return cloudEntries;
    // local → normalize
    return localStore.order
      .map((id) => localStore.entriesById[id])
      .filter(Boolean)
      .map((e) => ({ ...e, createdAtMs: e.createdAt }));
  }, [user, syncAvailable, cloudEntries, localStore]);

  // --- Editor actions ---
  function openNew() {
    setSelectedId(null);
    setDraft(makeEmptyDraft());
    setIsOpen(true);
  }

  function openExisting(id: string) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    setSelectedId(id);
    setDraft({ success: e.success, emoji: e.emoji });
    setIsOpen(true);
  }

  function closeEditor() {
    setIsOpen(false);
  }

  async function upsert() {
    const success = draft.success.trim();
    if (!success) {
      setIsOpen(false);
      return;
    }

    if (user && db && syncAvailable) {
      const colRef = collection(db, "users", user.uid, "entries");
      if (selectedId) {
        await setDoc(doc(db, "users", user.uid, "entries", selectedId), { success, emoji: draft.emoji }, { merge: true });
      } else {
        const createdAtMs = Date.now();
        await addDoc(colRef, {
          success,
          emoji: draft.emoji,
          color: pickColor(createdAtMs),
          createdAt: serverTimestamp(),
        } as EntryDoc);
      }
      setIsOpen(false);
      return;
    }

    // Local
    setLocalStore((prev) => {
      const next: StorageShape = { ...prev, entriesById: { ...prev.entriesById }, order: [...prev.order] };
      if (selectedId && next.entriesById[selectedId]) {
        next.entriesById[selectedId] = { ...next.entriesById[selectedId], success, emoji: draft.emoji };
      } else {
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id_${Date.now()}`;
        const createdAt = Date.now();
        next.entriesById[id] = { id, createdAt, success, emoji: draft.emoji, color: pickColor(createdAt) };
        next.order.push(id);
      }
      return next;
    });

    setIsOpen(false);
  }

  async function removeSelected() {
    if (!selectedId) return;

    if (user && db && syncAvailable) {
      await deleteDoc(doc(db, "users", user.uid, "entries", selectedId));
      setIsOpen(false);
      return;
    }

    setLocalStore((prev) => {
      const next: StorageShape = {
        ...prev,
        entriesById: { ...prev.entriesById },
        order: prev.order.filter((x) => x !== selectedId),
      };
      delete next.entriesById[selectedId];
      return next;
    });

    setIsOpen(false);
  }

  // --- Magic link auth ---
  async function sendMagicLink() {
    if (!auth) return;
    const trimmed = email.trim();
    if (!trimmed) return;

    setAuthBusy(true);
    try {
      const actionCodeSettings = {
        // Odkaz se vrátí sem do stejné stránky (v tomhle prostředí to funguje nejlépe)
        url: window.location.origin + window.location.pathname,
        handleCodeInApp: true,
      };
      await sendSignInLinkToEmail(auth, trimmed, actionCodeSettings);
      localStorage.setItem(EMAIL_FOR_SIGNIN_KEY, trimmed);
      setMagicSent(true);
    } finally {
      setAuthBusy(false);
    }
  }

  async function doSignOut() {
    if (!auth) return;
    await signOut(auth);
    setMagicSent(false);
  }

  // --- Grid mapping ---
  const cols = useMemo(() => {
    const usableW = Math.max(0, viewport.w - PAD * 2);
    return Math.max(1, Math.floor((usableW + GAP) / (CELL + GAP)));
  }, [viewport.w, PAD, CELL]);

  const contentRows = useMemo(() => {
    const minRows = Math.ceil(Math.max(1, entries.length) / cols);
    return Math.max(minRows + (isMobile ? 12 : 20), isMobile ? 70 : 100);
  }, [entries.length, cols, isMobile]);

  const totalCells = contentRows * cols;

  function cellAt(index: number) {
    return index < entries.length ? entries[index] : null;
  }

  function cellPosition(index: number) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return { x: PAD + col * (CELL + GAP), y: PAD + row * (CELL + GAP) };
  }

  const showLoginGate = syncAvailable && !user;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-6xl mx-auto px-4 md:px-8 pt-6 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-widest text-pink-600 uppercase"
              style={{ letterSpacing: "0.15em" }}
            >
              Memento Vivere
            </h1>
            <div className="mt-2 text-base sm:text-lg font-semibold text-slate-700">Ahoj Marku 👋</div>
            <div className="mt-4 text-[13px] sm:text-sm text-slate-700 max-w-3xl leading-relaxed text-justify">
              Memento vivere znamená pamatuj žít. Připomíná ti, aby sis uvědomoval, co se ti v životě daří, vnímal jeho barvy a
              zaznamenával každý svůj úspěch, i ten malý. Vede tě k radosti z přítomnosti a zároveň k tomu myslet na budoucnost s
              nadějí a vizí. Je to připomínka, že život není jen o přežití, ale o vědomém prožívání. <strong>Zaznamenej si z čeho máš radost.</strong>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {syncAvailable ? (
              user ? (
                <button
                  onClick={doSignOut}
                  className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:shadow-md active:translate-y-px"
                >
                  Odhlásit
                </button>
              ) : (
                <span className="text-xs text-slate-500">Sync: vypnuto (nepřihlášeno)</span>
              )
            ) : (
              <span className="text-xs text-slate-500">Sync: vypnuto (local)</span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 md:px-8 pb-10">
        <div ref={containerRef} className="h-[72vh] bg-white border rounded-2xl shadow-sm overflow-y-auto overflow-x-hidden relative">
          {showLoginGate ? (
            <div className="h-full flex items-center justify-center p-6 text-center">
              <div className="max-w-md w-full">
                <div className="text-lg font-extrabold text-slate-800 mb-2">Přihlášení přes e-mail (Magic link)</div>
                <div className="text-sm text-slate-600 mb-4">
                  Zadej e-mail. Pošlu ti odkaz. Otevři ho na zařízení, kde chceš používat synchronizaci.
                </div>

                <div className="flex gap-2">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-xl border bg-white"
                    placeholder="tvuj@email.cz"
                    inputMode="email"
                    autoComplete="email"
                  />
                  <button
                    onClick={sendMagicLink}
                    disabled={authBusy || !email.trim()}
                    className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-50"
                  >
                    Poslat
                  </button>
                </div>

                {magicSent && (
                  <div className="mt-3 text-sm text-emerald-700 font-semibold">Odkaz odeslán ✅ Zkontroluj e-mail.</div>
                )}

                <div className="mt-4 text-xs text-slate-500">
                  Pozn.: Aby to fungovalo, musíš mít ve Firebase povolený <b>Email link</b> a nastavené autorizované domény.
                </div>
              </div>
            </div>
          ) : (
            <div className="relative" style={{ height: PAD * 2 + contentRows * CELL }}>
              {cloudLoading && user && (
                <div className="absolute top-3 left-3 z-10 text-xs bg-white/90 border rounded-xl px-3 py-1">Načítám sync…</div>
              )}

              {Array.from({ length: totalCells }).map((_, idx) => {
                const entry = cellAt(idx);
                const { x, y } = cellPosition(idx);
                return (
                  <button
                    key={idx}
                    onClick={() => (entry ? openExisting(entry.id) : openNew())}
                    className={`absolute ${entry ? entry.color : "bg-slate-50"} border border-slate-200`}
                    style={{ left: x, top: y, width: CELL, height: CELL }}
                  >
                    {entry ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <span className={isMobile ? "text-4xl" : "text-5xl"}>{entry.emoji}</span>
                        <span className={isMobile ? "text-[10px] font-semibold" : "text-[11px] font-semibold"}>
                          {new Date(entry.createdAtMs).toLocaleDateString()}
                        </span>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-xl text-slate-400">+</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={closeEditor}>
          <div className="bg-white w-full max-w-2xl rounded-2xl border shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {EMOJI_CHOICES.map((em) => (
                  <button
                    key={em}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, emoji: em }))}
                    className={
                      "h-12 text-2xl rounded-xl border flex items-center justify-center transition " +
                      (draft.emoji === em
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white hover:bg-slate-50 border-slate-200")
                    }
                    aria-label={`Vybrat ${em}`}
                  >
                    {em}
                  </button>
                ))}
              </div>

              <div className="text-sm font-semibold text-slate-700">Z čeho mám radost</div>
              <textarea
                className="w-full px-3 py-3 border rounded-xl min-h-[220px] text-base"
                placeholder="Z čeho mám radost"
                value={draft.success}
                onChange={(e) => setDraft((d) => ({ ...d, success: e.target.value }))}
                autoFocus
              />

              <div className="flex justify-end gap-2">
                {selectedId && (
                  <button onClick={removeSelected} className="px-4 py-2 bg-rose-600 text-white rounded-xl">
                    Smazat
                  </button>
                )}
                <button onClick={upsert} className="px-4 py-2 bg-slate-900 text-white rounded-xl">
                  Uložit
                </button>
              </div>

              {authBusy && <div className="text-xs text-slate-500">Probíhá přihlášení…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
