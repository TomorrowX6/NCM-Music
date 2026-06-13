/* ============================================================
   NOISE//SYSTEM — 核心引擎
   Web Audio 图 + 生成式 Techno 合成器 + Canvas 可视化
   ============================================================ */
"use strict";

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const canvas = $("viz"), ctx = canvas.getContext("2d");
const audio = $("audio");
const els = {
  marquee: $("marquee-inner"), ghost: $("marquee-ghost"),
  trackIndex: $("track-index"), trackMeta: $("track-meta"),
  timeCur: $("time-cur"), timeDur: $("time-dur"),
  seek: $("seek"), seekFill: $("seek-fill"), seekHead: $("seek-head"),
  vol: $("vol"), volFill: $("vol-fill"), volNum: $("vol-num"),
  play: $("btn-play"), prev: $("btn-prev"), next: $("btn-next"),
  shuffle: $("btn-shuffle"), repeat: $("btn-repeat"),
  add: $("btn-add"), list: $("btn-list"), fileInput: $("file-input"),
  drawer: $("drawer"), queue: $("queue"), closeDrawer: $("btn-close-drawer"),
  dropzone: $("dropzone"), clock: $("clock"),
  engineState: $("engine-state"), lvlBar: $("lvl-bar"),
  vizBtn: $("viz-mode-btn"),
  cover: $("cover"), trackMeta2: $("track-meta2"), cloudState: $("cloud-state"),
  trackName: $("track-name"),
  lyrics: $("lyrics"), lyrCur: $("lyr-cur"),
  lyrNext: $("lyr-next"), lyrTrans: $("lyr-trans"),
  btnLyrics: $("btn-lyrics"),
  btnLike: $("btn-like"), btnSpeed: $("btn-speed"), btnQuality: $("btn-quality"),
  btnLibrary: $("btn-library"), panel: $("panel"), closePanel: $("btn-close-panel"),
  searchInput: $("search-input"), btnDoSearch: $("btn-do-search"),
  searchResults: $("search-results"), playlistList: $("playlist-list"),
  dailyList: $("daily-list"), accountBox: $("account-box"),
  userChip: $("user-chip"), userAvatar: $("user-avatar"), userName: $("user-name"),
  btnComments: $("btn-comments"),
  commentList: $("comment-list"), commentTitle: $("comment-title"),
  commentCompose: $("comment-compose"), commentInput: $("comment-input"),
  commentSend: $("comment-send"),
  btnSearch: $("btn-search"),
  searchOverlay: $("search-overlay"), searchClose: $("btn-close-search"),
  btnSettings: $("btn-settings"), settings: $("settings"), closeSettings: $("btn-close-settings"),
  setApi: $("set-api"), setPlaylist: $("set-playlist"), setQualitySeg: $("set-quality"),
  setDebug: $("set-debug"), setStatus: $("set-status"),
};

/* ---------- 网易云 API（本地 api-enhanced 服务）---------- */
/* 可在「设置」中修改，故为可变量 */
let API_BASE = localStorage.getItem("ncm-api") || "http://localhost:3000";
let DEFAULT_PLAYLIST_ID = +localStorage.getItem("ncm-default-playlist") || 5199214175;   // 未登录默认歌单

/* 控制台日志（在「设置」中开关）；带醒目前缀便于过滤 */
const LOG_STYLE = "background:#c8ff2e;color:#050505;padding:0 4px;font-weight:700";
function log(...a) { if (state.debug) console.log("%cNS", LOG_STYLE, ...a); }

/* 所有请求带时间戳防缓存；登录后自动附加 Cookie */
async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  let url = API_BASE + path + sep + "timestamp=" + Date.now();
  const ck = localStorage.getItem("ncm-cookie");
  if (ck) url += "&cookie=" + encodeURIComponent(ck);
  log("→", path);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const json = await res.json();
    log("←", path, "code:", json.code ?? "ok");
    return json;
  } catch (e) {
    log("✕", path, e.message);
    throw e;
  }
}

/* ---------- 状态 ---------- */
const state = {
  playing: false,
  current: 0,
  shuffle: false,
  repeat: "off",          // off | all | one
  volume: 0.8,
  vizMode: 0,
  playlistId: DEFAULT_PLAYLIST_ID,
  speedIdx: 0,
  qualityIdx: +localStorage.getItem("ncm-quality") || 0,
  debug: localStorage.getItem("ncm-debug") === "1",
};
const VIZ_MODES = ["RADIAL", "BARS", "SCOPE", "GRID"];
const SPEEDS = [[1, "×1.0"], [1.25, "×1.25"], [1.5, "×1.5"], [2, "×2.0"], [0.5, "×0.5"], [0.75, "×0.75"]];
/* 默认 Hi-Res；服务端按账号/版权自动回退到 lossless 等可用音质 */
const QUALITIES = [["hires", "HR"], ["lossless", "SQ"], ["exhigh", "EXH"], ["standard", "STD"]];
let likedIds = new Set();   // 红心歌曲 id 集合（登录后拉取）

/* 队列：第 0 首永远是内置合成 demo */
const tracks = [{
  type: "synth",
  name: "ACID REFLEX",
  meta: "∞ LIVE SYNTHESIS · 124 BPM",
  duration: Infinity,
}];

/* ---------- Web Audio 图 ---------- */
let ac = null, masterGain = null, analyser = null, mediaSource = null;
let freqData = null, waveData = null;

