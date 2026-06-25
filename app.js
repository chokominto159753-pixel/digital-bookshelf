import {
  auth, db, isFirebaseValid, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy
} from "./firebase.js";

// === アプリケーションステート ===
let currentUser = null;
let sentences = [];
let categories = [];
let settings = {
  fontSize: 'medium',
  dedupeEnabled: false,
  suggestionEnabled: true,
  theme: 'pastel-blue',
  animation: true
};

// 小説作成用（ドラフトバッファ、 transitionTextを内包可能）
let novelDraftSentences = [];

// 選択状態・一時状態
let activeCategory = 'all';
let searchQuery = '';
let currentSort = 'newest'; // newest | oldest | random
let currentView = 'view-notebook';
let selectedKeywordsForNewCategory = new Set();
let unfavoriteTargetId = null;
let deleteTargetId = null;

// === 初期カテゴリ辞書定義 ===
const DEFAULT_CATEGORIES = [
  { id: 'cat_joy', name: '喜び', keywords: ['喜び', '嬉しい', '笑う', '幸福', '希望', '咲く'] },
  { id: 'cat_sadness', name: '悲しみ', keywords: ['悲しみ', '涙', '憂鬱', '泣く', '崩れる', '去る'] },
  { id: 'cat_anger', name: '怒り', keywords: ['怒り', '憎しみ', '苛立ち', '叫ぶ', '殴る', '不条理'] },
  { id: 'cat_love', name: '恋愛', keywords: ['恋愛', '愛する', '恋', '想う', '告白', '二人'] },
  { id: 'cat_solitude', name: '孤独', keywords: ['孤独', '孤高', '寂しい', '一人', '隔離', '静か'] },
  { id: 'cat_morning', name: '朝', keywords: ['朝', '夜明け', '日の出', '早朝', '光'] },
  { id: 'cat_noon', name: '昼', keywords: ['昼', '正午', '日中', '太陽', '午後'] },
  { id: 'cat_night', name: '夜', keywords: ['夜', '月', '星', '闇', '静寂', '真夜中'] },
  { id: 'cat_dream', name: '夢', keywords: ['夢', '幻影', '睡眠', '幻', 'うたた寝'] },
  { id: 'cat_walk', name: '歩く', keywords: ['歩く', '散歩', '旅', '歩行', '足跡', '進む'] },
  { id: 'cat_season', name: '季節', keywords: ['季節', '春', '夏', '秋', '冬', '四季', '風情'] },
  { id: 'cat_life', name: '人生', keywords: ['人生', '生きる', '運命', '生涯', '歳月', '死'] },
  { id: 'cat_philosophy', name: '哲学', keywords: ['哲学', '思索', '心理', '本質', '概念', '理由'] }
];

// === ライフサイクル ===
document.addEventListener("DOMContentLoaded", () => {
  initApp();
});

function initApp() {
  loadLocalSettings();
  loadNovelDraft(); // 小説作成データの復元
  setupEventListeners();
  applySettingsUI();
  
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      document.getElementById("btn-login").classList.add("hidden");
      document.getElementById("user-profile").classList.remove("hidden");
      document.getElementById("user-name").textContent = user.displayName || user.email;
      document.getElementById("guest-warning").classList.add("hidden");
      
      // 管理者ログイン：管理室メニューを解放
      const adminNav = document.getElementById("nav-admin");
      if (adminNav) adminNav.classList.remove("hidden");
      
      await loadUserData();
    } else {
      currentUser = null;
      document.getElementById("btn-login").classList.remove("hidden");
      document.getElementById("user-profile").classList.add("hidden");
      document.getElementById("guest-warning").classList.remove("hidden");
      
      // 一般閲覧者：管理室メニューを完全に隠す
      const adminNav = document.getElementById("nav-admin");
      if (adminNav) adminNav.classList.add("hidden");
      
      if (currentView === 'view-admin') {
        switchView('view-notebook');
      }
      
      loadGuestData();
    }
    renderApp();
  });
}

// === 設定処理 ===
function loadLocalSettings() {
  const local = localStorage.getItem("bookshelf_settings");
  if (local) {
    try {
      settings = { ...settings, ...JSON.parse(local) };
    } catch (e) {
      console.error(e);
    }
  }
}

function saveLocalSettings() {
  localStorage.setItem("bookshelf_settings", JSON.stringify(settings));
}

async function syncSettingsToFirebase() {
  if (isFirebaseValid && currentUser) {
    try {
      await setDoc(doc(db, "users", currentUser.uid, "settings", "global"), settings);
    } catch (e) {
      console.error(e);
    }
  }
}

