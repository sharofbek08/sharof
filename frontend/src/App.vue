<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, reactive, ref, watch } from "vue";

const STORAGE_KEY = "satrlarim-entries-v1";
const TOKEN_STORAGE_KEY = "satrlarim-api-token-v1";
const OWNER_STORAGE_KEY = "satrlarim-api-owner-v1";
const IMPORT_STORAGE_PREFIX = "satrlarim-postgres-imported-v1:";
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");
const LOCKED_TEXT = "[locked]";
const ENCRYPTION_ITERATIONS = 310000;

const starterEntries = [
  {
    id: "starter-poem",
    type: "poem",
    text: "Ko‘nglimda bir bahor uyg‘onsa agar,\nUning ilk hidi sening ismingdir.",
    author: "Shaxsiy daftar",
    tags: ["muhabbat", "bahor"],
    favorite: true,
    createdAt: "2026-09-20T08:00:00.000Z"
  },
  {
    id: "starter-quote",
    type: "quote",
    text: "Chiroyli so‘z — qalbga qo‘yilgan eng mayin qo‘ldir.",
    author: "Noma’lum",
    tags: ["so‘z", "ilhom"],
    favorite: false,
    createdAt: "2026-09-19T08:00:00.000Z"
  },
  {
    id: "starter-poem-2",
    type: "poem",
    text: "Yo‘llar uzoq bo‘lsa ham,\nYurak manzilini unutmaydi.",
    author: "Shaxsiy daftar",
    tags: ["sog‘inch", "yo‘l"],
    favorite: false,
    createdAt: "2026-09-18T08:00:00.000Z"
  }
];

function readSavedEntries() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) return saved;
  } catch (error) {
    console.warn("Yozuvlarni o‘qib bo‘lmadi", error);
  }
  return null;
}

const savedLocalEntries = readSavedEntries();

function loadEntries() {
  return savedLocalEntries || starterEntries.map((entry) => ({ ...entry, tags: [...entry.tags] }));
}

function createEntryId() {
  return window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requireWebCrypto() {
  if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
    throw new Error("Maxfiy kod uchun HTTPS yoki localhost orqali saytni oching.");
  }
  return window.crypto;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveEntryKey(passphrase, salt, iterations, usage) {
  const crypto = requireWebCrypto();
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

async function encryptEntryContent(content, passphrase) {
  const crypto = requireWebCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEntryKey(passphrase, salt, ENCRYPTION_ITERATIONS, "encrypt");
  const plaintext = new TextEncoder().encode(JSON.stringify(content));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    version: 1,
    iterations: ENCRYPTION_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptEntryContent(entry, passphrase) {
  const crypto = requireWebCrypto();
  const encryption = entry.encryption;
  if (!encryption || encryption.version !== 1 || encryption.iterations !== ENCRYPTION_ITERATIONS) {
    throw new Error("Bu kodlangan yozuv formati qo‘llab-quvvatlanmaydi.");
  }
  const salt = base64ToBytes(encryption.salt);
  const iv = base64ToBytes(encryption.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("Kodlangan yozuv buzilgan.");
  const key = await deriveEntryKey(passphrase, salt, encryption.iterations, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(encryption.ciphertext)
  );
  const content = JSON.parse(new TextDecoder().decode(plaintext));
  if (!content || typeof content.text !== "string" || typeof content.author !== "string" || !Array.isArray(content.tags)) {
    throw new Error("Kodlangan yozuv buzilgan.");
  }
  return content;
}

function formatDate(value) {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "00.00.0000";
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  } catch {
    return "00.00.0000";
  }
}

function normalizeTags(value) {
  return [...new Set(value.split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))].slice(0, 8);
}

const entries = ref(loadEntries());
const searchQuery = ref("");
const activeFilter = ref("all");
const syncMode = ref("connecting");
const syncMessage = ref("Backend va PostgreSQL bazasiga ulanmoqda…");
const toastMessage = ref("");
const toastVisible = ref(false);
const selectedLogo = ref("assets/logo1.svg");
const apiToken = ref(readStorageValue(TOKEN_STORAGE_KEY));
const ownerId = ref(readStorageValue(OWNER_STORAGE_KEY));
const entryDialog = ref(null);
const unlockDialog = ref(null);
const logoDialog = ref(null);
const entryTextField = ref(null);
const unlockPassphraseField = ref(null);
const entryListElement = ref(null);
const formError = ref("");
const unlockError = ref("");
const isSaving = ref(false);
const isUnlocking = ref(false);
const unlockTargetId = ref("");
const unlockForEdit = ref(false);
const unlockedEntries = reactive(new Map());
const form = reactive({
  id: "",
  type: "poem",
  text: "",
  author: "",
  tags: "",
  protect: false,
  passphrase: "",
  passphraseConfirm: ""
});
const unlockForm = reactive({ passphrase: "" });

let toastTimer = null;
let cardObserver = null;

const visibleEntries = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase("uz-UZ");
  return entries.value.filter((entry) => {
    const matchesFilter = activeFilter.value === "all"
      || (activeFilter.value === "favorite" && entry.favorite)
      || entry.type === activeFilter.value;
    const content = getUnlockedContent(entry);
    const searchable = content
      ? [content.text, content.author, ...(content.tags || [])].join(" ").toLocaleLowerCase("uz-UZ")
      : "";
    return matchesFilter && (!query || searchable.includes(query));
  });
});