function ensureAudio() {
  if (ac) { if (ac.state === "suspended") ac.resume(); return; }
  ac = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ac.createGain();
  masterGain.gain.value = state.volume;
  analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;
  masterGain.connect(analyser);
  analyser.connect(ac.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  waveData = new Uint8Array(analyser.fftSize);
  mediaSource = ac.createMediaElementSource(audio);
  mediaSource.connect(masterGain);
  synth.init();
}

/* ============================================================
   生成式 TECHNO 合成引擎 — 124 BPM 步进音序器
   ============================================================ */
const synth = {
  bus: null, noiseBuf: null,
  timer: null, step: 0, nextTime: 0, startedAt: 0, pausedElapsed: 0,
  BPM: 124,
  get stepDur() { return 60 / this.BPM / 4; },   // 16 分音符

  /* A 小调 acid bassline（半音偏移，相对 A1=55Hz），-1 = 休止 */
  bassline: [0, -1, 0, 12, -1, 0, 3, -1, 0, -1, 7, -1, 5, -1, 3, 12],
  accents:  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 1],
  /* 和弦进行：Am — F — C — G，每 2 小节换 */
  chords: [[55, 65.41, 82.41], [43.65, 65.41, 87.31],
           [65.41, 82.41, 98.0], [49.0, 73.42, 98.0]],

  init() {
    this.bus = ac.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(masterGain);
    /* 预生成 2 秒白噪声 */
    const len = ac.sampleRate * 2;
    this.noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const ch = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  },

  start() {
    this.bus.gain.cancelScheduledValues(ac.currentTime);
    this.bus.gain.setTargetAtTime(1, ac.currentTime, 0.05);
    this.nextTime = ac.currentTime + 0.06;
    this.startedAt = ac.currentTime - this.pausedElapsed;
    this.timer = setInterval(() => this.schedule(), 25);
  },

  stop() {
    if (!this.timer) return;                 // 已停止时再调用不得覆盖 pausedElapsed
    clearInterval(this.timer); this.timer = null;
    this.bus.gain.setTargetAtTime(0, ac.currentTime, 0.04);
    this.pausedElapsed = ac.currentTime - this.startedAt;
  },

  reset() { this.step = 0; this.pausedElapsed = 0; },

  elapsed() {
    if (!ac) return 0;
    return this.timer ? ac.currentTime - this.startedAt : this.pausedElapsed;
  },

  /* 超前调度（lookahead scheduler） */
  schedule() {
    while (this.nextTime < ac.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step++;
    }
  },

  playStep(step, t) {
    const s16 = step % 16;                 // 小节内位置
    const bar = Math.floor(step / 16);
    const section = Math.floor(bar / 8) % 4; // 每 8 小节换段落

    /* KICK — 四四拍底鼓（section 1 留白制造张力） */
    if (s16 % 4 === 0 && section !== 1) this.kick(t);
    /* CLAP — 2、4 拍 */
    if ((s16 === 4 || s16 === 12) && section >= 2) this.clap(t);
    /* HAT — off-beat 开镲 + 16 分闭镲 */
    if (s16 % 4 === 2) this.hat(t, 0.3, 0.09);
    else if (section >= 1 && Math.random() < 0.5) this.hat(t, 0.08, 0.03);
    /* ACID BASS */
    const note = this.bassline[s16];
    if (note >= 0 && section !== 3) {
      this.acid(t, 55 * Math.pow(2, note / 12), this.accents[s16], bar);
    }
    /* PAD — 每 2 小节一个和弦 */
    if (step % 32 === 0) {
      this.pad(t, this.chords[Math.floor(bar / 2) % 4]);
    }
  },

  kick(t) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.3);
  },

  hat(t, vol, dec) {
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ac.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 8500;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    src.connect(hp).connect(g).connect(this.bus);
    src.start(t, Math.random()); src.stop(t + dec + 0.02);
  },

  clap(t) {
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1700; bp.Q.value = 1.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t, Math.random()); src.stop(t + 0.2);
  },

  acid(t, freq, accent, bar) {
    const o = ac.createOscillator(); o.type = "sawtooth";
    o.frequency.value = freq;
    const f = ac.createBiquadFilter();
    f.type = "lowpass"; f.Q.value = 14;
    /* 滤波器随小节缓慢开合 —— 经典 303 扫频 */
    const sweep = 300 + 2200 * (0.5 + 0.5 * Math.sin(bar * 0.7)) + (accent ? 900 : 0);
    f.frequency.setValueAtTime(sweep, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, sweep * 0.12), t + 0.16);
    const g = ac.createGain();
    g.gain.setValueAtTime(accent ? 0.34 : 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(f).connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.2);
  },

  pad(t, chord) {
    const barLen = this.stepDur * 16;
    chord.forEach((f0) => {
      [0.997, 1.004].forEach((det) => {
        const o = ac.createOscillator(); o.type = "sawtooth";
        o.frequency.value = f0 * 4 * det;
        const lp = ac.createBiquadFilter();
        lp.type = "lowpass"; lp.frequency.value = 750;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + barLen * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t + barLen * 2);
        o.connect(lp).connect(g).connect(this.bus);
        o.start(t); o.stop(t + barLen * 2 + 0.1);
      });
    });
  },
};

/* ============================================================
   网易云歌单接入
   ============================================================ */
function setCloudState(text) { els.cloudState.textContent = "CLOUD :: " + text; }

/* 网易云歌曲对象 → 队列曲目 */
function songToTrack(s) {
  return {
    type: "cloud",
    id: s.id,
    name: s.name,
    artist: (s.ar || []).map((a) => a.name).join(" / "),
    album: s.al?.name || "",
    cover: s.al?.picUrl ? s.al.picUrl + "?param=300y300" : null,
    duration: (s.dt || 0) / 1000,
    quality: null,
    lyrics: undefined,
    unavailable: false,
  };
}

/* 用一组云端歌曲替换队列中原有的云端曲目（保留 synth demo 与本地文件），
   返回第一首新曲目的索引 */
function replaceCloudTracks(songs, label) {
  const playingTrack = currentTrack();
  const keep = tracks.filter((t) => t.type !== "cloud");
  tracks.length = 0;
  tracks.push(...keep, ...songs);
  const stillHere = tracks.indexOf(playingTrack);
  state.current = stillHere >= 0 ? stillHere : 0;
  setCloudState(`${songs.length} TRACKS · ${label}`.toUpperCase());
  renderQueue();
  updateTrackUI();
  return keep.length;
}

async function loadCloudPlaylist(id = state.playlistId) {
  setCloudState("CONNECTING…");
  try {
    const d = await api(`/playlist/detail?id=${id}`);
    state.playlistId = id;
    return replaceCloudTracks(d.playlist.tracks.map(songToTrack), d.playlist.name);
  } catch (e) {
    setCloudState("OFFLINE — 请启动 api-enhanced");
    return -1;
  }
}

/* 队列自动填入每日推荐（需登录） */
async function loadDailyIntoQueue() {
  setCloudState("LOADING DAILY…");
  try {
    const d = await api("/recommend/songs");
    const songs = (d.data?.dailySongs || []).map(songToTrack);
    if (!songs.length) throw new Error("empty daily");
    return replaceCloudTracks(songs, "每日推荐");
  } catch (e) {
    setCloudState("日推加载失败");
    return -1;
  }
}

/* 按登录态填充队列：已登录 → 每日推荐；否则/失败 → 默认歌单 */
async function bootQueue() {
  let filled = -1;
  if (auth.profile) filled = await loadDailyIntoQueue();
  if (filled < 0) await loadCloudPlaylist();
}

/* ============================================================
   播放控制
   ============================================================ */
function currentTrack() { return tracks[state.current]; }
let loadToken = 0;       // 防止快速切歌时旧的异步取流覆盖新曲
let failStreak = 0;      // 连续取流失败计数，防止整列表无限跳过

function play() {
  ensureAudio();
  const tr = currentTrack();
  if (tr.type === "synth") synth.start();
  else if (tr.type === "cloud" && !audio.getAttribute("src")) {
    resolveCloud(tr, ++loadToken);       // 还没取到流地址 → 先取流再播
    return;
  } else audio.play();
  state.playing = true;
  syncTransportUI();
}

/* 取云端音频流地址并开播（resumeAt：换音质时续播位置） */
async function resolveCloud(tr, token, resumeAt = 0) {
  els.engineState.textContent = "ENGINE :: BUFFERING";
  try {
    const d = await api(`/song/url/v1?id=${tr.id}&level=${QUALITIES[state.qualityIdx][0]}`);
    if (token !== loadToken) return;     // 用户已切走
    const item = d.data?.[0];
    if (!item?.url) {                    // 无版权 / VIP 专享
      tr.unavailable = true;
      renderQueue();
      if (++failStreak >= 5) { setCloudState("连续取流失败，已暂停自动跳过"); pause(); return; }
      nextTrack(true);
      return;
    }
    tr.quality = `${Math.round((item.br || 0) / 1000)}K ${String(item.type || "").toUpperCase()}`;
    audio.src = item.url;
    if (resumeAt > 0) {
      audio.addEventListener("loadedmetadata", () => { audio.currentTime = resumeAt; }, { once: true });
    }
    audio.play();
    state.playing = true;
    updateTrackUI();
    syncTransportUI();
  } catch (e) {
    if (token !== loadToken) return;
    setCloudState("STREAM ERROR — 检查 API 服务");
    state.playing = false;
    syncTransportUI();
  }
}

audio.addEventListener("playing", () => { failStreak = 0; });

/* 流地址过期等播放错误：云端曲目重取一次 */
audio.addEventListener("error", () => {
  const tr = currentTrack();
  if (tr.type !== "cloud" || !audio.src) return;
  if (tr._retried) { tr.unavailable = true; renderQueue(); nextTrack(true); return; }
  tr._retried = true;
  audio.removeAttribute("src");
  resolveCloud(tr, ++loadToken);
});

