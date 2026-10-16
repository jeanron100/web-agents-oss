// node --test server/resume-guard.test.mjs
//
// 续扫有效性判据 —— Claude / Codex / Kimi **共用同一份**。
//
// 为什么必须共用：本仓库有过「同一判据写多份、迟早漂移、然后某一份在最需要保守时 fail-open」
// 的教训（`deploy-agent.sh` 与 `restart.sh` 正是靠共用 `maintenance.js#restartBlockers` 才没出事）。
//
// ★ Codex 从「慢但对」改成「快」的过程中，最大的风险是变成「快但错」——
//   inode / truncate 判据是唯一防线。它一旦失守，症状不是报错，而是**数据静默错乱**：
//   offset 推到了别的文件世代上，事件与 token 全部错位，而界面看起来一切正常。
//
// 语义逐字取自 `agent.js` 原 Claude 侧实现（cachedScan 里的 canResume）：
//   hit?.state
//     && hit.state.generation === String(st.ino)
//     && st.size >= hit.size
//     && hit.state.offset <= st.size
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canResume, incrementalEnabled } from './resume-guard.js'

const ck = (over = {}) => ({ generation: '1001', fileSize: 5000, offset: 5000, ...over })
const st = (over = {}) => ({ ino: 1001, size: 5000, ...over })

test('同世代 + 只增长 + offset 合法 ⇒ 可续扫', () => {
  assert.equal(canResume(ck(), st({ size: 9000 })), true)
})

test('文件未变（size 相等）也可续扫——只是本轮读 0 字节', () => {
  assert.equal(canResume(ck(), st()), true)
})

test('checkpoint 缺失 ⇒ 不可续扫', () => {
  assert.equal(canResume(null, st()), false)
  assert.equal(canResume(undefined, st()), false)
})

test('★ inode 变了（文件被重建/替换）⇒ 不可续扫', () => {
  assert.equal(canResume(ck({ generation: '1001' }), st({ ino: 2002 })), false)
})

test('★ 文件缩小（truncate/重写）⇒ 不可续扫', () => {
  assert.equal(canResume(ck({ fileSize: 9000 }), st({ size: 5000 })), false)
})

test('★ offset 越过文件末尾 ⇒ 不可续扫', () => {
  assert.equal(canResume(ck({ offset: 9999 }), st({ size: 5000 })), false)
})

test('offset 恰好等于 size ⇒ 可续扫（边界，不是越界）', () => {
  assert.equal(canResume(ck({ offset: 5000 }), st({ size: 5000 })), true)
})

test('★ generation 用字符串比较——数字 inode 与字符串 inode 必须等价', () => {
  // 原实现是 `hit.state.generation === String(st.ino)`。若某处存成了数字，
  // 严格相等会永远为 false ⇒ **永远全量重扫**，而且完全静默（只是慢，没人报错）。
  assert.equal(canResume(ck({ generation: 1001 }), st({ ino: 1001 })), true, '数字 generation 也要认')
  assert.equal(canResume(ck({ generation: '1001' }), st({ ino: 1001 })), true)
})

test('缺 st 或字段不全 ⇒ 保守返回 false，不得抛', () => {
  assert.doesNotThrow(() => canResume(ck(), null))
  assert.equal(canResume(ck(), null), false)
  assert.equal(canResume(ck(), {}), false)
  assert.equal(canResume({}, st()), false)
})

test('★ 非有限数（NaN/Infinity）一律不可续扫', () => {
  // stat 失败或字段被污染时，NaN 参与比较全是 false，容易得出"某些条件成立"的错觉。
  // 这里显式要求：任何一个位置出现非有限数，都保守拒绝。
  assert.equal(canResume(ck({ offset: NaN }), st()), false)
  assert.equal(canResume(ck({ fileSize: NaN }), st()), false)
  assert.equal(canResume(ck(), st({ size: NaN })), false)
  assert.equal(canResume(ck({ offset: Infinity }), st({ size: Infinity })), false)
})

test('负数 offset ⇒ 不可续扫', () => {
  assert.equal(canResume(ck({ offset: -1 }), st()), false)
})

