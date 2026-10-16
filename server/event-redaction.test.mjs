// node --test server/event-redaction.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactString, redactEvent } from './event-redaction.js'

test('redactString：Token 被脱敏', () => {
  assert.ok(!redactString('key sk-ABCD1234efgh5678ij').includes('ABCD1234'))
  assert.ok(!redactString('use ghp_ABCDEFGHIJ1234567890 now').includes('ABCDEFGHIJ1234567890'))
  assert.ok(!redactString('Authorization: Bearer eyJhbGciOi.abc.def').includes('eyJhbGciOi'))
})

test('redactString：Cookie 被脱敏', () => {
  const r = redactString('Cookie: wa_session=deadbeefsecret; other=1')
  assert.ok(!r.includes('deadbeefsecret'))
  assert.match(r, /Cookie: \*\*\*/)
})

test('redactString：密码/令牌 key=value 被脱敏', () => {
  assert.ok(!redactString('password=SuperSecret1').includes('SuperSecret1'))
  assert.ok(!redactString('api_key: "abc123xyz789"').includes('abc123xyz789'))
  assert.ok(!redactString('token = zzz-top-secret').includes('zzz-top-secret'))
})

test('redactString：连接串里的密码被脱敏', () => {
  assert.ok(!redactString('mongodb://wa:MyMongoPw@127.0.0.1:27018/db').includes('MyMongoPw'))
  assert.ok(!redactString('redis://:RedisPass@127.0.0.1:6379').includes('RedisPass'))
  assert.ok(!redactString('mysql://u:MyPw123@host:4306/d').includes('MyPw123'))
})

test('redactString：.env 风格整行被脱敏', () => {
  assert.ok(!redactString('BASIC_AUTH_PASS=hunter2plaintext').includes('hunter2plaintext'))
  assert.ok(!redactString('  MYSQL_USER_PASSWORD = abc').includes('abc'))
})

test('redactString：私钥块被抹掉', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfoo\nbar\n-----END RSA PRIVATE KEY-----'
  assert.ok(!redactString(pem).includes('MIIEfoo'))
})

test('redactEvent：禁用字段整段丢弃 + 其余字符串脱敏 + 标记 redacted', () => {
  const env = {
    eventKey: 'srv:claude:r:1', type: 'tool.used',
    payload: {
      verb: '执行命令', path: 'src/a.ts',
      command: 'curl -H "Authorization: Bearer secrettoken" x',  // 禁用字段名 → 整段丢
      stdout: '一大段终端输出',                                     // 禁用字段名 → 整段丢
      note: 'password=leakme123',                                 // 保留字段但内容要脱敏
    },
    privacy: { redacted: false, containsPrompt: false },
  }
  const out = redactEvent(env)
  assert.equal(out.privacy.redacted, true)
  assert.equal('command' in out.payload, false)   // 禁用字段丢弃
  assert.equal('stdout' in out.payload, false)
  assert.equal(out.payload.verb, '执行命令')       // 结构化字段保留
  assert.equal(out.payload.path, 'src/a.ts')
  assert.ok(!out.payload.note.includes('leakme123')) // 保留字段内容脱敏
  // 不改原对象
  assert.equal(env.privacy.redacted, false)
})

test('redactEvent：深层嵌套 + 数组里的密钥也被脱敏', () => {
  const out = redactEvent({ payload: { meta: { list: ['token=abc999xyz', 'ok'] } } })
  assert.ok(!JSON.stringify(out).includes('abc999xyz'))
})