function pause() {
  const tr = currentTrack();
  if (tr.type === "synth") synth.stop();
  else audio.pause();
  state.playing = false;
  syncTransportUI();
}

function togglePlay() { state.playing ? pause() : play(); }

function loadTrack(i, autoplay = true) {
  if (i < 0 || i >= tracks.length) return;
  const token = ++loadToken;
  /* 停掉旧轨 */
  if (ac) {
    if (currentTrack().type === "synth") synth.stop();
    else { audio.pause(); }
  }
  state.current = i;
  const tr = currentTrack();
  state.playing = false;
  lyric.reset();
  if (tr.type === "synth") {
    synth.reset();
    audio.removeAttribute("src");
  } else if (tr.type === "file") {
    audio.src = tr.url;
  } else {
    /* cloud：清旧源，流地址异步获取 */
    tr._retried = false;
    audio.removeAttribute("src");
    ensureLyrics(tr);
  }
  updateTrackUI();
  renderQueue();
  updateMediaSession();
  comments.onTrackChange();
  if (autoplay) {
    if (tr.type === "cloud") { ensureAudio(); resolveCloud(tr, token); }
    else play();
  }
}

function nextTrack(auto = false) {
  if (tracks.length < 2 && !auto) return;
  let n;
  if (state.shuffle && tracks.length > 1) {
    do { n = Math.floor(Math.random() * tracks.length); } while (n === state.current);
  } else {
    n = state.current + 1;
    if (n >= tracks.length) {
      if (auto && state.repeat === "off") { loadTrack(0, false); return; }
      n = 0;
    }
  }
  loadTrack(n);
}

function prevTrack() {
  const tr = currentTrack();
  /* 已播放超过 3 秒 → 回到开头 */
  const cur = tr.type === "synth" ? synth.elapsed() : audio.currentTime;
  if (cur > 3) {
    if (tr.type === "synth") {
      const wasPlaying = state.playing;
      synth.stop(); synth.reset();           // 先停再清零，避免 stop 覆盖已清零的时长
      if (wasPlaying) synth.start();
    } else audio.currentTime = 0;
    return;
  }
  loadTrack((state.current - 1 + tracks.length) % tracks.length);
}

/* ============================================================
   歌词引擎 — LRC 解析 + 翻译合并 + 同步高亮
   ============================================================ */
function parseLRC(text) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const txt = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text: txt });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* 逐字歌词（yrc）解析：每行 [行起,行长](字起,字长,0)字… —— 时间戳为真实毫秒，
   每个字段携带自己的起始与时长，可据此做精确逐字填充 */
function parseYrc(text) {
  const lines = [];
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "{") continue;        // 跳过 JSON 元数据行
    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const body = line.slice(head[0].length);
    const re = /\((\d+),(\d+),\d+\)/g;
    const marks = [];
    let m;
    while ((m = re.exec(body))) marks.push({ at: m.index, end: re.lastIndex, t: +m[1] / 1000, d: +m[2] / 1000 });
    if (!marks.length) continue;
    const words = marks.map((mk, i) => ({
      t: mk.t,
      d: Math.max(mk.d, 0.001),
      tx: body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : body.length),
    }));
    const fullText = words.map((w) => w.tx).join("");
    if (!fullText.trim()) continue;
    lines.push({ t: +head[1] / 1000, dur: +head[2] / 1000, words, text: fullText });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function ensureLyrics(tr) {
  if (tr.type !== "cloud" || tr.lyrics !== undefined) return;
  tr.lyrics = null;                              // 占位，防止并发重复请求
  try {
    const d = await api(`/lyric/new?id=${tr.id}`);
    let main = parseYrc(d.yrc?.lyric);            // 逐字优先
    tr.wordByWord = main.length > 0;
    if (!main.length) main = parseLRC(d.lrc?.lyric);   // 无逐字 → 退回行级
    const trans = parseLRC(d.tlyric?.lyric);
    /* 按时间戳给原文行挂上译文 */
    for (const line of main) {
      const hit = trans.find((x) => Math.abs(x.t - line.t) < 0.5);
      if (hit && hit.text) line.trans = hit.text;
    }
    tr.lyrics = main.filter((l) => l.text || l.trans);
    if (currentTrack() === tr) lyric.reset();
  } catch (e) { tr.lyrics = null; }
}

const lyric = {
  idx: -1,
  wordEls: [],
  on: localStorage.getItem("lyrics-on") !== "0",

  reset() {
    this.idx = -1;
    this.wordEls = [];
    els.lyrNext.textContent = "";
    els.lyrTrans.textContent = "";
    els.lyrCur.classList.remove("flip", "kar");
    const tr = currentTrack();
    els.lyrCur.textContent =
      tr.type !== "cloud" ? "— NO LYRIC DATA —" :
      tr.lyrics === undefined || tr.lyrics === null ? "···" :
      tr.lyrics.length ? "♪" : "— NO LYRIC DATA —";
    this.applyVisibility();
  },

  applyVisibility() {
    els.lyrics.hidden = !this.on;
    document.body.classList.toggle("lyrics-on", this.on);
    els.btnLyrics.classList.toggle("active", this.on);
  },

  toggle() {
    this.on = !this.on;
    localStorage.setItem("lyrics-on", this.on ? "1" : "0");
    this.applyVisibility();
  },

  /* 行切换：重建当前行（逐字则拆成字 span），重触发入场动画 */
  renderLine(i, L, tr) {
    this.idx = i;
    this.wordEls = [];
    els.lyrTrans.textContent = i >= 0 ? (L[i].trans || "") : "";
    els.lyrNext.textContent = i + 1 < L.length && L[i + 1].text ? "↳ " + L[i + 1].text : "";
    els.lyrCur.classList.remove("flip", "kar");
    if (i < 0) {
      els.lyrCur.textContent = "♪";
    } else if (tr.wordByWord && L[i].words) {
      els.lyrCur.textContent = "";
      els.lyrCur.classList.add("kar");
      const frag = document.createDocumentFragment();
      for (const w of L[i].words) {
        const sp = document.createElement("span");
        sp.className = "lw";
        sp.textContent = w.tx;
        sp.style.setProperty("--p", "0");
        frag.appendChild(sp);
        this.wordEls.push({ el: sp, t: w.t, d: w.d });
      }
      els.lyrCur.appendChild(frag);
    } else {
      els.lyrCur.textContent = L[i].text || "· · ·";
    }
    void els.lyrCur.offsetWidth;            // 强制重排以重触发动画
    els.lyrCur.classList.add("flip");
  },

  /* 每帧调用：行切换重建 DOM，逐字行则按真实字时间填充进度 */
  sync(time) {
    const tr = currentTrack();
    const L = tr.lyrics;
    if (!this.on || !L || !L.length) return;
    let i = this.idx;
    /* 常规前进：从当前行向后找；seek 回退则全量重扫 */
    if (i >= 0 && i < L.length && L[i].t > time) i = -1;
    while (i + 1 < L.length && L[i + 1].t <= time) i++;
    if (i !== this.idx) this.renderLine(i, L, tr);
    /* 逐字填充：每个字按 (now - 起始)/时长 推进 0→1 */
    for (const we of this.wordEls) {
      let p = (time - we.t) / we.d;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      we.el.style.setProperty("--p", p.toFixed(3));
    }
  },
};

audio.addEventListener("ended", () => {
  if (state.repeat === "one") { audio.currentTime = 0; audio.play(); return; }
  nextTrack(true);
});

