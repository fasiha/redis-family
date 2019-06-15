'use strict';
const family = require('./index');
const {spawn} = require('child_process');
const {tmpdir} = require('os');
const {join} = require('path');

const Redis = require('ioredis');

const test = require('tape');
const fetch = require('node-fetch');
const rm = require('rimraf');
const mkdirpSync = require('mkdirp').sync;
const kill = require('tree-kill');

const testUser = 'testuser';
const testToken = 'testtoken';

function sleep(ms) { return new Promise(resolve => {setTimeout(resolve, ms)}); }

function spawnRedisServer() {
  const dir = join(tmpdir(), Math.random().toString(36).slice(2));
  mkdirpSync(dir);
  console.log('# mkdirp ' + dir);
  const password = Math.random().toString(36) + Math.random().toString(36);
  const port = 11000 + Math.round(Math.random() * 5000);
  const server = spawn('redis-server',
                       ['/usr/local/etc/redis.conf', '--port', '' + port, '--requirepass', password, '--dir', dir]);
  console.log('# spawned ' + server.pid);
  // server.stdout.on('data', buf => console.log('#server> ' + buf.toString().replace(/\n/g, '\n#server> ')));
  const teardown = () => {
    server.kill();
    server.on('close', () => {
      // make sure you've created a NEW directory just for redis! It'd be bad if this deleted /tmp!
      rm(dir, e => {
        if (e) throw e;
      });
      console.log('# rimraf ' + dir);
    })
    console.log('# kill ' + server.pid);
  };
  return new Promise((resolve, reject) => {
    server.on('error', err => reject(err));
    server.stdout.on('data', data => resolve({teardown, password, port}));
  });
}

test('setup', async t => {
  const {password, teardown, port} = await spawnRedisServer();
  await sleep(300);
  const client = new Redis({password, port});

  const type = await client.type(Math.random().toString(13));
  t.equal('none', type, 'random key should not exist in fresh db');

  await client.quit()
  teardown();

  t.end();
});

test('basic', async t => {
  const {password, teardown, port: redisPort} = await spawnRedisServer();
  await sleep(300);
  const redisClient = new Redis({password, port: redisPort});

  const type = await redisClient.type(Math.random().toString(13));
  t.equal('none', type, 'random key should not exist in fresh db');

  const webport = 20000 + Math.round(Math.random() * 5000);
  const webserver = family.serve(redisClient, webport);
  t.ok(webserver, 'webserver came up');

  {
    const ok = await (fetch(`http://localhost:${webport}`).then(res => res.ok));
    t.ok(ok, 'get / ok');
  }

  const user = testUser;
  const app = 'life';
  const payload = 'hi';
  const method = 'POST';

  {
    const body = JSON.stringify({user, app, payload});
    const response = await fetch(`http://localhost:${webport}`, {method, body});
    const ok = await response.ok;
    t.notOk(ok, 'post / without any tokens set up fails');
    t.equal(response.status, 401, 'specifically, 401 unauthorized');
  }

  await redisClient.sadd(`tokens/${testUser}`, testToken);

  {
    const body = JSON.stringify({user, app, payload});
    const response = await fetch(`http://localhost:${webport}`, {method, body});
    t.equal(response.status, 401, 'still 401 after creating user token in Redis if headers not included');
  }

  const headers = {
    'X-Redis-Family-User': testUser,
    'X-Redis-Family-Token': testToken,
    'Content-Type': 'application/json'
  };

  {
    const body = JSON.stringify({user, app, payload});
    const response = await fetch(`http://localhost:${webport}`, {headers, method, body});
    const ok = await response.ok;
    t.ok(ok, 'now it works with headers');
  }

  {
    const body = JSON.stringify({user, app});
    const response = await fetch(`http://localhost:${webport}/since`, {method, body});
    const ok = await response.ok;
    t.notOk(ok, 'since without headers is not ok');
    t.equal(response.status, 401, 'specifically, 401 unauth');
  }

  {
    const body = JSON.stringify({user, app});
    const response = await fetch(`http://localhost:${webport}/since`, {headers, method, body});
    const ok = await response.ok;
    t.ok(ok, 'asking for since with headers');
    const contents = await response.json();
    const idRegexp = /^[0-9]+-[0-9]+$/;
    t.ok(contents.every(x => x instanceof Array && x.length === 2 && typeof x[0] === 'string' && idRegexp.test(x[0]) &&
                             x[1] instanceof Array && x[1][0] === 'payload'),
         'verify shape of since\'s reply');
    t.equal(contents.length, 1, 'only one item was inserted');
    for (const [id, kvs] of contents) {
      const map = new Map([kvs]);
      t.equal(map.size, 1, 'entry had only one field');
      t.equal(map.get('payload'), payload, 'field contents matches');
    }
  }

  // Teardown
  await redisClient.quit();
  teardown();

  webserver.close();
  t.end();
});