// ───────────────── 与原实现的等价性（防止重构时语义漂移） ─────────────────

test('★★ 与 agent.js 原内联判据逐例等价', () => {
  // 原式（逐字）：
  const original = (hit, s) => !!(hit?.state
    && hit.state.generation === String(s.ino)
    && s.size >= hit.size
    && hit.state.offset <= s.size)

  const cases = [
    [{ generation: '7', offset: 10 }, 20, { ino: 7, size: 30 }],
    [{ generation: '7', offset: 10 }, 20, { ino: 8, size: 30 }],   // inode 变
    [{ generation: '7', offset: 10 }, 20, { ino: 7, size: 10 }],   // 缩小
    [{ generation: '7', offset: 40 }, 20, { ino: 7, size: 30 }],   // offset 越界
    [{ generation: '7', offset: 30 }, 30, { ino: 7, size: 30 }],   // 恰好持平
    [{ generation: '7', offset: 0 },  0,  { ino: 7, size: 0 }],    // 空文件
  ]
  for (const [state, cachedSize, s] of cases) {
    const mine = canResume({ generation: state.generation, fileSize: cachedSize, offset: state.offset }, s)
    const theirs = original({ state, size: cachedSize }, s)
    assert.equal(mine, theirs, `不等价：state=${JSON.stringify(state)} cachedSize=${cachedSize} st=${JSON.stringify(s)}`)
  }
})

// ───────────── 运行时回退开关（spec 需求 8） ─────────────
//
// spec：「关键运行时开关 SHALL 存在，使异常时可通过改环境变量 + 重启回退，MUST NOT 需要回滚代码」
//
// 为什么这个开关必须在**判据这一层**而不是各调用点：判据是三侧共用的唯一真相源，
// 在这里关掉，Claude/Codex/Kimi 三条路径**一次性**全部退回全量扫描。
// 若分散在各调用点，回退时必然漏掉一处，而漏掉的那处不会报错——只是行为不一致。

test('★ 开关关闭时，一切 checkpoint 都判为不可续扫（整体退回全量）', () => {
  const good = { generation: '1001', fileSize: 5000, offset: 5000 }
  const st2 = { ino: 1001, size: 9000 }
  assert.equal(canResume(good, st2, { enabled: false }), false, '关掉后必须一律 false')
  assert.equal(canResume(good, st2, { enabled: true }), true, '打开时正常判定')
})

test('不传 enabled 时默认开启（向后兼容，现有调用点不受影响）', () => {
  assert.equal(canResume({ generation: '7', fileSize: 10, offset: 10 }, { ino: 7, size: 20 }), true)
})

test('★ 开关只影响"能否续扫"，不影响判据本身的正确性', () => {
  // 关掉开关不等于放宽判据——inode 变了在两种模式下都必须是 false。
  const bad = { generation: '1001', fileSize: 5000, offset: 5000 }
  const st = { ino: 2002, size: 9000 }
  assert.equal(canResume(bad, st, { enabled: true }), false)
  assert.equal(canResume(bad, st, { enabled: false }), false)
})

test('★ 环境变量读取：只有显式 "0" 才关闭（避免拼错就静默关掉）', () => {
  // 拼错成 WA_JSONL_INCREMENTAL=flase 时应当**保持开启**，而不是当成关闭。
  // 静默降级回全量扫描不会报错，只会慢——那正是最难发现的一类故障。
  const orig = process.env.WA_JSONL_INCREMENTAL
  try {
    for (const [v, want] of [['0', false], ['1', true], ['', true], ['flase', true], [undefined, true]]) {
      if (v === undefined) delete process.env.WA_JSONL_INCREMENTAL
      else process.env.WA_JSONL_INCREMENTAL = v
      assert.equal(incrementalEnabled(), want, `WA_JSONL_INCREMENTAL=${JSON.stringify(v)} 应为 ${want}`)
    }
  } finally {
    if (orig === undefined) delete process.env.WA_JSONL_INCREMENTAL
    else process.env.WA_JSONL_INCREMENTAL = orig
  }
})