/* ---------- 文件加载 ---------- */
function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("audio/") || /\.(mp3|flac|wav|ogg|m4a|aac|opus|webm)$/i.test(f.name));
  if (!files.length) return;
  ensureAudio();
  const firstNew = tracks.length;
  for (const f of files) {
    const t = {
      type: "file",
      name: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      meta: (f.type || "AUDIO/FILE").toUpperCase(),
      url: URL.createObjectURL(f),
      duration: NaN,
    };
    tracks.push(t);
    /* 异步探测时长 */
    const probe = new Audio();
    probe.preload = "metadata";
    probe.src = t.url;
    probe.addEventListener("loadedmetadata", () => {
      t.duration = probe.duration;
      renderQueue();
      if (currentTrack() === t) updateTrackUI();
    }, { once: true });
  }
  renderQueue();
  loadTrack(firstNew);                  // 立即播放新加入的第一首
  els.drawer.classList.add("open");
}

els.add.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

/* 拖放 */
let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; els.dropzone.classList.add("over"); });
addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove("over"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0;
  els.dropzone.classList.remove("over");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* ============================================================
   UI 同步
   ============================================================ */
function fmt(s) {
  if (!isFinite(s)) return "LIVE";
  s = Math.max(0, Math.floor(s));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/* 评论时间戳 → 相对时间 */
function fmtTime(ms) {
  if (!ms) return "";
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + "天前";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function syncTransportUI() {
  els.play.textContent = state.playing ? "⏸" : "▶";
  document.body.classList.toggle("paused", !state.playing);
  document.body.classList.toggle("playing", state.playing);
  els.engineState.textContent = state.playing
    ? (currentTrack().type === "synth" ? "ENGINE :: SYNTHESIS" : "ENGINE :: DECODE")
    : "ENGINE :: STANDBY";
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }
}

function updateTrackUI() {
  const tr = currentTrack();
  const head = tr.type === "cloud" && tr.artist ? `${tr.name}  ·  ${tr.artist}` : tr.name;
  const text = (head + "  ·  NOISE//SYSTEM  ·  ").toUpperCase();
  els.marquee.textContent = text.repeat(4);
  els.ghost.textContent = text.repeat(4);
  els.trackIndex.textContent = `TRK ${String(state.current + 1).padStart(3, "0")} / ${String(tracks.length).padStart(3, "0")}`;
  els.trackName.textContent = tr.name;
  /* 元信息：艺术家 · 专辑 · 音质 */
  if (tr.type === "cloud") {
    els.trackMeta.textContent = (tr.artist || "UNKNOWN").toUpperCase();
    els.trackMeta2.textContent =
      [tr.album, tr.quality].filter(Boolean).join(" · ").toUpperCase();
  } else {
    els.trackMeta.textContent = tr.meta || "";
    els.trackMeta2.textContent = "";
  }
  /* 封面 */
  if (tr.cover) { els.cover.src = tr.cover; els.cover.hidden = false; }
  else { els.cover.hidden = true; els.cover.removeAttribute("src"); }
  els.seek.classList.toggle("live", tr.type === "synth");
  els.timeDur.textContent = fmt(tr.duration);
  document.title = `${tr.name} — NOISE//SYSTEM`;
  updateLikeUI();
}

function renderQueue() {
  els.queue.innerHTML = "";
  tracks.forEach((t, i) => {
    const li = document.createElement("li");
    if (i === state.current) li.classList.add("current");
    if (t.unavailable) li.classList.add("unavailable");
    const idx = document.createElement("span");
    idx.className = "q-idx";
    idx.textContent = String(i + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "q-name";
    name.textContent = t.name;
    const dur = document.createElement("span");
    dur.className = "q-dur";
    dur.textContent = t.type === "synth" ? "∞" : (isNaN(t.duration) ? "--:--" : fmt(t.duration));
    if (t.artist) {
      const ar = document.createElement("span");
      ar.className = "q-artist";
      ar.textContent = t.artist;
      li.append(idx, name, ar, dur);
    } else li.append(idx, name, dur);
    if (t.type !== "synth") {
      const rm = document.createElement("button");
      rm.className = "q-remove";
      rm.textContent = "✕";
      rm.title = "从队列移除";
      rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeTrack(i); });
      li.appendChild(rm);
    }
    li.addEventListener("click", () => loadTrack(i));
    els.queue.appendChild(li);
  });
}

/* 从队列移除（synth demo 常驻不可移除） */
function removeTrack(i) {
  if (i <= 0 || i >= tracks.length) return;
  const removingCurrent = i === state.current;
  if (tracks[i].type === "file") URL.revokeObjectURL(tracks[i].url);
  tracks.splice(i, 1);
  if (i < state.current) {
    state.current--;
  } else if (removingCurrent) {
    state.current = Math.min(i, tracks.length - 1);
    loadTrack(state.current, state.playing);
    return;
  }
  renderQueue();
  updateTrackUI();
}

/* 立即播放（插入当前曲目之后）/ 加入队列末尾 */
function playNow(t) {
  tracks.splice(state.current + 1, 0, t);
  loadTrack(state.current + 1);
}
function enqueue(t) {
  tracks.push(t);
  renderQueue();
  updateTrackUI();
}

/* ---------- 进度条 ---------- */
function setSeekUI(ratio) {
  const pct = (ratio * 100).toFixed(2) + "%";
  els.seekFill.style.width = pct;
  els.seekHead.style.left = pct;
}

function seekFromEvent(e) {
  const tr = currentTrack();
  if (tr.type === "synth" || !isFinite(audio.duration)) return;
  const r = els.seek.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  audio.currentTime = Math.min(Math.max(x / r.width, 0), 1) * audio.duration;
}
let seeking = false;
els.seek.addEventListener("pointerdown", (e) => { seeking = true; els.seek.setPointerCapture(e.pointerId); seekFromEvent(e); });
els.seek.addEventListener("pointermove", (e) => seeking && seekFromEvent(e));
addEventListener("pointerup", () => (seeking = false));

/* ---------- 音量 ---------- */
function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  if (masterGain) masterGain.gain.setTargetAtTime(state.volume, ac.currentTime, 0.02);
  els.volFill.style.width = state.volume * 100 + "%";
  els.volNum.textContent = Math.round(state.volume * 100);
}
function volFromEvent(e) {
  const r = els.vol.getBoundingClientRect();
  setVolume(((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width);
}
let voling = false;
els.vol.addEventListener("pointerdown", (e) => { voling = true; els.vol.setPointerCapture(e.pointerId); volFromEvent(e); });
els.vol.addEventListener("pointermove", (e) => voling && volFromEvent(e));
addEventListener("pointerup", () => (voling = false));

/* ---------- 按钮 ---------- */
els.play.addEventListener("click", togglePlay);
els.prev.addEventListener("click", prevTrack);
els.next.addEventListener("click", () => nextTrack());
els.shuffle.addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  els.shuffle.classList.toggle("active", state.shuffle);
});
els.repeat.addEventListener("click", () => {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  els.repeat.classList.toggle("active", state.repeat !== "off");
  els.repeat.textContent = state.repeat === "one" ? "⟳¹" : "⟳";
  els.repeat.title = { off: "循环：关", all: "循环：全部", one: "循环：单曲" }[state.repeat];
});
els.list.addEventListener("click", () => els.drawer.classList.toggle("open"));
els.closeDrawer.addEventListener("click", () => els.drawer.classList.remove("open"));
els.vizBtn.addEventListener("click", cycleViz);
els.btnLyrics.addEventListener("click", () => lyric.toggle());
els.btnLike.addEventListener("click", toggleLike);
els.btnSpeed.addEventListener("click", () => {
  state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
  audio.playbackRate = SPEEDS[state.speedIdx][0];
  els.btnSpeed.textContent = SPEEDS[state.speedIdx][1];
});
function setQuality(idx) {
  state.qualityIdx = ((idx % QUALITIES.length) + QUALITIES.length) % QUALITIES.length;
  localStorage.setItem("ncm-quality", state.qualityIdx);
  els.btnQuality.textContent = QUALITIES[state.qualityIdx][1];
  settings.syncQuality();
  log("音质 →", QUALITIES[state.qualityIdx][0]);
  /* 正在播放云端曲目 → 以新音质就地续播 */
  const tr = currentTrack();
  if (state.playing && tr.type === "cloud" && audio.getAttribute("src")) {
    resolveCloud(tr, ++loadToken, audio.currentTime);
  }
}
els.btnQuality.addEventListener("click", () => setQuality(state.qualityIdx + 1));

