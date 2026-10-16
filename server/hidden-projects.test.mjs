// server/hidden-projects.test.mjs — 项目隐藏（= 不纳管）的判据。纯函数，无 I/O。
//
// 用户原话：「项目列表支持编辑和隐藏，有几个项目已经不需要显示了」「隐藏是不加入项目纳管」。
// ⇒ 隐藏**不是**前端少画一张卡片，而是**根本不扫、不解析、不进任何聚合**。
//
// ★ 为什么键是 `serverId/project` 而不是裸项目名：
//   同名项目可能同时存在于多台机器（5 台共用 /data 布局），只想清掉其中一台上的那份。
//   与既有的星标（store.ts `starKey = serverId/project`）同一套键空间，别再发明第二套。
//
// ★★ 失败方向刻意选**放行**（fail-open）：配置读不到 ⇒ 什么都不隐藏。
//   代价不对称——放行只是「隐藏的项目又冒出来了」（看得见、能再点一次）；
//   而反过来一旦探测失败就隐藏，用户的项目会**凭空消失且没有任何提示**。
//   ⚠️ 注意这与 session-reaper 的方向相反（那边读不到 cgroup 要保守跳过），
//   本仓库的纪律是**方向按代价定，不是抄一个模板**。

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHiddenParam, hiddenForServer, isHidden, normalizeEntries } from './hidden-projects.js'

test('hub 存的是 serverId/project，下发给某台 agent 时只给它自己那份裸项目名', () => {
  const entries = ['srv-178-232/invest_data', 'srv-178-232/old_crawler', 'srv-177-42/invest_data']
  assert.deepEqual(hiddenForServer(entries, 'srv-178-232'), ['invest_data', 'old_crawler'])
  assert.deepEqual(hiddenForServer(entries, 'srv-177-42'), ['invest_data'])
  assert.deepEqual(hiddenForServer(entries, 'srv-169-69'), [])
})

test('★ 同名项目在别的机器上不受影响 —— 隐藏必须是按机器的', () => {
  const only232 = hiddenForServer(['srv-178-232/daily_feedback'], 'srv-177-188')
  assert.deepEqual(only232, [], '只隐藏了 .232 上那份，.188 上的同名项目不能跟着消失')
})

test('线协议：逗号分隔，两端都要能往返', () => {
  const names = ['invest_data', 'old_crawler']
  assert.deepEqual(parseHiddenParam(names.join(',')), names)
  assert.deepEqual(parseHiddenParam('a, b ,, c '), ['a', 'b', 'c'], '容忍空格与空项')
})

test('★ 参数缺失/为空一律返回空 —— fail-open，配置传丢了不能让项目凭空消失', () => {
  for (const v of [undefined, null, '', '   ', ',,,']) {
    assert.deepEqual(parseHiddenParam(v), [], `${JSON.stringify(v)} 应放行`)
  }
})

test('isHidden 同时认静态排除表与动态隐藏表', () => {
  const stat = new Set(['claude_tmp_files'])
  assert.equal(isHidden('claude_tmp_files', stat, []), true, '既有的静态排除不能被弄丢')
  assert.equal(isHidden('invest_data', stat, ['invest_data']), true)
  assert.equal(isHidden('web_agents', stat, ['invest_data']), false)
  assert.equal(isHidden('', stat, ['']), false, '空项目名不算隐藏，否则会误伤取不到名字的会话')
})

test('★ 隐藏名单为空时 isHidden 必须退化成今天的行为', () => {
  const stat = new Set(['claude_tmp_files', 'docker'])
  assert.equal(isHidden('docker', stat, []), true)
  assert.equal(isHidden('web_agents', stat, []), false)
  assert.equal(isHidden('web_agents', stat, undefined), false, '未传参数也不能炸')
})

test('normalizeEntries：去重、去空、修掉缺 serverId 的脏项', () => {
  const got = normalizeEntries([
    'srv-178-232/a', 'srv-178-232/a', ' srv-178-232/b ', '', 'no-slash', 'srv-x/', '/only-proj', null, 42,
  ])
  assert.deepEqual(got, ['srv-178-232/a', 'srv-178-232/b'])
})

test('★ 项目名里含斜杠时只按第一个斜杠切 —— serverId 不含斜杠，项目名可能含', () => {
  assert.deepEqual(hiddenForServer(['srv-1/a/b'], 'srv-1'), ['a/b'])
})
