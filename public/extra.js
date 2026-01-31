/*
  CVL PWA - Extra features (no refactor):
  - Push subscribe UI + client logic
  - Dark mode toggle (localStorage)
  - Global search screen (actus + sondage + idees si admin)
  - Favorites (actus + idees) stored in localStorage

  Loaded AFTER the existing inline script in index.html.
*/

(() => {
  const LS_EXTRA = {
    DARK: "cvl_dark_mode",
    FAV_NEWS: "cvl_fav_news",
    FAV_IDEAS: "cvl_fav_ideas",
    PUSH_STATUS: "cvl_push_status"
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  function safeJsonParse(v, fallback) {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  function getSet(key) { return new Set(safeJsonParse(localStorage.getItem(key) || "[]", [])); }
  function saveSet(key, set) { localStorage.setItem(key, JSON.stringify(Array.from(set))); }

  async function isAdmin() {
    try { await window.api("/api/admin/me"); return true; }
    catch { return false; }
  }

  // ---------- dark mode ----------
  function injectDarkCss() {
    const css = `
      body.dark{
        --bg-primary:#0b1220;
        --bg-secondary:#050a14;
        --bg-tertiary:#0f1a2e;
        --text-primary:#e5e7eb;
        --text-secondary:#cbd5e1;
        --text-tertiary:#94a3b8;
        --border:#1f2a44;
      }
      body.dark .bottom-nav{ background:#0b1220; }
      body.dark .card{ box-shadow:none; }
      .cvl-row{display:flex;gap:.75rem;align-items:center;justify-content:space-between;flex-wrap:wrap}
      .toggle{display:inline-flex;align-items:center;gap:.5rem}
      .toggle input{width:44px;height:24px;accent-color: var(--primary);}
      .mini-note{font-size:.85rem;color:var(--text-secondary)}
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  function applyDarkModeFromStorage() {
    const enabled = localStorage.getItem(LS_EXTRA.DARK) === "1";
    document.body.classList.toggle("dark", enabled);
  }
  function setDarkMode(enabled) {
    localStorage.setItem(LS_EXTRA.DARK, enabled ? "1" : "0");
    applyDarkModeFromStorage();
  }

  // ---------- favorites ----------
  function injectFavCss() {
    const css = `
      .fav-btn{border:1px solid var(--border);background:var(--bg-secondary);border-radius:10px;padding:.35rem .55rem;cursor:pointer}
      .fav-btn.on{background:#fef3c7;border-color:#f59e0b}
      .fav-row{display:flex;gap:.5rem;align-items:center;justify-content:space-between}
      .fav-label{font-size:.8rem;color:var(--text-tertiary);font-weight:700;text-transform:uppercase;letter-spacing:.06em}
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  function toggleFav(setKey, id) {
    const s = getSet(setKey);
    if (s.has(String(id))) s.delete(String(id));
    else s.add(String(id));
    saveSet(setKey, s);
    return s.has(String(id));
  }

  // Override renderNews (adds ⭐)
  function patchNewsFavorites() {
    if (typeof window.renderNews !== "function") return;

    window.renderNews = function(items, homeOnly) {
      const fav = getSet(LS_EXTRA.FAV_NEWS);
      const listEl = homeOnly ? document.getElementById("home-news") : document.getElementById("news-list");

      if (!items || !items.length) {
        listEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📰</div>
            <div class="empty-state-text">Aucune actualité</div>
          </div>`;
        return;
      }

      const html = items.map(n => {
        const isOn = fav.has(String(n.id));
        return `
          <div class="card">
            <div class="news-item">
              <div class="fav-row">
                <div class="news-date">${window.escapeHtml(new Date(n.created_at).toLocaleDateString("fr-FR"))}</div>
                <button class="fav-btn ${isOn ? "on" : ""}" data-fav-news="${n.id}" title="Favori">⭐</button>
              </div>
              <div class="news-title">${window.escapeHtml(n.title)}</div>
              <div class="news-content">${window.escapeHtml(n.description).replaceAll("\\n","<br>")}</div>
            </div>
          </div>
        `;
      }).join("");

      listEl.innerHTML = html;

      listEl.querySelectorAll("[data-fav-news]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = btn.getAttribute("data-fav-news");
          const on = toggleFav(LS_EXTRA.FAV_NEWS, id);
          btn.classList.toggle("on", on);
        });
      });
    };
  }

  // Override loadIdeas (admin list adds ⭐)
  function patchIdeaFavorites() {
    if (typeof window.loadIdeas !== "function") return;

    window.loadIdeas = async function() {
      try {
        const ideas = await window.api("/api/admin/ideas");
        const fav = getSet(LS_EXTRA.FAV_IDEAS);

        document.getElementById("ideas-count").textContent = `${ideas.length} idées`;
        if (!ideas.length) {
          document.getElementById("ideas-list").innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">💡</div>
              <div class="empty-state-text">Aucune idée reçue</div>
            </div>`;
          return;
        }

        document.getElementById("ideas-list").innerHTML = ideas.map(i => {
          const isOn = fav.has(String(i.id));
          return `
            <div class="idea-card">
              <div class="fav-row">
                <div class="idea-meta">
                  <span class="badge badge-primary">${window.escapeHtml(i.category_label)}</span>
                  <span class="badge ${i.urgency === "haute" ? "badge-danger" : (i.urgency === "moyenne" ? "badge-warning" : "badge-success")}">${window.escapeHtml(i.urgency)}</span>
                  <span class="badge badge-primary">${window.escapeHtml(i.status)}</span>
                </div>
                <button class="fav-btn ${isOn ? "on" : ""}" data-fav-idea="${i.id}" title="Favori">⭐</button>
              </div>
              <div class="idea-content">${window.escapeHtml(i.text).replaceAll("\\n","<br>")}</div>
              <div class="idea-date">${window.escapeHtml(new Date(i.created_at).toLocaleString("fr-FR"))}</div>
            </div>
          `;
        }).join("");

        document.getElementById("ideas-list").querySelectorAll("[data-fav-idea]").forEach(btn => {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.getAttribute("data-fav-idea");
            const on = toggleFav(LS_EXTRA.FAV_IDEAS, id);
            btn.classList.toggle("on", on);
          });
        });
      } catch (e) {
        document.getElementById("ideas-list").innerHTML = `<div class="alert alert-warning">${window.escapeHtml(e.message)}</div>`;
      }
    };
  }

  // ---------- global search ----------
  function injectSearchScreen() {
    const nav = document.querySelector(".bottom-nav");
    if (!nav) return;

    const navItem = document.createElement("div");
    navItem.className = "nav-item";
    navItem.setAttribute("onclick", "navigateTo('recherche')");
    navItem.innerHTML = `<div class="nav-icon">🔎</div><div class="nav-label">Recherche</div>`;
    nav.insertBefore(navItem, nav.lastElementChild); // before Contact

    const screen = document.createElement("div");
    screen.className = "screen";
    screen.id = "screen-recherche";
    screen.innerHTML = `
      <div class="container">
        <div class="card">
          <div class="card-header">🔎 Recherche globale</div>
          <div class="card-content">
            <div class="form-group">
              <label class="form-label">Rechercher dans actualités, sondage et idées (admin)</label>
              <input id="global-search-input" class="form-control" placeholder="Ex: cantine, sortie, club..." />
            </div>
            <div class="mini-note">Tape 3+ caractères.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">Résultats</div>
          <div class="card-content" id="global-search-results">
            <div class="empty-state">
              <div class="empty-state-icon">🔎</div>
              <div class="empty-state-text">Aucune recherche</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertBefore(screen, nav);
  }

  async function performGlobalSearch(q) {
    const out = $("#global-search-results");
    const query = (q || "").trim().toLowerCase();
    if (query.length < 3) {
      out.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⌨️</div>
          <div class="empty-state-text">Tape au moins 3 caractères</div>
        </div>`;
      return;
    }

    out.innerHTML = `<div class="alert alert-info">⏳ Recherche…</div>`;

    const [news, poll, admin] = await Promise.all([
      window.api("/api/public/news").catch(() => []),
      window.api("/api/public/poll").catch(() => ({ active: 0 })),
      isAdmin()
    ]);

    let ideas = [];
    if (admin) ideas = await window.api("/api/admin/ideas").catch(() => []);

    const newsHits = (news || []).filter(n =>
      String(n.title).toLowerCase().includes(query) ||
      String(n.description).toLowerCase().includes(query)
    );

    const pollHits = [];
    if (poll && poll.active) {
      const txt = [poll.question, ...(poll.options || [])].join(" ").toLowerCase();
      if (txt.includes(query)) pollHits.push(poll);
    }

    const ideaHits = (ideas || []).filter(i =>
      String(i.text).toLowerCase().includes(query) ||
      String(i.category_label || i.category).toLowerCase().includes(query) ||
      String(i.status).toLowerCase().includes(query)
    );

    if (!newsHits.length && !pollHits.length && !ideaHits.length) {
      out.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🙈</div>
          <div class="empty-state-text">Aucun résultat</div>
        </div>`;
      return;
    }

    const html = [];

    if (newsHits.length) {
      html.push(`<div class="fav-label">Actualités (${newsHits.length})</div>`);
      html.push(newsHits.slice(0, 20).map(n => `
        <div style="padding:.75rem 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:900;color:var(--primary)">${window.escapeHtml(n.title)}</div>
          <div style="color:var(--text-secondary);font-size:.9rem">${window.escapeHtml(n.description).slice(0, 160)}${n.description.length > 160 ? "…" : ""}</div>
        </div>
      `).join(""));
    }

    if (pollHits.length) {
      html.push(`<div style="margin-top:1rem" class="fav-label">Sondage</div>`);
      html.push(pollHits.map(p => `
        <div style="padding:.75rem 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:900;color:var(--primary)">${window.escapeHtml(p.question)}</div>
          <div style="color:var(--text-secondary);font-size:.9rem">Options : ${(p.options||[]).map(window.escapeHtml).join(" • ")}</div>
        </div>
      `).join(""));
    }

    if (ideaHits.length) {
      html.push(`<div style="margin-top:1rem" class="fav-label">Idées (admin) (${ideaHits.length})</div>`);
      html.push(ideaHits.slice(0, 20).map(i => `
        <div style="padding:.75rem 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:900;color:var(--primary)">${window.escapeHtml(i.category_label || i.category)} • ${window.escapeHtml(i.status)}</div>
          <div style="color:var(--text-secondary);font-size:.9rem">${window.escapeHtml(i.text).slice(0, 180)}${i.text.length > 180 ? "…" : ""}</div>
        </div>
      `).join(""));
    }

    out.innerHTML = html.join("");
  }

  function wireSearchInput() {
    const input = $("#global-search-input");
    if (!input) return;

    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => performGlobalSearch(input.value), 250);
    });
  }

  // ---------- push subscribe ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function subscribePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      alert("❌ Push non supporté sur cet appareil / navigateur.");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      alert("❌ Permission refusée. Active les notifications dans les réglages du navigateur.");
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await window.api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: existing }) });
      localStorage.setItem(LS_EXTRA.PUSH_STATUS, "on");
      updatePushStatusUi();
      alert("✅ Notifications déjà actives.");
      return;
    }

    const { publicKey } = await window.api("/api/push/public-key");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await window.api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) });

    localStorage.setItem(LS_EXTRA.PUSH_STATUS, "on");
    updatePushStatusUi();
    alert("✅ Notifications activées !");
  }

  async function unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (_) {}
    localStorage.setItem(LS_EXTRA.PUSH_STATUS, "off");
    updatePushStatusUi();
    alert("👋 Notifications désactivées sur cet appareil.");
  }

  function updatePushStatusUi() {
    const badge = $("#push-status-badge");
    if (!badge) return;
    const on = localStorage.getItem(LS_EXTRA.PUSH_STATUS) === "on";
    badge.textContent = on ? "Activées" : "Désactivées";
    badge.className = "badge " + (on ? "badge-success" : "badge-warning");
  }

  function injectPushAndSettingsCard() {
    const contact = document.getElementById("screen-contact");
    if (!contact) return;
    const container = contact.querySelector(".container");
    if (!container) return;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">⚙️ Préférences</div>
      <div class="card-content">
        <div class="cvl-row" style="margin-bottom:1rem">
          <div>
            <div style="font-weight:900">Dark mode</div>
            <div class="mini-note">Enregistré sur cet appareil</div>
          </div>
          <label class="toggle">
            <span>🌙</span>
            <input id="dark-toggle" type="checkbox" />
          </label>
        </div>

        <div class="cvl-row">
          <div>
            <div style="font-weight:900">Notifications</div>
            <div class="mini-note">Actualités • sondages • messages admin</div>
          </div>
          <div style="display:flex;gap:.5rem;align-items:center">
            <span id="push-status-badge" class="badge badge-warning">Désactivées</span>
            <button id="btn-push-on" class="btn btn-primary" style="padding:.55rem .8rem">Activer</button>
            <button id="btn-push-off" class="btn btn-secondary" style="padding:.55rem .8rem">Désactiver</button>
          </div>
        </div>
      </div>
    `;

    const adminCard = container.querySelector(".card:last-child");
    container.insertBefore(card, adminCard);

    const toggle = $("#dark-toggle", card);
    toggle.checked = localStorage.getItem(LS_EXTRA.DARK) === "1";
    toggle.addEventListener("change", () => setDarkMode(toggle.checked));

    $("#btn-push-on", card).addEventListener("click", () => subscribePush().catch(e => alert("❌ " + e.message)));
    $("#btn-push-off", card).addEventListener("click", () => unsubscribePush());

    (async () => {
      try {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        localStorage.setItem(LS_EXTRA.PUSH_STATUS, sub ? "on" : "off");
      } catch (_) {}
      updatePushStatusUi();
    })();
  }

  // ---------- admin push sender UI ----------
  function injectAdminPushCard() {
    const contact = document.getElementById("screen-contact");
    if (!contact) return;
    const container = contact.querySelector(".container");
    if (!container) return;

    const card = document.createElement("div");
    card.className = "card";
    card.style.display = "none";
    card.innerHTML = `
      <div class="card-header">🔔 Envoyer une notification</div>
      <div class="card-content">
        <div class="form-group">
          <label class="form-label">Titre</label>
          <input id="push-title" class="form-control" maxlength="60" placeholder="Ex: Rappel événement" />
        </div>
        <div class="form-group">
          <label class="form-label">Message</label>
          <textarea id="push-body" class="form-control" maxlength="180" rows="3" placeholder="Ex: RDV au foyer jeudi 12h30"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Lien (optionnel)</label>
          <input id="push-url" class="form-control" maxlength="300" placeholder="/#accueil" />
        </div>
        <button id="push-send-btn" class="btn btn-primary btn-block">Envoyer</button>
        <div id="push-send-result" style="margin-top:.75rem"></div>
      </div>
    `;

    container.appendChild(card);

    (async () => {
      const admin = await isAdmin();
      card.style.display = admin ? "block" : "none";
    })();

    $("#push-send-btn", card).addEventListener("click", async () => {
      const title = $("#push-title", card).value.trim() || "Message CVL";
      const body = $("#push-body", card).value.trim();
      const url = ($("#push-url", card).value.trim() || "/");
      const out = $("#push-send-result", card);

      if (!body) {
        out.innerHTML = `<div class="alert alert-warning">❌ Message requis</div>`;
        return;
      }

      out.innerHTML = `<div class="alert alert-info">⏳ Envoi…</div>`;
      try {
        const r = await window.api("/api/push/send", {
          method: "POST",
          body: JSON.stringify({ title, body, url, tag: "admin" })
        });
        out.innerHTML = `<div class="alert alert-success">✅ Envoyé : ${r.sent} • échecs : ${r.failed}</div>`;
      } catch (e) {
        out.innerHTML = `<div class="alert alert-warning">❌ ${window.escapeHtml(e.message)}</div>`;
      }
    });
  }

  // ---------- init ----------
  function init() {
    injectDarkCss();
    injectFavCss();
    applyDarkModeFromStorage();

    injectSearchScreen();
    injectPushAndSettingsCard();
    injectAdminPushCard();

    patchNewsFavorites();
    patchIdeaFavorites();

    setTimeout(wireSearchInput, 0);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
