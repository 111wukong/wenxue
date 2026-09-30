/* 本地档案
 *
 * 只做一件事：把用户的学习痕迹存下来，并能算成一段**自然语言摘要**。
 *
 * ── 为什么这段摘要比模型本身重要 ─────────────────────────────────
 * 「AI 融入不够」的真正解药不是换个更强的模型，而是让提示词里带上
 * **用户此刻的真实状态**。只写「你是考研数学老师」的提示词，
 * 任何模型都只能讲通用内容；写「他罗尔定理错了 3 次、上次错在漏了可导性」，
 * 它才会针对性地讲。
 *
 * ── 为什么不引 localStorage 之外的任何东西 ───────────────────────
 * 零依赖是这项目的底线。Node 里没有 localStorage，所以这里做了
 * 内存兜底 —— 测试可以直接跑，不用先造一个 DOM。
 */

const KEY = 'wenxue.state.v1';

/* 内存兜底：Node（测试）和隐私模式下用它。 */
const memory = new Map();

function backend() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      // 探一下可用性：Safari 隐私模式会抛异常
      localStorage.setItem('__wx_probe', '1');
      localStorage.removeItem('__wx_probe');
      return {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
        del: (k) => localStorage.removeItem(k),
      };
    }
  } catch { /* 掉到内存兜底 */ }
  return {
    get: (k) => (memory.has(k) ? memory.get(k) : null),
    set: (k, v) => memory.set(k, v),
    del: (k) => memory.delete(k),
  };
}

function blank() {
  return {
    /* 每道题一条作答记录 */
    answers: [],
    /* 考点维度的掌握状态 */
    points: {},
    /* 上课记录（不含 awaiting —— 那个带 Promise，不能落盘） */
    classes: [],
    /* 用户自定义的偏好 */
    prefs: { rounds: 3, showProfile: true },
  };
}

let cache = null;

export function load() {
  if (cache) return cache;
  const be = backend();
  const raw = be.get(KEY);
  if (!raw) { cache = blank(); return cache; }
  try {
    const parsed = JSON.parse(raw);
    cache = { ...blank(), ...parsed };
    cache.prefs = { ...blank().prefs, ...(parsed.prefs || {}) };
  } catch {
    // 存档坏了不能让整个应用起不来 —— 重置比崩掉好
    cache = blank();
  }
  return cache;
}

export function save() {
  const be = backend();
  try { be.set(KEY, JSON.stringify(load())); } catch { /* 满了就算了，不影响当前会话 */ }
  return load();
}

export function reset() {
  cache = blank();
  backend().del(KEY);
  return cache;
}

/** 测试用：把内存后端清空。 */
export function _clearMemory() {
  memory.clear();
  cache = null;
}

/* ============================================================
   写档案
   ============================================================ */

/**
 * 记一次作答。
 * @param {{pointId:string, qid:string, answer:string, correct:boolean, source?:string}} rec
 */
export function recordAnswer(rec) {
  const st = load();
  st.answers.push({
    pointId: rec.pointId,
    qid: rec.qid,
    answer: String(rec.answer ?? ''),
    correct: !!rec.correct,
    source: rec.source || 'manual',
    at: rec.at || new Date().toISOString(),
  });
  // 只留最近 500 条，防止存档无限膨胀
  if (st.answers.length > 500) st.answers = st.answers.slice(-500);

  const p = st.points[rec.pointId] || (st.points[rec.pointId] = { seen: 0, wrong: 0, streak: 0, last: [] });
  p.seen += 1;
  if (!rec.correct) { p.wrong += 1; p.streak = 0; } else { p.streak = (p.streak || 0) + 1; }
  p.last = [...(p.last || []), rec.correct ? 1 : 0].slice(-8);
  p.at = new Date().toISOString();

  save();
  return st;
}

export function recordClass(rec) {
  const st = load();
  st.classes.push({ topic: rec.topic, mode: rec.mode, turns: rec.turns, at: new Date().toISOString() });
  if (st.classes.length > 50) st.classes = st.classes.slice(-50);
  save();
  return st;
}