function cycleViz() {
  state.vizMode = (state.vizMode + 1) % VIZ_MODES.length;
  els.vizBtn.textContent = "VIZ :: " + VIZ_MODES[state.vizMode];
}

/* ============================================================
   网易云账号 — 二维码登录 / 退出 / 红心列表
   ============================================================ */
const auth = {
  profile: null,
  qrTimer: null,

  async init() {
    if (localStorage.getItem("ncm-cookie")) {
      try {
        const d = await api("/login/status");
        const p = d.data?.profile;
        if (p) {
          this.profile = p;
          this.refreshLiked();
          /* 登录后版权范围变大：清除不可用标记让其可重试 */
          tracks.forEach((t) => { if (t.type === "cloud") t.unavailable = false; });
          renderQueue();
        } else {
          localStorage.removeItem("ncm-cookie");
        }
      } catch (e) { /* API 离线，保留 cookie 下次再试 */ }
    }
    this.renderChip();
    this.renderAccount();
  },

  renderChip() {
    if (this.profile) {
      els.userName.textContent = this.profile.nickname;
      els.userAvatar.src = this.profile.avatarUrl + "?param=60y60";
      els.userAvatar.hidden = false;
    } else {
      els.userName.textContent = "未登录 ▸";
      els.userAvatar.hidden = true;
      els.userAvatar.removeAttribute("src");
    }
  },

  async refreshLiked() {
    if (!this.profile) return;
    try {
      const d = await api(`/likelist?uid=${this.profile.userId}`);
      likedIds = new Set(d.ids || []);
      updateLikeUI();
    } catch (e) { /* 忽略 */ }
  },

  stopQR() {
    if (this.qrTimer) { clearInterval(this.qrTimer); this.qrTimer = null; }
  },

  async startQR() {
    this.stopQR();
    const box = els.accountBox;
    box.innerHTML = '<div class="qr-state">生成二维码…</div>';
    try {
      const k = await api("/login/qr/key");
      const key = k.data.unikey;
      const q = await api(`/login/qr/create?key=${key}&qrimg=true`);
      box.innerHTML = "";
      const img = new Image();
      img.className = "qr";
      img.src = q.data.qrimg;
      img.title = "点击刷新二维码";
      img.addEventListener("click", () => this.startQR());
      const st = document.createElement("div");
      st.className = "qr-state";
      st.textContent = "打开网易云音乐 APP 扫码登录";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "扫码后在手机上确认；二维码过期可点击图片刷新";
      box.append(img, st, hint);
      this.qrTimer = setInterval(async () => {
        try {
          const c = await api(`/login/qr/check?key=${key}`);
          if (c.code === 800) {
            this.stopQR();
            st.textContent = "二维码已过期 — 点击图片刷新";
            img.style.opacity = ".3";
          } else if (c.code === 802) {
            st.textContent = "已扫码 — 请在手机上确认";
          } else if (c.code === 803) {
            this.stopQR();
            localStorage.setItem("ncm-cookie", c.cookie || "");
            st.textContent = "登录成功";
            await this.init();
            library.renderPlaylists();
            loadDailyIntoQueue();          // 登录成功 → 队列换成每日推荐
          }
        } catch (e) { /* 单次轮询失败忽略 */ }
      }, 2000);
    } catch (e) {
      box.innerHTML = '<div class="qr-state">无法连接 API 服务</div>';
    }
  },

  async logout() {
    this.stopQR();
    try { await api("/logout"); } catch (e) { /* 忽略 */ }
    localStorage.removeItem("ncm-cookie");
    this.profile = null;
    likedIds = new Set();
    this.renderChip();
    this.renderAccount();
    updateLikeUI();
    library.renderPlaylists();
    loadCloudPlaylist(DEFAULT_PLAYLIST_ID);   // 退出后回退默认歌单
  },

  renderAccount() {
    this.stopQR();
    const box = els.accountBox;
    box.innerHTML = "";
    if (this.profile) {
      const img = new Image();
      img.className = "avatar";
      img.src = this.profile.avatarUrl + "?param=200y200";
      const nick = document.createElement("div");
      nick.className = "nick";
      nick.textContent = this.profile.nickname;
      const uid = document.createElement("div");
      uid.className = "uid";
      uid.textContent = `UID ${this.profile.userId}`;
      const out = document.createElement("button");
      out.className = "btn btn-wide";
      out.textContent = "⏻ 退出登录";
      out.addEventListener("click", () => this.logout());
      box.append(img, nick, uid, out);
    } else {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "登录后解锁：VIP 曲目播放 · 我的歌单 · 每日推荐 · 红心收藏 · 更高音质";
      const btn = document.createElement("button");
      btn.className = "btn btn-wide";
      btn.textContent = "▣ 生成登录二维码";
      btn.addEventListener("click", () => this.startQR());
      box.append(hint, btn);
    }
  },
};

/* ---------- 红心喜欢 ---------- */
function updateLikeUI() {
  const tr = currentTrack();
  const liked = tr.type === "cloud" && likedIds.has(tr.id);
  els.btnLike.textContent = liked ? "♥" : "♡";
  els.btnLike.classList.toggle("active", liked);
}

async function toggleLike() {
  const tr = currentTrack();
  if (tr.type !== "cloud") return;
  if (!auth.profile) { library.open("user"); return; }   // 未登录 → 引导扫码
  const want = !likedIds.has(tr.id);
  likedIds[want ? "add" : "delete"](tr.id);              // 乐观更新
  updateLikeUI();
  try {
    const r = await api(`/like?id=${tr.id}&like=${want}`);
    if (r.code !== 200) throw new Error("like failed");
  } catch (e) {
    likedIds[want ? "delete" : "add"](tr.id);            // 失败回滚
    updateLikeUI();
  }
}

/* ============================================================
   LIBRARY 面板 — 搜索 / 歌单 / 日推 / 账号
   ============================================================ */