function applySettingsUI() {
  const body = document.body;
  
  body.classList.remove("font-small", "font-medium", "font-large");
  body.classList.add(`font-${settings.fontSize}`);

  body.setAttribute("data-theme", settings.theme);

  // クイックテーマ切り替え
  const themeSvgIcon = document.getElementById("theme-svg-icon");
  if (themeSvgIcon) {
    if (settings.theme === 'dark') {
      themeSvgIcon.innerHTML = `
        <circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2"/>
      `;
    } else {
      themeSvgIcon.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" fill="none"/>
      `;
    }
  }

  if (settings.animation) {
    body.classList.remove("no-animation");
  } else {
    body.classList.add("no-animation");
  }

  syncSettingsToForm();
}

function syncSettingsToForm() {
  document.querySelectorAll("#control-font-size .segment-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.size === settings.fontSize);
  });
  document.querySelectorAll("#control-theme .segment-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === settings.theme);
  });
  
  const dedupeChk = document.getElementById("settings-dedupe");
  if (dedupeChk) dedupeChk.checked = settings.dedupeEnabled;
  
  const suggestChk = document.getElementById("settings-suggestion");
  if (suggestChk) suggestChk.checked = settings.suggestionEnabled;
  
  const animChk = document.getElementById("settings-animation");
  if (animChk) animChk.checked = settings.animation;
}

// === データのロード ===
async function loadUserData() {
  if (!isFirebaseValid) return;
  try {
    const settingsDoc = await getDoc(doc(db, "users", currentUser.uid, "settings", "global"));
    if (settingsDoc.exists()) {
      settings = { ...settings, ...settingsDoc.data() };
    }
    applySettingsUI();

    const catQuery = await getDocs(collection(db, "users", currentUser.uid, "categories"));
    if (catQuery.empty) {
      categories = [...DEFAULT_CATEGORIES];
      for (const cat of categories) {
        await setDoc(doc(db, "users", currentUser.uid, "categories", cat.id), cat);
      }
    } else {
      categories = catQuery.docs.map(doc => doc.data());
    }

    const sentenceQuery = await getDocs(collection(db, "users", currentUser.uid, "sentences"));
    sentences = sentenceQuery.docs.map(doc => doc.data());

    showToast("同期が完了しました");
  } catch (error) {
    console.error("ロードエラー:", error);
    showToast("同期に失敗しました");
  }
}

function loadGuestData() {
  categories = [...DEFAULT_CATEGORIES];
  sentences = [
    {
      id: "sample_1",
      text: "吾輩は猫である。名前はまだ無い。",
      source: "夏目漱石『吾輩は猫である』",
      categories: ["人生", "孤独"],
      favorite: false,
      shared: false,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
      userId: "admin"
    },
    {
      id: "sample_2",
      text: "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。",
      source: "太宰治『走れメロス』",
      categories: ["怒り", "人生"],
      favorite: false,
      shared: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: "admin"
    }
  ];
}

// === 小説作成ローカル保存 ===
function saveNovelDraft() {
  localStorage.setItem("bookshelf_novel_draft", JSON.stringify(novelDraftSentences));
}

function loadNovelDraft() {
  const local = localStorage.getItem("bookshelf_novel_draft");
  if (local) {
    try {
      novelDraftSentences = JSON.parse(local);
    } catch (e) {
      console.error(e);
    }
  }
}

// === 表示描画 ===
function renderApp() {
  renderCategoryChips();
  renderSentenceList();
  renderCategorySettings();
  renderFavoritesList();
  renderNovelWorkspace();
}

function renderCategoryChips() {
  const container = document.getElementById("category-chips");
  if (!container) return;
  container.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.className = `chip ${activeCategory === 'all' ? 'active' : ''}`;
  allChip.textContent = "全て";
  allChip.addEventListener("click", () => {
    activeCategory = 'all';
    renderCategoryChips();
    renderSentenceList();
  });
  container.appendChild(allChip);

  categories.forEach(cat => {
    const chip = document.createElement("button");
    chip.className = `chip ${activeCategory === cat.name ? 'active' : ''}`;
    chip.textContent = cat.name;
    chip.addEventListener("click", () => {
      activeCategory = cat.name;
      renderCategoryChips();
      renderSentenceList();
    });
    container.appendChild(chip);
  });
}

function renderSentenceList() {
  const container = document.getElementById("sentence-list");
  if (!container) return;
  container.innerHTML = "";

  let filtered = sentences.filter(s => {
    if (activeCategory !== 'all' && !s.categories.includes(activeCategory)) return false;
    
    if (searchQuery) {
      const normText = normalizeText(s.text);
      const normSource = normalizeText(s.source || '');
      const normQuery = normalizeText(searchQuery);
      const categoryMatch = s.categories.some(c => normalizeText(c).includes(normQuery));
      return normText.includes(normQuery) || normSource.includes(normQuery) || categoryMatch;
    }
    return true;
  });

  if (settings.dedupeEnabled) {
    filtered = processDeduplication(filtered);
  }

  filtered = sortSentences(filtered, currentSort);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24">
          <path d="M12 21c-1.17-1.34-3.53-2-6-2H3V5h3c2.03 0 4.2 1.34 6 3 1.8-1.66 3.97-3 6-3h3v14h-3c-2.47 0-4.83.66-6 2zM12 8v11"/>
        </svg>
        <p>文章はまだありません</p>
      </div>
    `;
    return;
  }

  filtered.forEach(item => {
    const card = document.createElement("div");
    card.className = "sentence-card";
    card.dataset.id = item.id;

    const textHTML = highlightText(item.text, searchQuery);
    const sourceHTML = highlightText(item.source || "出典不明", searchQuery);
    const dupBadge = (item.count && item.count > 1) ? `<span class="duplicate-badge">重複 ${item.count}件</span>` : '';
    
    const isAdmin = currentUser !== null;

    // 閲覧者アクション：お気に入り★ ＆ 小説追加（共有、コピー、その他は完全に削除されています）
    card.innerHTML = `
      <div class="sentence-text">${textHTML}</div>
      <div class="sentence-meta">
        <div class="sentence-source">${sourceHTML} ${dupBadge}</div>
        <div class="card-chips">
          ${item.categories.map(c => `<span class="card-chip">${c}</span>`).join('')}
        </div>
        <div class="sentence-actions">
          <svg class="icon-star-btn ${item.favorite ? 'active' : ''}" data-id="${item.id}" viewBox="0 0 24 24">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          <button class="btn btn-outline btn-add-to-novel" data-id="${item.id}" style="padding:4px 10px; font-size:0.75rem;">小説に追加</button>
          
          <!-- 管理者（あなた）ログイン時のみ削除が可能 -->
          ${isAdmin ? `
            <button class="btn btn-text btn-delete-sentence" data-id="${item.id}" style="color:var(--danger-color)">削除</button>
          ` : ''}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function renderFavoritesList() {
  const container = document.getElementById("favorite-list");
  if (!container) return;
  container.innerHTML = "";

  const favs = sortSentences(sentences.filter(s => s.favorite), currentSort);

  if (favs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
        </svg>
        <p>お気に入りの文章はまだありません</p>
      </div>
    `;
    return;
  }

  favs.forEach(item => {
    const card = document.createElement("div");
    card.className = "sentence-card";
    card.innerHTML = `
      <div class="sentence-text">${item.text}</div>
      <div class="sentence-meta">
        <div class="sentence-source">${item.source || "出典不明"}</div>
        <div class="card-chips">
          ${item.categories.map(c => `<span class="card-chip">${c}</span>`).join('')}
        </div>
        <div class="sentence-actions">
          <svg class="icon-star-btn active" data-id="${item.id}" viewBox="0 0 24 24">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          <button class="btn btn-outline btn-add-to-novel" data-id="${item.id}" style="padding:4px 10px; font-size:0.75rem;">小説に追加</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// === 小説作成室：つなぎ言葉結合機能付きドラフトワークスペース ===
function renderNovelWorkspace() {
  const listContainer = document.getElementById("novel-sentence-list");
  if (!listContainer) return;
  listContainer.innerHTML = "";

  if (novelDraftSentences.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24">
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        <p>小説用の文がまだありません。<br>「書棚」ページでお気に入りの一文を「小説に追加」してください。</p>
      </div>
    `;
    const previewArea = document.getElementById("novel-preview-textarea");
    if (previewArea) previewArea.value = "";
    return;
  }

  novelDraftSentences.forEach((item, index) => {
    const block = document.createElement("div");
    block.className = "novel-sentence-block";

    if (item.transitionText === undefined) item.transitionText = "";

    block.innerHTML = `
      <div class="novel-sentence-item">
        <div class="novel-sentence-content">${item.text}</div>
        <div class="novel-sentence-controls">
          <svg class="btn-control-svg btn-move-up" data-index="${index}" viewBox="0 0 24 24">
            <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
          </svg>
          <svg class="btn-control-svg btn-move-down" data-index="${index}" viewBox="0 0 24 24">
            <path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/>
          </svg>
          <svg class="btn-control-svg btn-remove-novel" data-index="${index}" viewBox="0 0 24 24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </div>
      </div>
      <!-- 次の文へのつなぎ言葉（自由編集） -->
      <div class="novel-transition-box">
        <input type="text" class="input-transition" data-index="${index}" placeholder="（次の文へのつなぎの言葉や自作の一文を入力...）" value="${item.transitionText}">
      </div>
    `;
    listContainer.appendChild(block);
  });

  updateNovelPreview();
}

// プレビューテキストの自動構築
function updateNovelPreview() {
  let fullStory = "";
  novelDraftSentences.forEach(item => {
    fullStory += item.text;
    if (item.transitionText && item.transitionText.trim() !== "") {
      fullStory += "\n" + item.transitionText.trim();
    }
    fullStory += "\n\n";
  });
  
  const previewArea = document.getElementById("novel-preview-textarea");
  if (previewArea) previewArea.value = fullStory.trim();
}

function renderCategorySettings() {
  const container = document.getElementById("category-dictionary-list");
  if (!container) return;
  container.innerHTML = "";

  categories.forEach(cat => {
    const card = document.createElement("div");
    card.className = "dictionary-card";
    card.innerHTML = `
      <div class="dictionary-header">
        <span class="dictionary-title">${cat.name}</span>
        ${currentUser ? `
          <button class="btn btn-text btn-delete-category" data-id="${cat.id}">削除</button>
        ` : ''}
      </div>
      <div class="dictionary-keywords">
        <strong>キーワード:</strong> ${cat.keywords.join(", ")}
      </div>
    `;
    container.appendChild(card);
  });
}

// === ビューのトグルスイッチ ===
function switchView(target) {
  currentView = target;
  
  document.querySelectorAll(".bottom-nav .nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.target === target);
  });

  document.querySelectorAll(".view-section").forEach(sec => sec.classList.add("hidden"));
  const targetSec = document.getElementById(target);
  if (targetSec) targetSec.classList.remove("hidden");

  const searchFilterArea = document.getElementById("search-filter-area");
  if (searchFilterArea) {
    if (target === 'view-notebook') {
      searchFilterArea.classList.remove("hidden");
    } else {
      searchFilterArea.classList.add("hidden");
    }
  }

  renderApp();
}

// === 並び替え ===
function sortSentences(array, sortBy) {
  const result = [...array];
  if (sortBy === 'newest') {
    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortBy === 'oldest') {
    result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (sortBy === 'random') {
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
  }
  return result;
}

// === 基本ヘルパー ===
function normalizeText(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u3041-\u3096]/g, m => String.fromCharCode(m.charCodeAt(0) + 0x60));
}

function highlightText(text, queryStr) {
  if (!queryStr || !text) return text;
  
  const normText = normalizeText(text);
  const normQuery = normalizeText(queryStr);
  
  let result = "";
  let currentIndex = 0;
  
  while (true) {
    const matchIndex = normText.indexOf(normQuery, currentIndex);
    if (matchIndex === -1) {
      result += text.slice(currentIndex);
      break;
    }
    result += text.slice(currentIndex, matchIndex);
    const originalMatch = text.slice(matchIndex, matchIndex + queryStr.length);
    result += `<mark>${originalMatch}</mark>`;
    currentIndex = matchIndex + queryStr.length;
  }
  return result;
}

function splitIntoSentences(text, splitComma = false) {
  const result = [];
  let current = "";
  let insideQuote = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '「' || char === '『') insideQuote++;
    else if (char === '」' || char === '』') insideQuote = Math.max(0, insideQuote - 1);

    current += char;

    const isDelimiter = ['。', '！', '？', '\n'].includes(char) || (splitComma && char === '、');
    
    if (isDelimiter && insideQuote === 0) {
      const clean = current.trim();
      if (clean) result.push(clean);
      current = "";
    }
  }
  
  const clean = current.trim();
  if (clean) result.push(clean);
  
  return result;
}

