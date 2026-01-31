const API_BASE = "";
const LS = { DEVICE_ID: "cvl_device_id" };

function getDeviceId() {
  let id = localStorage.getItem(LS.DEVICE_ID);
  if (!id) {
    id = (crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
    localStorage.setItem(LS.DEVICE_ID, id);
  }
  return id;
}

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": getDeviceId(),
      ...(opts.headers || {})
    },
    ...opts
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : await res.text().catch(() => "");
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Erreur (${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

function drawBar(canvas, labels, values) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  const pad = 28 * devicePixelRatio;
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const bw = (w - pad * 2) / n;

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000";
  ctx.fillRect(pad, h - pad, w - pad * 2, 1 * devicePixelRatio);
  ctx.globalAlpha = 1;

  for (let i = 0; i < n; i++) {
    const v = values[i];
    const bh = (h - pad * 2) * (v / max);
    const x = pad + i * bw + bw * 0.12;
    const y = (h - pad) - bh;
    const barW = bw * 0.76;

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, barW, bh);
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#000";
    ctx.globalAlpha = 0.7;
    ctx.font = `${12 * devicePixelRatio}px system-ui`;
    ctx.fillText(String(labels[i]).slice(0, 10), x, h - pad + 16 * devicePixelRatio);
    ctx.globalAlpha = 1;

    ctx.globalAlpha = 0.75;
    ctx.fillText(String(v), x, y - 6 * devicePixelRatio);
    ctx.globalAlpha = 1;
  }
}

function drawLine(canvas, labels, values) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;

  ctx.clearRect(0, 0, w, h);

  const pad = 28 * devicePixelRatio;
  const max = Math.max(1, ...values);
  const n = Math.max(2, values.length);

  const xAt = (i) => pad + (i * (w - pad * 2) / (n - 1));
  const yAt = (v) => (h - pad) - ((h - pad * 2) * (v / max));

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000";
  ctx.fillRect(pad, h - pad, w - pad * 2, 1 * devicePixelRatio);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = xAt(i);
    const y = yAt(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#000";
  ctx.font = `${12 * devicePixelRatio}px system-ui`;
  for (let i = 0; i < values.length; i++) {
    const x = xAt(i);
    const y = yAt(values[i]);
    ctx.beginPath();
    ctx.arc(x, y, 3.5 * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();

    if (i === 0 || i === values.length - 1 || i % 3 === 0) {
      ctx.globalAlpha = 0.7;
      ctx.fillText(labels[i].slice(5), x - 10 * devicePixelRatio, h - pad + 16 * devicePixelRatio);
      ctx.globalAlpha = 1;
    }
  }
}

async function main() {
  try {
    await api("/api/admin/me");
  } catch {
    document.getElementById("not-admin").style.display = "block";
    return;
  }

  document.getElementById("dash").style.display = "grid";

  const data = await api("/api/stats");

  const totalConn = (data.dailyConnections || []).reduce((a, r) => a + (r.count || 0), 0);

  document.getElementById("m-ideas").textContent = data.ideas?.total ?? 0;
  document.getElementById("m-votes").textContent = data.votes?.total ?? 0;
  document.getElementById("m-news").textContent = data.news?.total ?? 0;
  document.getElementById("m-conn").textContent = totalConn;

  const st = data.ideas?.byStatus || [];
  drawBar(
    document.getElementById("chart-ideas"),
    st.map(x => x.status),
    st.map(x => x.count)
  );

  const dc = data.dailyConnections || [];
  drawLine(
    document.getElementById("chart-conn"),
    dc.map(x => x.day),
    dc.map(x => x.count)
  );

  const polls = (data.polls || []).slice().reverse();
  drawBar(
    document.getElementById("chart-polls"),
    polls.map(p => `#${p.id}`),
    polls.map(p => p.votes || 0)
  );
}

addEventListener("resize", () => { main().catch(() => {}); });
main().catch((e) => alert("❌ " + e.message));