const library = {
  open(tab) {
    els.panel.classList.add("open");
    if (tab) this.switchTab(tab);
  },
  close() { els.panel.classList.remove("open"); },

  switchTab(name) {
    document.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === name));
    for (const n of ["lists", "daily", "comments", "user"]) {
      $("tab-" + n).hidden = n !== name;
    }
    if (name === "lists") this.renderPlaylists();
    if (name === "daily") this.loadDaily();
    if (name === "comments") comments.load();
  },

  emptyRow(ul, text) {
    ul.innerHTML = "";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = text;
    ul.appendChild(li);
  },

  /* 歌曲行（搜索结果 / 日推共用）：点行立即播放，点 + 加入队列 */
  renderSongRows(ul, songs, closeFn) {
    const close = closeFn || (() => this.close());
    ul.innerHTML = "";
    if (!songs.length) { this.emptyRow(ul, "无结果"); return; }
    for (const t of songs) {
      const li = document.createElement("li");
      if (t.cover) {
        const im = new Image();
        im.className = "r-thumb";
        im.loading = "lazy";
        im.src = t.cover.replace("300y300", "80y80");
        li.appendChild(im);
      }
      const main = document.createElement("div");
      main.className = "r-main";
      const nm = document.createElement("div");
      nm.className = "r-name";
      nm.textContent = t.name;
      const sub = document.createElement("div");
      sub.className = "r-sub";
      sub.textContent = [t.artist, t.album].filter(Boolean).join(" · ");
      main.append(nm, sub);
      const dur = document.createElement("span");
      dur.className = "r-dur";
      dur.textContent = fmt(t.duration);
      const add = document.createElement("button");
      add.className = "r-add";
      add.textContent = "+";
      add.title = "加入队列";
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        enqueue({ ...t });
        add.textContent = "✓";
        setTimeout(() => (add.textContent = "+"), 900);
      });
      li.append(main, dur, add);
      li.addEventListener("click", () => { playNow({ ...t }); close(); });
      ul.appendChild(li);
    }
  },

  async renderPlaylists() {
    const ul = els.playlistList;
    ul.innerHTML = "";
    /* 置顶：内置默认歌单 */
    const def = document.createElement("li");
    const defMain = document.createElement("div");
    defMain.className = "r-main";
    defMain.innerHTML = `<div class="r-name">☁ 默认歌单</div><div class="r-sub">ID ${DEFAULT_PLAYLIST_ID} · 重新载入</div>`;
    def.appendChild(defMain);
    def.addEventListener("click", () => this.openPlaylist(DEFAULT_PLAYLIST_ID));
    ul.appendChild(def);
    if (!auth.profile) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "登录后显示你创建与收藏的歌单";
      ul.appendChild(li);
      return;
    }
    try {
      const d = await api(`/user/playlist?uid=${auth.profile.userId}&limit=200`);
      for (const p of d.playlist || []) {
        const li = document.createElement("li");
        const im = new Image();
        im.className = "r-thumb";
        im.loading = "lazy";
        im.src = (p.coverImgUrl || "") + "?param=80y80";
        const main = document.createElement("div");
        main.className = "r-main";
        const nm = document.createElement("div");
        nm.className = "r-name";
        nm.textContent = p.name;
        const sub = document.createElement("div");
        sub.className = "r-sub";
        sub.textContent = `${p.trackCount} 首 · ${p.creator?.nickname || ""}`;
        main.append(nm, sub);
        li.append(im, main);
        li.addEventListener("click", () => this.openPlaylist(p.id));
        ul.appendChild(li);
      }
    } catch (e) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "歌单加载失败";
      ul.appendChild(li);
    }
  },

  /* 载入歌单到队列并从第一首云端曲目开播 */
  async openPlaylist(id) {
    setCloudState("LOADING PLAYLIST…");
    const firstCloud = await loadCloudPlaylist(id);
    if (firstCloud >= 0 && firstCloud < tracks.length) {
      this.close();
      els.drawer.classList.add("open");
      loadTrack(firstCloud);
    }
  },

  async loadDaily() {
    const ul = els.dailyList;
    if (!auth.profile) { this.emptyRow(ul, "每日推荐需要登录 — 前往「账号」扫码"); return; }
    this.emptyRow(ul, "LOADING…");
    try {
      const d = await api("/recommend/songs");
      this.renderSongRows(ul, (d.data?.dailySongs || []).map(songToTrack));
      /* 置顶操作行：整组填入队列并开播 */
      const all = document.createElement("li");
      const main = document.createElement("div");
      main.className = "r-main";
      main.innerHTML = '<div class="r-name">▶ 全部填入队列</div><div class="r-sub">替换当前云端队列</div>';
      all.appendChild(main);
      all.addEventListener("click", async () => {
        const first = await loadDailyIntoQueue();
        if (first >= 0 && first < tracks.length) {
          this.close();
          els.drawer.classList.add("open");
          loadTrack(first);
        }
      });
      ul.prepend(all);
    } catch (e) {
      this.emptyRow(ul, "日推加载失败");
    }
  },
};

/* ============================================================
   评论 — 当前曲目热门/最新评论 · 点赞 · 发送
   ============================================================ */
const comments = {
  sort: 2,           // 1 推荐 / 2 热度 / 3 时间
  trackId: null,

  open() { library.open("comments"); },

  /* 曲目切换时若评论面板可见则刷新 */
  onTrackChange() {
    if (els.panel.classList.contains("open") && !$("tab-comments").hidden) this.load();
  },

  async load(force = false) {
    const tr = currentTrack();
    els.commentTitle.textContent = tr.type === "cloud" ? tr.name : "—";
    els.commentCompose.hidden = !(tr.type === "cloud" && auth.profile);
    if (tr.type !== "cloud") {
      library.emptyRow(els.commentList, "仅云端曲目支持评论");
      this.trackId = null;
      return;
    }
    if (!force && this.trackId === tr.id && els.commentList.childElementCount) return;
    this.trackId = tr.id;
    library.emptyRow(els.commentList, "LOADING…");
    try {
      const d = await api(`/comment/new?type=0&id=${tr.id}&sortType=${this.sort}&pageSize=30`);
      if (this.trackId !== tr.id) return;        // 期间已切歌
      const list = d.data?.comments || [];
      els.commentList.innerHTML = "";
      if (!list.length) { library.emptyRow(els.commentList, "暂无评论"); return; }
      for (const c of list) els.commentList.appendChild(this.row(c));
    } catch (e) {
      library.emptyRow(els.commentList, "评论加载失败 — 检查 API 服务");
    }
  },

  row(c) {
    const cid = this.trackId;
    const li = document.createElement("li");
    li.className = "cmt";
    const im = new Image();
    im.className = "c-avatar";
    im.loading = "lazy";
    im.src = (c.user?.avatarUrl || "") + "?param=60y60";
    const main = document.createElement("div");
    main.className = "c-main";
    const top = document.createElement("div");
    top.className = "c-top";
    const nick = document.createElement("span");
    nick.className = "c-nick";
    nick.textContent = c.user?.nickname || "匿名";
    const time = document.createElement("span");
    time.className = "c-time";
    time.textContent = fmtTime(c.time);
    top.append(nick, time);
    const body = document.createElement("div");
    body.className = "c-body";
    body.textContent = c.content || "";
    main.append(top, body);
    const rep = c.beReplied?.[0];
    if (rep?.content) {
      const q = document.createElement("div");
      q.className = "c-quote";
      q.textContent = `@${rep.user?.nickname || ""}：${rep.content}`;
      main.appendChild(q);
    }
    const like = document.createElement("button");
    like.className = "c-like";
    let liked = !!c.liked, count = c.likedCount || 0;
    const paint = () => {
      like.textContent = (liked ? "♥ " : "♡ ") + (count > 0 ? count : "");
      like.classList.toggle("active", liked);
    };
    paint();
    like.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!auth.profile) { library.switchTab("user"); return; }
      const want = !liked;
      liked = want; count += want ? 1 : -1; paint();           // 乐观更新
      try {
        const r = await api(`/comment/like?id=${cid}&cid=${c.commentId}&t=${want ? 1 : 0}&type=0`);
        if (r.code !== 200) throw new Error("like failed");
      } catch (e) { liked = !want; count += want ? -1 : 1; paint(); }
    });
    li.append(im, main, like);
    return li;
  },

  setSort(s) {
    if (this.sort === s) return;
    this.sort = s;
    document.querySelectorAll(".c-sort-btn").forEach((b) =>
      b.classList.toggle("active", +b.dataset.sort === s));
    this.load(true);
  },

  async send() {
    const text = els.commentInput.value.trim();
    if (!text || !auth.profile || !this.trackId) return;
    els.commentInput.disabled = true;
    try {
      const r = await api(`/comment?t=1&type=0&id=${this.trackId}&content=${encodeURIComponent(text)}`);
      if (r.code !== 200) throw new Error("send failed");
      els.commentInput.value = "";
      this.sort = 3;                              // 切到「最新」以便看到自己的评论
      document.querySelectorAll(".c-sort-btn").forEach((b) =>
        b.classList.toggle("active", +b.dataset.sort === 3));
      this.load(true);
    } catch (e) {
      els.commentInput.classList.add("err");
      setTimeout(() => els.commentInput.classList.remove("err"), 600);
    } finally {
      els.commentInput.disabled = false;
    }
  },
};