function processDeduplication(list) {
  const map = new Map();
  list.forEach(item => {
    const key = item.text.trim();
    if (!map.has(key)) {
      map.set(key, { ...item, count: 1 });
    } else {
      const existing = map.get(key);
      const mergedCats = Array.from(new Set([...existing.categories, ...item.categories]));
      const latestDate = new Date(existing.updatedAt) > new Date(item.updatedAt) ? existing.updatedAt : item.updatedAt;
      
      map.set(key, {
        ...existing,
        categories: mergedCats,
        updatedAt: latestDate,
        favorite: existing.favorite || item.favorite,
        count: existing.count + 1
      });
    }
  });
  return Array.from(map.values());
}

function autoCategorize(text) {
  const matched = [];
  const normalizedText = normalizeText(text);

  categories.forEach(cat => {
    const isMatched = cat.keywords.some(kw => {
      const normalizedKw = normalizeText(kw);
      return normalizedKw && normalizedText.includes(normalizedKw);
    });
    if (isMatched) {
      matched.push(cat.name);
    }
  });
  return matched;
}

function cleanAozoraText(htmlText) {
  let docParser = new DOMParser();
  let docHtml = docParser.parseFromString(htmlText, 'text/html');
  let rawText = docHtml.body.textContent || docHtml.body.innerText || "";
  
  rawText = rawText.replace(/《[^》]+》/g, "");
  rawText = rawText.replace(/［＃[^］]+］/g, "");
  rawText = rawText.replace(/｜/g, "");
  
  return rawText;
}