export function setPref(k, v) {
  const st = load();
  st.prefs[k] = v;
  save();
  return st;
}

/* ============================================================
   读档案
   ============================================================ */

export function pointStat(pointId) {
  const st = load();
  return st.points[pointId] || { seen: 0, wrong: 0, streak: 0, last: [] };
}

/** 正确率 = 对 / 总。没做过返回 null —— 不要返回 0，0 会被误读成「全错」。 */
export function accuracy(pointId) {
  const s = pointStat(pointId);
  if (!s.seen) return null;
  return (s.seen - s.wrong) / s.seen;
}

/**
 * 薄弱的考点排序。
 * ★ 排序依据只有一条：错得多的排前面；错的次数相同再看正确率。
 *   这是纯数据操作 —— 挑考点这种事不该花一次模型调用。
 */
export function weakPoints(limit = 5) {
  const st = load();
  return Object.entries(st.points)
    .filter(([, s]) => s.wrong > 0)
    .map(([id, s]) => ({
      pointId: id,
      wrong: s.wrong,
      seen: s.seen,
      accuracy: (s.seen - s.wrong) / s.seen,
      last: s.last || [],
    }))
    .sort((a, b) => (b.wrong - a.wrong) || (a.accuracy - b.accuracy))
    .slice(0, limit);
}

/** 用户自己的错题（含他当时写的答案），老师 agent 会看到。 */
export function recentMistakes(limit = 5) {
  const st = load();
  return st.answers
    .filter((a) => !a.correct)
    .slice(-limit)
    .reverse()
    .map((a) => ({ pointId: a.pointId, qid: a.qid, answer: a.answer, at: a.at }));
}

/* ============================================================
   ★ 学习档案 → 自然语言摘要
   ============================================================
   这段文字会被塞进 system prompt。它必须**短**（几百字以内）且**具体**
   （带数字、带考点名）。写「该生基础薄弱」是没用的；
   写「罗尔定理正确率 33%，累计错 4 次，最近三次是错对错」才有用。
   ============================================================ */
export function learningProfile(pointId) {
  const st = load();
  const total = st.answers.length;
  const right = st.answers.filter((a) => a.correct).length;

  if (!total && !pointId) {
    return '【学习者档案】这是你们的第一次课，还没有任何作答记录。不要假定他学过什么，也不要假定他没学过——用第一个问题去探。';
  }

  const lines = ['【学习者档案】（以下数据来自他本机的真实作答记录，请据此调整难度，不要泛泛而谈）'];

  lines.push(`- 累计作答 ${total} 题，答对 ${right} 题，总正确率 ${total ? Math.round((right / total) * 100) : 0}%`);

  const weak = weakPoints(3);
  if (weak.length) {
    lines.push('- 最薄弱的考点：' + weak.map((w) =>
      `${pointName(w.pointId)}（正确率 ${Math.round(w.accuracy * 100)}%，累计错 ${w.wrong} 次）`).join('；'));
  } else if (total) {
    lines.push('- 目前没有反复出错的考点');
  }

  if (pointId) {
    const s = pointStat(pointId);
    if (s.seen) {
      const seq = (s.last || []).map((v) => (v ? '对' : '错')).join('');
      lines.push(`- 本考点历史：做过 ${s.seen} 题，错 ${s.wrong} 题，最近几次依次是 ${seq}`);
    } else {
      lines.push('- 本考点他还没有做过题');
    }
  }

  const mis = recentMistakes(3);
  if (mis.length) {
    lines.push('- 他最近答错的题（含他当时写的答案）：' + mis.map((m) =>
      `${pointName(m.pointId)} 他答「${String(m.answer).slice(0, 20)}」`).join('；'));
  }

  const cls = st.classes.slice(-3);
  if (cls.length) {
    lines.push('- 最近上过的课：' + cls.map((c) => c.topic).join('、'));
  }

  return lines.join('\n');
}

/* 局部引入避免循环依赖：curriculum 不依赖 store，所以直接 import 是安全的。 */
import { pointById } from './curriculum.js';

function pointName(id) {
  const p = pointById(id);
  return p ? p.name : id;
}

export { pointName };