/* ============================================================
   全屏搜索
   ============================================================ */
const search = {
  open() {
    els.searchOverlay.classList.add("open");
    els.searchInput.focus();
    els.searchInput.select();
  },
  close() { els.searchOverlay.classList.remove("open"); },
  toggle() { els.searchOverlay.classList.contains("open") ? this.close() : this.open(); },

  async run() {
    const kw = els.searchInput.value.trim();
    if (!kw) return;
    library.emptyRow(els.searchResults, "SEARCHING…");
    log("搜索", kw);
    try {
      const d = await api(`/cloudsearch?keywords=${encodeURIComponent(kw)}&type=1&limit=50`);
      const songs = (d.result?.songs || []).map(songToTrack);
      library.renderSongRows(els.searchResults, songs, () => this.close());
    } catch (e) {
      library.emptyRow(els.searchResults, "搜索失败 — 检查 API 服务");
    }
  },
};

/* ============================================================
   设置 — API 端点 / 音质 / 默认歌单 / 控制台日志
   ============================================================ */
/* 从歌单 ID 或 music.163.com 链接中解析数字 ID */
function parsePlaylistId(s) {
  s = String(s).trim();
  const idEq = s.match(/[?&]id=(\d+)/);
  if (idEq) return +idEq[1];
  const num = s.match(/\d{4,}/);
  return num ? +num[0] : 0;
}

const settings = {
  open() { this.render(); els.settings.classList.add("open"); },
  close() { els.settings.classList.remove("open"); },
  toggle() { els.settings.classList.contains("open") ? this.close() : this.open(); },
  status(msg) { els.setStatus.textContent = msg; },

  render() {
    els.setApi.value = API_BASE;
    els.setPlaylist.value = String(DEFAULT_PLAYLIST_ID);
    els.setDebug.classList.toggle("on", state.debug);
    els.setDebug.setAttribute("aria-checked", state.debug ? "true" : "false");
    /* 音质分段按钮 */
    els.setQualitySeg.innerHTML = "";
    QUALITIES.forEach(([level, label], i) => {
      const b = document.createElement("button");
      b.className = "seg-btn" + (i === state.qualityIdx ? " active" : "");
      b.textContent = label;
      b.title = level;
      b.dataset.q = i;
      b.addEventListener("click", () => { setQuality(i); this.status(`音质已设为 ${label} (${level})`); });
      els.setQualitySeg.appendChild(b);
    });
    this.status("改动即时保存到本地");
  },

  /* 音质在别处变更时同步分段按钮高亮 */
  syncQuality() {
    if (!els.setQualitySeg) return;
    els.setQualitySeg.querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("active", +b.dataset.q === state.qualityIdx));
  },

  async applyApi() {
    const v = els.setApi.value.trim().replace(/\/+$/, "");
    if (!v || v === API_BASE) return;
    API_BASE = v;
    localStorage.setItem("ncm-api", v);
    els.setApi.value = v;
    log("API 端点 →", v);
    this.status("RECONNECTING…");
    setCloudState("RECONNECTING…");
    await auth.init();
    await bootQueue();
    this.status("已切换 API 端点并重连");
  },

  applyPlaylist() {
    const id = parsePlaylistId(els.setPlaylist.value);
    if (!id) { this.status("⚠ 无法识别歌单 ID"); return; }
    if (id === DEFAULT_PLAYLIST_ID) { els.setPlaylist.value = String(id); return; }
    DEFAULT_PLAYLIST_ID = id;
    localStorage.setItem("ncm-default-playlist", id);
    els.setPlaylist.value = String(id);
    log("默认歌单 →", id);
    library.renderPlaylists();
    /* 未登录时默认歌单正在生效 → 立即载入；已登录则下次未登录时生效 */
    if (!auth.profile) {
      state.playlistId = id;
      loadCloudPlaylist(id);
      this.status(`默认歌单已设为 ${id} 并载入`);
    } else {
      this.status(`默认歌单已设为 ${id}（退出登录后生效）`);
    }
  },

  toggleDebug() {
    state.debug = !state.debug;
    localStorage.setItem("ncm-debug", state.debug ? "1" : "0");
    els.setDebug.classList.toggle("on", state.debug);
    els.setDebug.setAttribute("aria-checked", state.debug ? "true" : "false");
    this.status(state.debug ? "控制台日志已开启" : "控制台日志已关闭");
    if (state.debug) console.log("%cNS", LOG_STYLE, "控制台日志已开启 —— API 请求与关键事件将在此输出");
  },
};

/* 面板 / 搜索 / 设置 接线 */
els.btnLibrary.addEventListener("click", () => library.open());
els.closePanel.addEventListener("click", () => library.close());
els.userChip.addEventListener("click", () => library.open("user"));
els.btnSearch.addEventListener("click", () => search.open());
els.searchClose.addEventListener("click", () => search.close());
els.btnDoSearch.addEventListener("click", () => search.run());
els.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") search.run();
  if (e.key === "Escape") { els.searchInput.blur(); search.close(); }
});
els.searchOverlay.addEventListener("click", (e) => { if (e.target === els.searchOverlay) search.close(); });
els.btnSettings.addEventListener("click", () => settings.toggle());
els.closeSettings.addEventListener("click", () => settings.close());
els.settings.addEventListener("click", (e) => { if (e.target === els.settings) settings.close(); });
els.setApi.addEventListener("change", () => settings.applyApi());
els.setApi.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.setApi.blur();
  if (e.key === "Escape") settings.close();
});
els.setPlaylist.addEventListener("change", () => settings.applyPlaylist());
els.setPlaylist.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.setPlaylist.blur();
  if (e.key === "Escape") settings.close();
});
els.setDebug.addEventListener("click", () => settings.toggleDebug());
els.btnComments.addEventListener("click", () => comments.open());
els.commentSend.addEventListener("click", () => comments.send());
els.commentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") comments.send();
  if (e.key === "Escape") { els.commentInput.blur(); library.close(); }
});
document.querySelectorAll(".c-sort-btn").forEach((b) =>
  b.addEventListener("click", () => comments.setSort(+b.dataset.sort)));
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => library.switchTab(b.dataset.tab)));

/* ---------- 键盘 ---------- */
addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  switch (e.code) {
    case "Space": e.preventDefault(); togglePlay(); break;
    case "ArrowRight": nextTrack(); break;
    case "ArrowLeft": prevTrack(); break;
    case "ArrowUp": e.preventDefault(); setVolume(state.volume + 0.05); break;
    case "ArrowDown": e.preventDefault(); setVolume(state.volume - 0.05); break;
    case "KeyV": cycleViz(); break;
    case "KeyK": lyric.toggle(); break;
    case "KeyC": comments.open(); break;
    case "KeyL": els.drawer.classList.toggle("open"); break;
    case "Slash": e.preventDefault(); search.open(); break;
    case "Comma": e.preventDefault(); settings.toggle(); break;
    case "Escape":
      search.close(); settings.close(); library.close();
      els.drawer.classList.remove("open");
      break;
  }
});