function extractPotentialKeywords() {
  const words = new Set();
  const textPool = sentences.map(s => s.text).join(" ");
  
  const kanjiRegex = /[\u4e00-\u9faf]{2,8}/g;
  const katakanaRegex = /[\u30a1-\u30fc]{2,8}/g;
  
  let match;
  while ((match = kanjiRegex.exec(textPool)) !== null) {
    words.add(match[0]);
  }
  while ((match = katakanaRegex.exec(textPool)) !== null) {
    words.add(match[0]);
  }
  
  return Array.from(words).slice(0, 45);
}

// === イベントリスナー ===
function setupEventListeners() {
  
  // テーマ切り替えトグル (月/太陽)
  const themeToggle = document.getElementById("btn-theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      settings.theme = settings.theme === 'pastel-blue' ? 'dark' : 'pastel-blue';
      saveLocalSettings();
      syncSettingsToFirebase();
      applySettingsUI();
      renderApp();
    });
  }

  // 認証
  const btnLogin = document.getElementById("btn-login");
  if (btnLogin) {
    btnLogin.addEventListener("click", async () => {
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        console.error(e);
        showToast("ログインに失敗しました");
      }
    });
  }

  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await signOut(auth);
        showToast("ログアウトしました");
      } catch (e) {
        console.error(e);
      }
    });
  }

  // SPA ビュー
  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const target = btn.dataset.target;
      if (target) switchView(target);
    });
  });

  // ソート
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      currentSort = e.target.value;
      renderApp();
    });
  }

  // 手動登録 (管理者)
  const formRegister = document.getElementById("form-register-sentence");
  if (formRegister) {
    formRegister.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isFirebaseValid || !currentUser) {
        showToast("管理者ログインが必要です");
        return;
      }
      
      const textInput = document.getElementById("input-text").value;
      const sourceInput = document.getElementById("input-source").value;
      const splitComma = document.getElementById("chk-split-comma").checked;

      const parts = splitIntoSentences(textInput, splitComma);
      let addedCount = 0;

      for (const part of parts) {
        const autoCats = autoCategorize(part);
        const newSentence = {
          id: doc(collection(db, "temp")).id,
          text: part,
          source: sourceInput || "",
          categories: autoCats,
          favorite: false,
          shared: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: currentUser.uid
        };

        await setDoc(doc(db, "users", currentUser.uid, "sentences", newSentence.id), newSentence);
        sentences.push(newSentence);
        addedCount++;
      }

      formRegister.reset();
      showToast(`${addedCount}件の一文を登録しました`);
      renderApp();
    });
  }

  // 青空文庫 (管理者)
  const formAozora = document.getElementById("form-aozora-import");
  if (formAozora) {
    formAozora.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isFirebaseValid || !currentUser) {
        showToast("管理者ログインが必要です");
        return;
      }

      const url = document.getElementById("input-aozora-url").value;
      showToast("データ取得中...");
      
      try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error("ネットワークエラー");
        
        const arrayBuffer = await response.arrayBuffer();
        const decoder = new TextDecoder("shift-jis");
        const htmlText = decoder.decode(arrayBuffer);
        
        const cleaned = cleanAozoraText(htmlText);
        const parts = splitIntoSentences(cleaned, false);
        const limitedParts = parts.slice(0, 50);
        let addedCount = 0;

        for (const part of limitedParts) {
          if (part.length < 5) continue;
          const autoCats = autoCategorize(part);
          const newSentence = {
            id: doc(collection(db, "temp")).id,
            text: part,
            source: "青空文庫インポート",
            categories: autoCats,
            favorite: false,
            shared: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            userId: currentUser.uid
          };

          await setDoc(doc(db, "users", currentUser.uid, "sentences", newSentence.id), newSentence);
          sentences.push(newSentence);
          addedCount++;
        }

        formAozora.reset();
        showToast(`青空文庫から ${addedCount}件を登録しました`);
        renderApp();
      } catch (err) {
        console.error(err);
        showToast("インポートに失敗しました");
      }
    });
  }

  // 検索システム
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("btn-clear-search");

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      if (searchQuery) {
        if (clearSearchBtn) clearSearchBtn.classList.remove("hidden");
      } else {
        if (clearSearchBtn) clearSearchBtn.classList.add("hidden");
      }
      renderSentenceList();
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const firstResult = document.querySelector(".sentence-card");
        if (firstResult) {
          firstResult.scrollIntoView({ behavior: "smooth", block: "center" });
          firstResult.style.borderColor = "var(--text-color)";
          setTimeout(() => {
            firstResult.style.borderColor = "var(--border-color)";
          }, 1500);
        }
      }
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      searchQuery = "";
      clearSearchBtn.classList.add("hidden");
      renderSentenceList();
    });
  }

  // 委譲アクション（動的要素：お気に入り、小説追加、削除）
  document.addEventListener("click", async (e) => {
    // 星ボタン (お気に入り)
    const starBtn = e.target.closest(".icon-star-btn");
    if (starBtn) {
      e.preventDefault();
      const id = starBtn.dataset.id;
      const target = sentences.find(s => s.id === id);
      if (!target) return;

      if (target.favorite) {
        unfavoriteTargetId = id;
        const unfavModal = document.getElementById("modal-confirm-unfavorite");
        if (unfavModal) unfavModal.classList.remove("hidden");
      } else {
        target.favorite = true;
        starBtn.classList.add("active", "animate");
        
        if (isFirebaseValid && currentUser) {
          await updateDoc(doc(db, "users", currentUser.uid, "sentences", id), { favorite: true });
        }
        showToast("お気に入りに追加しました");
        
        setTimeout(() => {
          starBtn.classList.remove("animate");
          renderApp();
        }, 600);
      }
      return;
    }

    // 小説追加
    const addToNovelBtn = e.target.closest(".btn-add-to-novel");
    if (addToNovelBtn) {
      const id = addToNovelBtn.dataset.id;
      const target = sentences.find(s => s.id === id);
      if (target) {
        const isAlreadyAdded = novelDraftSentences.some(s => s.text === target.text);
        if (isAlreadyAdded) {
          showToast("この一文はすでに登録されています");
          return;
        }

        // transitionText プロパティを付与してバッファへ追加
        novelDraftSentences.push({ id: target.id, text: target.text, transitionText: "" });
        saveNovelDraft();
        showToast("小説作成室に一文を送信しました");
      }
      return;
    }

    // 小説：上へ移動
    const moveUpBtn = e.target.closest(".btn-move-up");
    if (moveUpBtn) {
      const idx = parseInt(moveUpBtn.dataset.index);
      if (idx > 0) {
        const temp = novelDraftSentences[idx];
        novelDraftSentences[idx] = novelDraftSentences[idx - 1];
        novelDraftSentences[idx - 1] = temp;
        saveNovelDraft();
        renderNovelWorkspace();
      }
      return;
    }

    // 小説：下へ移動
    const moveDownBtn = e.target.closest(".btn-move-down");
    if (moveDownBtn) {
      const idx = parseInt(moveDownBtn.dataset.index);
      if (idx < novelDraftSentences.length - 1) {
        const temp = novelDraftSentences[idx];
        novelDraftSentences[idx] = novelDraftSentences[idx + 1];
        novelDraftSentences[idx + 1] = temp;
        saveNovelDraft();
        renderNovelWorkspace();
      }
      return;
    }

    // 小説：一文を外す
    const removeNovelBtn = e.target.closest(".btn-remove-novel");
    if (removeNovelBtn) {
      const idx = parseInt(removeNovelBtn.dataset.index);
      novelDraftSentences.splice(idx, 1);
      saveNovelDraft();
      renderNovelWorkspace();
      showToast("小説から一文を削除しました");
      return;
    }

    // 一文削除
    const deleteSentenceBtn = e.target.closest(".btn-delete-sentence");
    if (deleteSentenceBtn) {
      deleteTargetId = deleteSentenceBtn.dataset.id;
      const delModal = document.getElementById("modal-confirm-delete");
      if (delModal) delModal.classList.remove("hidden");
      return;
    }

    // カテゴリ削除
    const deleteCatBtn = e.target.closest(".btn-delete-category");
    if (deleteCatBtn) {
      const id = deleteCatBtn.dataset.id;
      if (isFirebaseValid && currentUser) {
        try {
          await deleteDoc(doc(db, "users", currentUser.uid, "categories", id));
          categories = categories.filter(c => c.id !== id);
          showToast("カテゴリを削除しました");
          renderApp();
        } catch (err) {
          console.error(err);
        }
      }
    }
  });

  // 小説：つなぎ言葉入力の動的ハンドリング
  document.addEventListener("input", (e) => {
    const transitionInput = e.target.closest(".input-transition");
    if (transitionInput) {
      const idx = parseInt(transitionInput.dataset.index);
      novelDraftSentences[idx].transitionText = transitionInput.value;
      saveNovelDraft();
      updateNovelPreview();
    }
  });

  // 小説コピー
  const btnCopyNovel = document.getElementById("btn-copy-novel");
  if (btnCopyNovel) {
    btnCopyNovel.addEventListener("click", () => {
      const previewArea = document.getElementById("novel-preview-textarea");
      if (!previewArea) return;
      
      const text = previewArea.value;
      if (!text) {
        showToast("原稿がありません");
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        showToast("原稿をクリップボードにコピーしました");
      }).catch(err => {
        console.error(err);
        showToast("コピーに失敗しました");
      });
    });
  }

  // 小説全クリア
  const btnClearNovel = document.getElementById("btn-clear-novel");
  if (btnClearNovel) {
    btnClearNovel.addEventListener("click", () => {
      if (novelDraftSentences.length > 0 && confirm("執筆中の原稿をすべてクリアしますか？")) {
        novelDraftSentences = [];
        saveNovelDraft();
        renderNovelWorkspace();
        showToast("原稿をクリアしました");
      }
    });
  }

  // お気に入り解除モーダル
  const btnCancelUnfav = document.getElementById("btn-cancel-unfavorite");
  if (btnCancelUnfav) {
    btnCancelUnfav.addEventListener("click", () => {
      const unfavModal = document.getElementById("modal-confirm-unfavorite");
      if (unfavModal) unfavModal.classList.add("hidden");
      unfavoriteTargetId = null;
    });
  }

  const btnConfirmUnfav = document.getElementById("btn-confirm-unfavorite");
  if (btnConfirmUnfav) {
    btnConfirmUnfav.addEventListener("click", async () => {
      if (unfavoriteTargetId) {
        const target = sentences.find(s => s.id === unfavoriteTargetId);
        if (target) {
          target.favorite = false;
          if (isFirebaseValid && currentUser) {
            await updateDoc(doc(db, "users", currentUser.uid, "sentences", unfavoriteTargetId), { favorite: false });
          }
          showToast("お気に入りを解除しました");
        }
        const unfavModal = document.getElementById("modal-confirm-unfavorite");
        if (unfavModal) unfavModal.classList.add("hidden");
        unfavoriteTargetId = null;
        renderApp();
      }
    });
  }

  // 一文削除確認モーダル
  const btnCancelDelete = document.getElementById("btn-cancel-delete");
  if (btnCancelDelete) {
    btnCancelDelete.addEventListener("click", () => {
      document.getElementById("modal-confirm-delete").classList.add("hidden");
      deleteTargetId = null;
    });
  }

  const btnConfirmDel = document.getElementById("btn-confirm-delete");
  if (btnConfirmDel) {
    btnConfirmDel.addEventListener("click", async () => {
      if (deleteTargetId) {
        const id = deleteTargetId;
        sentences = sentences.filter(s => s.id !== id);

        if (isFirebaseValid && currentUser) {
          try {
            await deleteDoc(doc(db, "users", currentUser.uid, "sentences", id));
          } catch (err) {
            console.error(err);
          }
        }
        
        showToast("一文を削除しました");
        document.getElementById("modal-confirm-delete").classList.add("hidden");
        deleteTargetId = null;
        renderApp();
      }
    });
  }

  // カスタムカテゴリ登録
  const btnOpenAddCat = document.getElementById("btn-open-add-category");
  if (btnOpenAddCat) {
    btnOpenAddCat.addEventListener("click", () => {
      if (!isFirebaseValid || !currentUser) {
        showToast("カテゴリ追加には管理者ログインが必要です");
        return;
      }
      
      selectedKeywordsForNewCategory.clear();
      const suggestionsContainer = document.getElementById("learning-suggestions");
      if (!suggestionsContainer) return;
      suggestionsContainer.innerHTML = "";

      if (settings.suggestionEnabled) {
        const candidates = extractPotentialKeywords();
        if (candidates.length > 0) {
          candidates.forEach(word => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "suggestion-chip";
            chip.textContent = word;
            chip.addEventListener("click", () => {
              if (selectedKeywordsForNewCategory.has(word)) {
                selectedKeywordsForNewCategory.delete(word);
                chip.classList.remove("selected");
              } else {
                selectedKeywordsForNewCategory.add(word);
                chip.classList.add("selected");
              }
            });
            suggestionsContainer.appendChild(chip);
          });
        } else {
          suggestionsContainer.innerHTML = "<p style='font-size:0.8rem; color:var(--text-muted);'>候補がありません</p>";
        }
      } else {
        suggestionsContainer.innerHTML = "<p style='font-size:0.8rem; color:var(--text-muted);'>サジェスト設定がオフです</p>";
      }

      const addCatModal = document.getElementById("modal-add-category");
      if (addCatModal) addCatModal.classList.remove("hidden");
    });
  }

  const btnCloseCatModal = document.getElementById("btn-close-category-modal");
  if (btnCloseCatModal) {
    btnCloseCatModal.addEventListener("click", () => {
      const addCatModal = document.getElementById("modal-add-category");
      if (addCatModal) addCatModal.classList.add("hidden");
      const formAddCat = document.getElementById("form-add-category");
      if (formAddCat) formAddCat.reset();
    });
  }

  const formAddCategory = document.getElementById("form-add-category");
  if (formAddCategory) {
    formAddCategory.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isFirebaseValid || !currentUser) return;

      const name = document.getElementById("category-name").value.trim();
      const manualKeywords = document.getElementById("category-keywords").value
        .split(",")
        .map(k => k.trim())
        .filter(k => k !== "");

      const mergedKeywords = Array.from(new Set([...manualKeywords, ...selectedKeywordsForNewCategory]));
      const newCatId = "cat_" + Date.now();
      const newCat = {
        id: newCatId,
        name: name,
        keywords: mergedKeywords,
        userId: currentUser.uid
      };

      try {
        await setDoc(doc(db, "users", currentUser.uid, "categories", newCatId), newCat);
        categories.push(newCat);
        showToast(`カテゴリ「${name}」を追加しました`);
        
        const addCatModal = document.getElementById("modal-add-category");
        if (addCatModal) addCatModal.classList.add("hidden");
        formAddCategory.reset();
        renderApp();
      } catch (err) {
        console.error(err);
      }
    });
  }

  // 環境設定
  document.querySelectorAll("#control-font-size .segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      settings.fontSize = btn.dataset.size;
      saveLocalSettings();
      syncSettingsToFirebase();
      applySettingsUI();
    });
  });

  document.querySelectorAll("#control-theme .segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      settings.theme = btn.dataset.theme;
      saveLocalSettings();
      syncSettingsToFirebase();
      applySettingsUI();
      renderApp();
    });
  });

  const dedupeChk = document.getElementById("settings-dedupe");
  if (dedupeChk) {
    dedupeChk.addEventListener("change", (e) => {
      settings.dedupeEnabled = e.target.checked;
      saveLocalSettings();
      syncSettingsToFirebase();
      renderApp();
    });
  }

  const suggestChk = document.getElementById("settings-suggestion");
  if (suggestChk) {
    suggestChk.addEventListener("change", (e) => {
      settings.suggestionEnabled = e.target.checked;
      saveLocalSettings();
      syncSettingsToFirebase();
    });
  }

  const animChk = document.getElementById("settings-animation");
  if (animChk) {
    animChk.addEventListener("change", (e) => {
      settings.animation = e.target.checked;
      saveLocalSettings();
      syncSettingsToFirebase();
      applySettingsUI();
    });
  }
}

// === トースト ===
function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    toast.addEventListener("transitionend", () => {
      toast.remove();
    });
  }, 2500);
}