const totalCount = computed(() => entries.value.length);
const poemCount = computed(() => entries.value.filter((entry) => entry.type === "poem").length);
const favoriteCount = computed(() => entries.value.filter((entry) => entry.favorite).length);
const storageNote = computed(() => {
  if (syncMode.value === "online") {
    return "Yozuvlar shu kompyuterdagi PostgreSQL bazasida saqlanadi.";
  }
  if (syncMode.value === "offline") {
    return "Backend yoki PostgreSQL bazasiga ulanilmadi. Backend va ma’lumotlar bazasini ishga tushirib, sahifani yangilang.";
  }
  return "Yozuvlar backend orqali PostgreSQL bazasiga saqlanadi.";
});
const dialogTitle = computed(() => form.id ? "Yozuvni tahrirlash" : "Yangi yozuv");
const dialogDescription = computed(() => {
  if (!form.id) return "Yuragingizga yaqin satrni saqlab qo‘ying.";
  return form.protect
    ? "Saqlash uchun kodni qayta kiriting. Yangi kod kiritsangiz, kod o‘zgaradi."
    : "Kerakli joylarini yangilang va qayta saqlang.";
});
watch(() => form.protect, (enabled) => {
  if (!enabled) {
    form.passphrase = "";
    form.passphraseConfirm = "";
  }
});

function readStorageValue(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function setSyncStatus(message, mode = "local") {
  syncMessage.value = message;
  syncMode.value = mode;
}

function canManageEntry(entry) {
  return Boolean(ownerId.value && entry.ownerId === ownerId.value);
}

function isProtectedEntry(entry) {
  return Boolean(entry.encryption);
}

function getUnlockedContent(entry) {
  if (!isProtectedEntry(entry)) return entry;
  const unlocked = unlockedEntries.get(entry.id);
  return unlocked?.ciphertext === entry.encryption.ciphertext ? unlocked.content : null;
}

function isEntryLocked(entry) {
  return isProtectedEntry(entry) && !getUnlockedContent(entry);
}

function saveLocalEntries() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value));
  } catch (error) {
    console.warn("Yozuvlarni saqlab bo‘lmadi", error);
    showToast("Brauzer keshi uchun xotira mavjud emas.");
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toastMessage.value = message;
  toastVisible.value = true;
  toastTimer = window.setTimeout(() => {
    toastVisible.value = false;
  }, 2600);
}

function ensureBackendReady() {
  if (syncMode.value === "connecting") {
    showToast("Backend ulanishini kuting.");
    return false;
  }
  if (syncMode.value === "offline") {
    showToast("Backend ishlamayapti. Serverni ishga tushirib, sahifani yangilang.");
    return false;
  }
  return true;
}

function setSession(session) {
  apiToken.value = session.token;
  ownerId.value = session.ownerId;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, session.token);
    localStorage.setItem(OWNER_STORAGE_KEY, session.ownerId);
  } catch {
    throw new Error("Sessiyani brauzerda saqlab bo‘lmadi.");
  }
}