/* ---------- Media Session ---------- */
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const tr = currentTrack();
  navigator.mediaSession.metadata = new MediaMetadata({
    title: tr.name,
    artist: tr.artist || "NOISE//SYSTEM",
    album: tr.album || "WEB AUDIO TERMINAL",
    artwork: tr.cover ? [{ src: tr.cover, sizes: "300x300" }] : [],
  });
}
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", pause);
  navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
  navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack());
}

/* ---------- 时钟 ---------- */
function tickClock() { els.clock.textContent = new Date().toTimeString().slice(0, 8); }
setInterval(tickClock, 1000);
tickClock();

/* 按钮点击后失焦，防止空格键触发双重切换 */
addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) b.blur();
});

/* ============================================================
   可视化 — 4 种模式
   ============================================================ */
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener("resize", resize);
resize();

const ACID = "#c8ff2e", MAGENTA = "#ff2ea6", PAPER = "#eaeaea";
let frame = 0, rot = 0, idlePhase = 0;
const FAKE_BINS = 256;
const fakeFreq = new Uint8Array(FAKE_BINS);
const fakeWave = new Uint8Array(1024);

function getData() {
  if (analyser && state.playing) {
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(waveData);
    return { f: freqData, w: waveData };
  }
  /* 待机时的呼吸假数据 */
  idlePhase += 0.012;
  for (let i = 0; i < FAKE_BINS; i++) {
    fakeFreq[i] = 14 + 12 * Math.sin(idlePhase + i * 0.07) * Math.exp(-i / 90);
  }
  for (let i = 0; i < fakeWave.length; i++) {
    fakeWave[i] = 128 + 5 * Math.sin(idlePhase * 3 + i * 0.02);
  }
  return { f: fakeFreq, w: fakeWave };
}

function energy(f, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += f[i];
  return s / (to - from) / 255;
}

/* 安全取频点（待机假数据只有 256 个 bin，需钳位防越界） */
function bin(f, i) { return f[Math.min(f.length - 1, i)] || 0; }

/* —— 模式 0：径向频谱环 —— */
function drawRadial(f) {
  const cx = W / 2, cy = H / 2;
  const bass = energy(f, 1, 24);
  const base = Math.min(W, H) * (0.16 + bass * 0.10);
  const N = 144;
  rot += 0.0024 + bass * 0.012;
  for (let i = 0; i < N; i++) {
    const v = bin(f, Math.floor((i / N) * 540)) / 255;
    const a = rot + (i / N) * Math.PI * 2;
    const r0 = base, r1 = base + v * Math.min(W, H) * 0.34 + 2;
    ctx.strokeStyle = v > 0.72 ? MAGENTA : ACID;
    ctx.globalAlpha = 0.28 + v * 0.72;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  /* 中心脉冲环 */
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, base * (0.82 + bass * 0.12), 0, Math.PI * 2);
  ctx.stroke();
}

/* —— 模式 1：粗野镜像频谱条 —— */
function drawBars(f) {
  const N = 56;
  const bw = W / N;
  for (let i = 0; i < N; i++) {
    const v = bin(f, Math.floor(Math.pow(i / N, 1.6) * 500) + 2) / 255;
    const h = Math.round((v * H * 0.42) / 14) * 14;   // 量化成块
    const x = i * bw;
    ctx.fillStyle = v > 0.75 ? MAGENTA : ACID;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x + 1, H - h, bw - 2, h);
    /* 顶部白色块帽 */
    if (h > 0) { ctx.fillStyle = PAPER; ctx.fillRect(x + 1, H - h - 5, bw - 2, 4); }
    /* 顶部镜像（淡） */
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = ACID;
    ctx.fillRect(x + 1, 0, bw - 2, h * 0.5);
  }
  ctx.globalAlpha = 1;
}

/* —— 模式 2：示波器 —— */
function drawScope(w) {
  const mid = H / 2;
  const amp = H * 0.36;
  ctx.lineWidth = 3;
  [[ACID, 0], [MAGENTA, 14]].forEach(([color, off], k) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = k === 0 ? 0.95 : 0.45;
    ctx.beginPath();
    for (let i = 0; i < w.length; i += 4) {
      const x = (i / w.length) * W;
      const y = mid + off + ((w[i] - 128) / 128) * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  /* 中轴参考线 */
  ctx.strokeStyle = "rgba(234,234,234,.12)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
}

/* —— 模式 3：粒子网格场 —— */
function drawGrid(f) {
  const gap = Math.max(34, W / 42);
  const cols = Math.ceil(W / gap), rows = Math.ceil(H / gap);
  const cx = W / 2, cy = H / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * gap + gap / 2, y = r * gap + gap / 2;
      const d = Math.hypot(x - cx, y - cy) / Math.hypot(cx, cy);
      const v = bin(f, Math.floor(d * 320) + 2) / 255;
      const s = 1.5 + v * gap * 0.62;
      ctx.fillStyle = v > 0.7 ? MAGENTA : v > 0.34 ? ACID : "rgba(234,234,234,.30)";
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }
}

function loop() {
  requestAnimationFrame(loop);
  frame++;
  /* 余晖拖尾 */
  ctx.fillStyle = "rgba(5,5,5,0.22)";
  ctx.fillRect(0, 0, W, H);

  const { f, w } = getData();
  switch (state.vizMode) {
    case 0: drawRadial(f); break;
    case 1: drawBars(f); break;
    case 2: drawScope(w); break;
    case 3: drawGrid(f); break;
  }

  /* 逐字歌词每帧填充，保证字级进度平滑（行级歌词亦只在行切换时重建） */
  if (currentTrack().type !== "synth" && lyric.on) lyric.sync(audio.currentTime);

  /* 每 6 帧更新一次电平表、进度与封面脉冲 */
  if (frame % 6 === 0) {
    const lvl = Math.round(energy(f, 0, 64) * 10);
    els.lvlBar.textContent = "█".repeat(lvl) + "░".repeat(10 - lvl);

    const tr = currentTrack();
    if (tr.type === "synth") {
      els.timeCur.textContent = fmt(synth.elapsed());
    } else {
      els.timeCur.textContent = fmt(audio.currentTime);
      if (isFinite(audio.duration) && audio.duration > 0) {
        setSeekUI(audio.currentTime / audio.duration);
        els.timeDur.textContent = fmt(audio.duration);
      }
    }
    /* 封面随低频脉冲 */
    if (!els.cover.hidden) {
      const bass = state.playing ? energy(f, 1, 24) : 0;
      els.cover.style.transform = `scale(${(1 + bass * 0.07).toFixed(3)})`;
    }
  }
}

/* ---------- 启动 ---------- */
setVolume(state.volume);
els.btnSpeed.textContent = SPEEDS[state.speedIdx][1];
els.btnQuality.textContent = QUALITIES[state.qualityIdx][1];
updateTrackUI();
renderQueue();
syncTransportUI();
updateMediaSession();
lyric.reset();
(async () => {
  await auth.init();
  await bootQueue();   // 已登录→每日推荐；未登录/失败→默认歌单
  /* 自检钩子（无头验证用）：#test-play-N 自动播放第 N 首；#test-panel-X 打开面板 tab */
  const m = location.hash.match(/^#test-play-(\d+)$/);
  if (m) loadTrack(+m[1]);
  const p = location.hash.match(/^#test-panel-(\w+)$/);
  if (p) library.open(p[1]);
})();
loop();