async function createAnonymousSession() {
  const response = await fetch(`${API_BASE_URL}/auth/anonymous`, { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Backend sessiyasini yaratib bo‘lmadi.");
  setSession(payload);
}

async function apiRequest(path, options = {}, mayRetry = true) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (apiToken.value) headers.set("Authorization", `Bearer ${apiToken.value}`);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

  if (response.status === 401 && mayRetry && path !== "/auth/anonymous") {
    await createAnonymousSession();
    return apiRequest(path, options, false);
  }

  const payload = response.status === 204
    ? null
    : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || "Backend so‘rovni bajara olmadi.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function importMarkerKey() {
  return `${IMPORT_STORAGE_PREFIX}${ownerId.value}`;
}

async function importCachedLocalEntries() {
  if (!savedLocalEntries?.length || !ownerId.value) return false;
  if (localStorage.getItem(importMarkerKey()) === "done") return false;

  const personalEntries = savedLocalEntries.filter((entry) => (
    entry && typeof entry === "object" && entry.id && !String(entry.id).startsWith("starter-")
  ));
  for (const entry of personalEntries) {
    if (entry.ownerId) continue;
    const payload = {
      ...entry,
      id: String(entry.id).slice(0, 100),
      author: entry.author ?? null,
      tags: Array.isArray(entry.tags) && entry.tags.length ? entry.tags : null
    };
    try {
      await apiRequest("/entries", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  localStorage.setItem(importMarkerKey(), "done");
  return personalEntries.length > 0;
}

async function initializeBackend() {
  setSyncStatus("Backend va PostgreSQL bazasiga ulanmoqda…", "connecting");
  try {
    if (!apiToken.value || !ownerId.value) await createAnonymousSession();
    await apiRequest("/health");
    let remoteEntries = await apiRequest("/entries");
    const imported = await importCachedLocalEntries();
    if (imported) remoteEntries = await apiRequest("/entries");
    entries.value = remoteEntries.length
      ? remoteEntries
      : (savedLocalEntries || starterEntries.map((entry) => ({ ...entry, tags: [...entry.tags] })));
    setSyncStatus("PostgreSQL bazasi bilan sinxronlandi", "online");
    saveLocalEntries();
  } catch (error) {
    setSyncStatus("Backend yoki PostgreSQL’ga ulanilmadi", "offline");
    console.warn("Backend bilan ulanishda xatolik", error);
  }
}

function resetForm() {
  Object.assign(form, {
    id: "",
    type: "poem",
    text: "",
    author: "",
    tags: "",
    protect: false,
    passphrase: "",
    passphraseConfirm: ""
  });
  formError.value = "";
}

async function openAddDialog() {
  resetForm();
  await nextTick();
  if (!entryDialog.value?.open) entryDialog.value?.showModal();
  entryTextField.value?.focus();
}

async function openEditDialog(id) {
  const entry = entries.value.find((item) => item.id === id);
  if (!entry) return;
  const content = getUnlockedContent(entry);
  if (!content) {
    openUnlockDialog(id, true);
    return;
  }

  Object.assign(form, {
    id: entry.id,
    type: entry.type,
    text: content.text,
    author: content.author || "",
    tags: (content.tags || []).join(", "),
    protect: isProtectedEntry(entry),
    passphrase: "",
    passphraseConfirm: ""
  });
  formError.value = "";
  await nextTick();
  if (!entryDialog.value?.open) entryDialog.value?.showModal();
  entryTextField.value?.focus();
}

function closeEntryDialog() {
  if (entryDialog.value?.open) entryDialog.value.close();
}

function clearFormSecrets() {
  form.passphrase = "";
  form.passphraseConfirm = "";
}

function openUnlockDialog(id, forEdit = false) {
  const entry = entries.value.find((item) => item.id === id);
  if (!entry || !isProtectedEntry(entry)) return;
  try {
    requireWebCrypto();
  } catch (error) {
    showToast(error.message);
    return;
  }
  unlockTargetId.value = id;
  unlockForEdit.value = forEdit;
  unlockForm.passphrase = "";
  unlockError.value = "";
  if (!unlockDialog.value?.open) unlockDialog.value?.showModal();
  nextTick(() => unlockPassphraseField.value?.focus());
}

function closeUnlockDialog() {
  if (unlockDialog.value?.open) unlockDialog.value.close();
  unlockForm.passphrase = "";
  unlockTargetId.value = "";
  unlockForEdit.value = false;
}

async function unlockEntry() {
  const entry = entries.value.find((item) => item.id === unlockTargetId.value);
  if (!entry || !isProtectedEntry(entry)) {
    closeUnlockDialog();
    return;
  }

  isUnlocking.value = true;
  unlockError.value = "";
  try {
    const content = await decryptEntryContent(entry, unlockForm.passphrase);
    const forEdit = unlockForEdit.value;
    unlockedEntries.set(entry.id, { ciphertext: entry.encryption.ciphertext, content });
    closeUnlockDialog();
    if (forEdit) await openEditDialog(entry.id);
  } catch (error) {
    unlockError.value = error.message?.startsWith("Bu kodlangan yozuv") || error.message?.startsWith("Kodlangan yozuv")
      ? error.message
      : "Kod noto‘g‘ri yoki yozuvni ochib bo‘lmadi.";
    unlockPassphraseField.value?.focus();
  } finally {
    isUnlocking.value = false;
  }
}

function lockEntry(entry) {
  unlockedEntries.delete(entry.id);
}

async function copyEntry(entry) {
  const content = getUnlockedContent(entry);
  if (!content) {
    showToast("Avval matnni maxfiy kod bilan oching.");
    return;
  }
  const text = `${content.text}${content.author ? `\n— ${content.author}` : ""}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast("Yozuv nusxalandi.");
}

async function saveEntry() {
  const text = form.text.trim();
  if (!text) {
    formError.value = "Avval saqlamoqchi bo‘lgan satringizni yozing.";
    entryTextField.value?.focus();
    return;
  }
  if (!ensureBackendReady()) return;

  const tags = normalizeTags(form.tags);
  if (tags.some((tag) => tag.length > 40)) {
    formError.value = "Har bir teg 40 belgidan oshmasin.";
    return;
  }
  const existingId = form.id;
  const existingEntry = existingId ? entries.value.find((entry) => entry.id === existingId) : null;
  if (existingId && !existingEntry) {
    formError.value = "Tahrirlanayotgan yozuv topilmadi.";
    return;
  }
  if (existingEntry && isProtectedEntry(existingEntry) && !getUnlockedContent(existingEntry)) {
    formError.value = "Avval yozuvni maxfiy kod bilan oching.";
    return;
  }
  if (form.protect && (form.passphrase.length < 8 || form.passphrase.length > 128)) {
    formError.value = "Maxfiy kod 8–128 belgidan iborat bo‘lsin.";
    return;
  }
  if (form.protect && form.passphrase !== form.passphraseConfirm) {
    formError.value = "Ikkala maxfiy kod bir xil emas.";
    return;
  }
  if (existingEntry && isProtectedEntry(existingEntry) && !form.protect
    && !window.confirm("Himoyani olib tashlasangiz, matn hammaga ochiq ko‘rinadi. Davom etasizmi?")) {
    return;
  }

  isSaving.value = true;
  formError.value = "";
  try {
    const entryData = form.protect
      ? {
          type: form.type,
          text: LOCKED_TEXT,
          author: null,
          tags: null,
          encryption: await encryptEntryContent({ text, author: form.author.trim(), tags }, form.passphrase)
        }
      : {
          type: form.type,
          text,
          author: form.author.trim(),
          tags: tags.length ? tags : null,
          encryption: null
        };

    if (existingId) {
      if (!existingEntry || !canManageEntry(existingEntry)) {
        throw new Error("Bu yozuvni faqat uni kiritgan kishi tahrirlashi mumkin");
      }
      const updatedEntry = await apiRequest(`/entries/${encodeURIComponent(existingId)}`, {
        method: "PATCH",
        body: JSON.stringify(entryData)
      });
      const index = entries.value.findIndex((entry) => entry.id === existingId);
      if (index !== -1) entries.value[index] = updatedEntry;
      unlockedEntries.delete(existingId);
      saveLocalEntries();
      showToast("Yozuv yangilandi.");
    } else {
      const newEntry = {
        id: createEntryId(),
        ...entryData,
        favorite: false,
        createdAt: new Date().toISOString()
      };
      const savedEntry = await apiRequest("/entries", {
        method: "POST",
        body: JSON.stringify(newEntry)
      });
      entries.value.unshift(savedEntry);
      saveLocalEntries();
      showToast("Yozuv PostgreSQL bazasiga saqlandi.");
    }
    closeEntryDialog();
  } catch (error) {
    formError.value = error.message || "Yozuvni saqlab bo‘lmadi. Qayta urinib ko‘ring.";
    console.warn("Yozuvni saqlashda xatolik", error);
  } finally {
    isSaving.value = false;
  }
}

async function toggleFavorite(entry) {
  if (!ensureBackendReady()) return;
  if (!canManageEntry(entry)) {
    showToast("Bu yozuvni faqat uni kiritgan kishi o‘zgartira oladi.");
    return;
  }
  const favorite = !entry.favorite;
  try {
    const updatedEntry = await apiRequest(`/entries/${encodeURIComponent(entry.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ favorite })
    });
    Object.assign(entry, updatedEntry);
    saveLocalEntries();
    showToast(favorite ? "Sevimlilarga qo‘shildi." : "Sevimlilardan olindi.");
  } catch (error) {
    showToast("O‘zgarishni saqlab bo‘lmadi. Qayta urinib ko‘ring.");
    console.warn("Yozuvni yangilashda xatolik", error);
  }
}

async function deleteEntry(entry) {
  if (!ensureBackendReady()) return;
  if (!canManageEntry(entry)) {
    showToast("Bu yozuvni faqat uni kiritgan kishi o‘zgartira oladi.");
    return;
  }
  if (!window.confirm("Bu yozuvni o‘chirmoqchimisiz?")) return;
  try {
    await apiRequest(`/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    entries.value = entries.value.filter((item) => item.id !== entry.id);
    saveLocalEntries();
    unlockedEntries.delete(entry.id);
    showToast("Yozuv o‘chirildi.");
  } catch (error) {
    showToast("O‘zgarishni saqlab bo‘lmadi. Qayta urinib ko‘ring.");
    console.warn("Yozuvni o‘chirishda xatolik", error);
  }
}

function loadSavedLogo() {
  try {
    const saved = localStorage.getItem("satrlarim-logo");
    selectedLogo.value = saved === "assets/logo1.svg" ? saved : "assets/logo1.svg";
  } catch {
    selectedLogo.value = "assets/logo1.svg";
  }
}

function chooseLogo(src) {
  selectedLogo.value = src;
  try {
    localStorage.setItem("satrlarim-logo", src);
  } catch {
    // Keep the current selection for this page even if storage is unavailable.
  }
  if (logoDialog.value?.open) logoDialog.value.close();
}

function openLogoDialog() {
  if (!logoDialog.value?.open) logoDialog.value?.showModal();
}

function closeLogoDialog() {
  if (logoDialog.value?.open) logoDialog.value.close();
}

function clearUnlockedEntriesWhenHidden() {
  if (document.hidden && unlockedEntries.size) unlockedEntries.clear();
}

function observeEntryCards() {
  if (cardObserver) {
    cardObserver.disconnect();
    cardObserver = null;
  }
  const cards = entryListElement.value?.querySelectorAll(".reveal-card:not(.is-visible)") || [];
  if (!cards.length) return;

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    cards.forEach((card) => card.classList.add("is-visible"));
    return;
  }
  cardObserver = new IntersectionObserver((observedCards, observer) => {
    observedCards.forEach((observedCard) => {
      if (!observedCard.isIntersecting) return;
      observedCard.target.classList.add("is-visible");
      observer.unobserve(observedCard.target);
    });
  }, { threshold: 0.01, rootMargin: "0px 0px -6% 0px" });
  cards.forEach((card, index) => {
    card.style.setProperty("--card-delay", `${Math.min(index, 5) * 90}ms`);
    cardObserver.observe(card);
  });
}

onMounted(() => {
  loadSavedLogo();
  initializeBackend();
  document.addEventListener("visibilitychange", clearUnlockedEntriesWhenHidden);
  observeEntryCards();
});

onUpdated(observeEntryCards);

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer);
  if (cardObserver) cardObserver.disconnect();
  document.removeEventListener("visibilitychange", clearUnlockedEntriesWhenHidden);
});
</script>

<template>
  <div class="site-wrap">
    <header class="topbar">
      <a class="brand" href="#top" aria-label="Satrlarim bosh sahifasi">
        <img
          id="brand-logo"
          :src="`/${selectedLogo}`"
          alt="M logotipi"
          width="44"
          height="44"
          style="border-radius: 8px; vertical-align: middle; margin-right: 8px;"
          @click.prevent="openLogoDialog"
        />
        <span>
          <span class="brand-name">Mening</span>
          <span class="brand-subtitle">So‘zlar sandig‘im</span>
        </span>
      </a>
      <div class="quiet-note" :class="`is-${syncMode}`" role="status">
        <span class="status-dot" aria-hidden="true"></span>
        <span>{{ syncMessage }}</span>
      </div>
    </header>

    <main id="top">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-birds" aria-hidden="true">
          <span class="hero-bird bird-one">
            <svg viewBox="0 0 48 28" focusable="false"><path d="M2 20C8 10 14 10 21 20c5-12 13-12 24-1" /></svg>
          </span>
          <span class="hero-bird bird-two">
            <svg viewBox="0 0 48 28" focusable="false"><path d="M2 20C8 10 14 10 21 20c5-12 13-12 24-1" /></svg>
          </span>
          <span class="hero-bird bird-three">
            <svg viewBox="0 0 48 28" focusable="false"><path d="M2 20C8 10 14 10 21 20c5-12 13-12 24-1" /></svg>
          </span>
        </div>
        <div class="hero-content">
          <p class="eyebrow">Shaxsiy kutubxonangiz</p>
          <h1 id="hero-title">Yurakka yaqin so‘zlar bir joyda.</h1>
          <p class="hero-copy">Sevimli she’rlaringiz, qalbdagi so‘zlaringiz va o‘zingiz yozgan satrlarni yig‘ib boring. Har bir so‘z — alohida xotira.</p>
          <div class="hero-actions">
            <button class="button button-primary" type="button" @click="openAddDialog">
              <svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
              Yangi yozuv qo‘shish
            </button>
            <a class="button button-ghost" href="#yozuvlar">Yozuvlarni ko‘rish</a>
          </div>
        </div>
      </section>

      <div class="content-grid">
        <section class="main-column" id="yozuvlar" aria-labelledby="entries-title">
          <div class="search-row">
            <label class="search-box">
              <span class="sr-only">Yozuvlarni qidirish</span>
              <svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input v-model="searchQuery" type="search" placeholder="So‘z, muallif yoki teg bo‘yicha qidiring…" autocomplete="off" />
            </label>
            <button class="button button-secondary" type="button" @click="openAddDialog">+ Qo‘shish</button>
          </div>

          <div class="filter-bar" role="toolbar" aria-label="Yozuvlarni saralash">
            <button class="filter-chip" :class="{ 'is-active': activeFilter === 'all' }" type="button" :aria-pressed="activeFilter === 'all'" @click="activeFilter = 'all'">Barchasi</button>
            <button class="filter-chip" :class="{ 'is-active': activeFilter === 'poem' }" type="button" :aria-pressed="activeFilter === 'poem'" @click="activeFilter = 'poem'">She’rlar</button>
            <button class="filter-chip" :class="{ 'is-active': activeFilter === 'quote' }" type="button" :aria-pressed="activeFilter === 'quote'" @click="activeFilter = 'quote'">Qalbdagi so‘zlar</button>
            <button class="filter-chip" :class="{ 'is-active': activeFilter === 'favorite' }" type="button" :aria-pressed="activeFilter === 'favorite'" @click="activeFilter = 'favorite'">Sevimlilar</button>
          </div>

          <div class="section-heading">
            <h2 id="entries-title">Saqlangan yozuvlar</h2>
            <span class="entry-count" aria-live="polite">{{ visibleEntries.length }} ta yozuv</span>
          </div>
          <div ref="entryListElement" class="entry-list" id="entry-list">
            <article
              v-for="(entry, index) in visibleEntries"
              :key="entry.id"
              class="entry-card reveal-card"
              :class="entry.type"
              :data-id="entry.id"
              :style="{ '--card-delay': `${Math.min(index, 5) * 90}ms` }"
            >
              <div class="card-topline">
                <span class="type-label">
                  <span class="type-dot" aria-hidden="true"></span>
                  {{ entry.type === 'poem' ? 'She’r' : 'Qalbdagi so‘zlar' }}
                  <span v-if="isProtectedEntry(entry)" class="lock-badge">Kodli</span>
                </span>
                <time class="date" :datetime="entry.createdAt">{{ formatDate(entry.createdAt) }}</time>
              </div>
              <p class="entry-text" :class="{ 'is-locked': isEntryLocked(entry) }">
                {{ isEntryLocked(entry) ? 'Bu matn maxfiy kod bilan himoyalangan.' : getUnlockedContent(entry).text }}
              </p>
              <p v-if="!isEntryLocked(entry)" class="entry-author">
                {{ getUnlockedContent(entry).author || 'Muallif ko‘rsatilmagan' }}
              </p>
              <div class="card-footer">
                <div class="tag-list">
                  <span v-for="tag in (getUnlockedContent(entry)?.tags || [])" :key="tag" class="tag">#{{ tag }}</span>
                </div>
                <div class="card-actions">
                  <button
                    v-if="isProtectedEntry(entry)"
                    class="small-button"
                    type="button"
                    @click="isEntryLocked(entry) ? openUnlockDialog(entry.id) : lockEntry(entry)"
                  >{{ isEntryLocked(entry) ? 'Kod bilan ochish' : 'Yashirish' }}</button>
                  <button
                    v-if="canManageEntry(entry)"
                    class="small-button"
                    :class="{ 'is-favorite': entry.favorite }"
                    type="button"
                    :aria-label="entry.favorite ? 'Sevimlidan olish' : 'Sevimliga qo‘shish'"
                    @click="toggleFavorite(entry)"
                  >{{ entry.favorite ? '♥ Sevimli' : '♡ Sevimli' }}</button>
                  <button v-if="!isEntryLocked(entry)" class="small-button" type="button" @click="copyEntry(entry)">Nusxa olish</button>
                  <template v-if="canManageEntry(entry)">
                    <button class="small-button" type="button" @click="openEditDialog(entry.id)">Tahrirlash</button>
                    <button class="small-button delete" type="button" @click="deleteEntry(entry)">O‘chirish</button>
                  </template>
                </div>
              </div>
            </article>
            <section v-if="visibleEntries.length === 0" class="empty-state">
              <h3>Bu yer hali jim.</h3>
              <p>Qidiruv so‘zingizga mos yozuv topilmadi yoki bu bo‘lim hali bo‘sh.</p>
              <button class="button button-secondary" type="button" @click="openAddDialog">Birinchi satrni saqlash</button>
            </section>
          </div>
        </section>

        <aside class="side-column" aria-label="Kutubxona haqida">
          <section class="side-card" aria-labelledby="stats-title">
            <h2 id="stats-title">Sizning sandiq</h2>
            <div class="stat-list">
              <div class="stat-row"><span class="stat-name">Jami yozuvlar</span><strong class="stat-value">{{ totalCount }}</strong></div>
              <div class="stat-row"><span class="stat-name">She’rlar</span><strong class="stat-value">{{ poemCount }}</strong></div>
              <div class="stat-row"><span class="stat-name">Sevimlilar</span><strong class="stat-value">{{ favoriteCount }}</strong></div>
            </div>
          </section>
          <section class="side-card memory-card" aria-labelledby="memory-title">
            <h2 id="memory-title">Kichik eslatma</h2>
            <span class="line" aria-hidden="true"></span>
            <p>{{ storageNote }}</p>
          </section>
        </aside>
      </div>
    </main>

    <footer>Bir satr ham ba’zan butun bir kunni o‘zgartiradi.</footer>
  </div>

  <dialog ref="entryDialog" id="entry-dialog" aria-labelledby="dialog-title" @close="clearFormSecrets">
    <div class="dialog-inner">
      <div class="dialog-heading">
        <div>
          <h2 id="dialog-title">{{ dialogTitle }}</h2>
          <p id="dialog-description">{{ dialogDescription }}</p>
        </div>
        <button class="close-button" type="button" aria-label="Oynani yopish" @click="closeEntryDialog">×</button>
      </div>
      <form novalidate @submit.prevent="saveEntry">
        <div class="form-grid">
          <fieldset class="field" style="border: 0; padding: 0; margin: 0;">
            <legend class="field-title">Yozuv turi</legend>
            <div class="type-options">
              <label class="type-option"><input v-model="form.type" type="radio" value="poem" /> She’r</label>
              <label class="type-option"><input v-model="form.type" type="radio" value="quote" /> Qalbdagi so‘zlar</label>
            </div>
          </fieldset>
          <div class="field">
            <label for="entry-text">Matn</label>
            <textarea id="entry-text" ref="entryTextField" v-model="form.text" required maxlength="3000" placeholder="Bu yerga she’r yoki gapni yozing…"></textarea>
          </div>
          <div class="field">
            <label for="entry-author">Muallif <span style="font-weight: 400; color: #776d65;">(ixtiyoriy)</span></label>
            <input id="entry-author" v-model="form.author" type="text" maxlength="100" placeholder="Masalan: Abdulla Oripov" />
          </div>
          <div class="field">
            <label for="entry-tags">Teglar <span style="font-weight: 400; color: #776d65;">(vergul bilan ajrating)</span></label>
            <input id="entry-tags" v-model="form.tags" type="text" maxlength="160" placeholder="muhabbat, sog‘inch, hayot" />
          </div>
          <label class="protect-option" for="entry-protected">
            <input id="entry-protected" v-model="form.protect" type="checkbox" />
            <span>Matnni maxfiy kod bilan himoyalash</span>
          </label>
          <div v-if="form.protect" class="protected-fields" id="protected-fields">
            <div class="field">
              <label for="entry-passphrase">Maxfiy kod</label>
              <input id="entry-passphrase" v-model="form.passphrase" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="Kamida 8 belgi" />
            </div>
            <div class="field">
              <label for="entry-passphrase-confirm">Kodni takrorlang</label>
              <input id="entry-passphrase-confirm" v-model="form.passphraseConfirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" />
            </div>
            <p class="field-hint">Matn, muallif va teglar shifrlanadi. Kod unutilsa, ularni tiklab bo‘lmaydi.</p>
          </div>
          <p class="form-error" aria-live="polite">{{ formError }}</p>
          <div class="form-actions">
            <button class="button button-secondary" type="button" @click="closeEntryDialog">Bekor qilish</button>
            <button class="button button-primary" type="submit" :disabled="isSaving">{{ isSaving ? 'Saqlanmoqda…' : 'Saqlash' }}</button>
          </div>
        </div>
      </form>
    </div>
  </dialog>

  <dialog ref="unlockDialog" id="unlock-dialog" aria-labelledby="unlock-dialog-title" @close="unlockForm.passphrase = ''">
    <div class="dialog-inner">
      <div class="dialog-heading">
        <div>
          <h2 id="unlock-dialog-title">Kodli yozuv</h2>
          <p>Matnni o‘qish uchun maxfiy kodni kiriting.</p>
        </div>
        <button class="close-button" type="button" aria-label="Oynani yopish" @click="closeUnlockDialog">×</button>
      </div>
      <form @submit.prevent="unlockEntry">
        <div class="form-grid">
          <div class="field">
            <label for="unlock-passphrase">Maxfiy kod</label>
            <input id="unlock-passphrase" ref="unlockPassphraseField" v-model="unlockForm.passphrase" type="password" required autocomplete="off" />
          </div>
          <p class="form-error" aria-live="polite">{{ unlockError }}</p>
          <div class="form-actions">
            <button class="button button-secondary" type="button" @click="closeUnlockDialog">Bekor qilish</button>
            <button class="button button-primary" type="submit" :disabled="isUnlocking">{{ isUnlocking ? 'Ochilyapti…' : 'Ochish' }}</button>
          </div>
        </div>
      </form>
    </div>
  </dialog>

  <dialog ref="logoDialog" id="logo-dialog" aria-labelledby="logo-dialog-title">
    <div class="dialog-inner">
      <div class="dialog-heading">
        <div>
          <h2 id="logo-dialog-title">Logotip tanlash</h2>
          <p>Quyidagi variantlardan birini tanlang.</p>
        </div>
        <button class="close-button" type="button" aria-label="Oynani yopish" @click="closeLogoDialog">×</button>
      </div>
      <div style="display: flex; gap: 12px; padding: 12px; justify-content: center;">
        <button class="logo-option" type="button" aria-label="Birinchi logotip" @click="chooseLogo('assets/logo1.svg')">
          <img src="/assets/logo1.svg" width="64" height="64" alt="Logo 1" />
        </button>
      </div>
    </div>
  </dialog>

  <div class="toast" :class="{ show: toastVisible }" role="status" aria-live="polite">{{ toastMessage }}</div>
</template>
